// Web Audio clock, click sounds and the free-running metronome.
// Everything is scheduled on the audio clock, never with timers, so clicks
// are sample-accurate.
import { midiToFreq } from './pitch';

export type ClickKind = 'accent' | 'beat' | 'sub';

let ctx: AudioContext | null = null;

export function audioCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext({ latencyHint: 'interactive' });
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

/**
 * Convert a performance.now() timestamp (used by MIDI and keyboard events)
 * to audio-clock time of what was *audible* at that moment. Uses
 * getOutputTimestamp so the browser-reported output latency is already
 * accounted for; calibration covers the rest.
 */
export function perfToAudio(perfMs: number): number {
  const c = audioCtx();
  const ts = c.getOutputTimestamp?.();
  if (ts && ts.performanceTime && ts.contextTime !== undefined) {
    return ts.contextTime + (perfMs - ts.performanceTime) / 1000;
  }
  return c.currentTime - (c.outputLatency || c.baseLatency || 0) - (performance.now() - perfMs) / 1000;
}

/** A gain bus for one run; disconnecting it silences everything scheduled on it. */
export function makeBus(volume = 1): GainNode {
  const c = audioCtx();
  const g = c.createGain();
  g.gain.value = volume;
  g.connect(c.destination);
  return g;
}

let clickVolume = 1;

/**
 * Loudness of every click (metronome, count-in, during exercises), 0–2.
 * The accent is already close to full scale, so above 1 the clicks also
 * ring longer, which is what makes them sound louder.
 */
export function setClickVolume(v: number): void {
  clickVolume = v;
}

export function click(bus: AudioNode, time: number, kind: ClickKind): void {
  if (clickVolume <= 0) return;
  const c = audioCtx();
  const osc = c.createOscillator();
  const env = c.createGain();
  const freq = kind === 'accent' ? 1760 : kind === 'beat' ? 1320 : 990;
  const peak = Math.min((kind === 'accent' ? 0.9 : kind === 'beat' ? 0.6 : 0.25) * clickVolume, 1);
  const len = 0.035 * Math.max(clickVolume, 1);
  osc.type = 'square';
  osc.frequency.value = freq;
  env.gain.setValueAtTime(0, time);
  env.gain.linearRampToValueAtTime(peak, time + 0.001);
  env.gain.exponentialRampToValueAtTime(0.001, time + len);
  osc.connect(env).connect(bus);
  osc.start(time);
  osc.stop(time + len + 0.015);
}

let noise: AudioBuffer | null = null;

/** Half a second of white noise, made once and shared by every drum hit. */
function noiseBuffer(c: AudioContext): AudioBuffer {
  if (!noise) {
    noise = c.createBuffer(1, Math.round(c.sampleRate * 0.5), c.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  return noise;
}

/** Snare: a band of noise for the rattle plus a short pitched body. */
function snare(bus: AudioNode, time: number): void {
  const c = audioCtx();
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c);
  const band = c.createBiquadFilter();
  band.type = 'highpass';
  band.frequency.value = 1200;
  const nEnv = c.createGain();
  nEnv.gain.setValueAtTime(0, time);
  nEnv.gain.linearRampToValueAtTime(0.7, time + 0.002);
  nEnv.gain.exponentialRampToValueAtTime(0.001, time + 0.18);
  src.connect(band).connect(nEnv).connect(bus);
  src.start(time);
  src.stop(time + 0.2);

  const body = c.createOscillator();
  const bEnv = c.createGain();
  body.type = 'triangle';
  body.frequency.setValueAtTime(220, time);
  body.frequency.exponentialRampToValueAtTime(160, time + 0.08);
  bEnv.gain.setValueAtTime(0, time);
  bEnv.gain.linearRampToValueAtTime(0.6, time + 0.002);
  bEnv.gain.exponentialRampToValueAtTime(0.001, time + 0.1);
  body.connect(bEnv).connect(bus);
  body.start(time);
  body.stop(time + 0.12);
}

/** Bass drum: a sine that drops quickly in pitch. */
function kick(bus: AudioNode, time: number): void {
  const c = audioCtx();
  const osc = c.createOscillator();
  const env = c.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(150, time);
  osc.frequency.exponentialRampToValueAtTime(45, time + 0.15);
  env.gain.setValueAtTime(0, time);
  env.gain.linearRampToValueAtTime(1, time + 0.003);
  env.gain.exponentialRampToValueAtTime(0.001, time + 0.3);
  osc.connect(env).connect(bus);
  osc.start(time);
  osc.stop(time + 0.32);
}

/** The drum for a hand: snare for the right, bass drum for the left. */
export function drum(bus: AudioNode, time: number, hand: 'R' | 'L'): void {
  (hand === 'R' ? snare : kick)(bus, time);
}

/**
 * A note used to demo the exercise ("Listen"): at the written pitch if
 * there is one, otherwise a drum (snare for the right hand, bass drum for
 * the left) so the hands are easy to tell apart.
 */
export function tone(bus: AudioNode, time: number, hand: 'R' | 'L', durSec: number, midi?: number): void {
  if (midi === undefined) {
    drum(bus, time, hand);
    return;
  }
  const c = audioCtx();
  const osc = c.createOscillator();
  const env = c.createGain();
  osc.type = 'triangle';
  osc.frequency.value = midiToFreq(midi);
  const len = Math.min(Math.max(durSec * 0.8, 0.06), 0.5);
  env.gain.setValueAtTime(0, time);
  env.gain.linearRampToValueAtTime(0.5, time + 0.004);
  env.gain.exponentialRampToValueAtTime(0.001, time + len);
  osc.connect(env).connect(bus);
  osc.start(time);
  osc.stop(time + len + 0.02);
}

/**
 * Free-running metronome using a look-ahead scheduler: a timer wakes up
 * often, but each click is placed exactly on the audio clock.
 */
export class Metronome {
  private timer: number | null = null;
  private bus: GainNode | null = null;
  private next = 0;
  private sub = 0;

  constructor(
    private getConfig: () => { beatSec: number; beatsPerBar: number; subdivide: boolean },
    private onBeat?: (beat: number, time: number) => void,
  ) {}

  get running(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.running) return;
    const c = audioCtx();
    this.bus = makeBus();
    this.next = c.currentTime + 0.1;
    this.sub = 0;
    this.timer = window.setInterval(() => this.tick(), 25);
    this.tick();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.bus?.disconnect();
    this.bus = null;
  }

  private tick(): void {
    const c = audioCtx();
    const { beatSec, beatsPerBar, subdivide } = this.getConfig();
    const step = subdivide ? beatSec / 2 : beatSec;
    const perBar = subdivide ? beatsPerBar * 2 : beatsPerBar;
    while (this.next < c.currentTime + 0.12) {
      const i = this.sub % perBar;
      const onBeat = !subdivide || i % 2 === 0;
      const kind: ClickKind = i === 0 ? 'accent' : onBeat ? 'beat' : 'sub';
      click(this.bus!, this.next, kind);
      if (onBeat) this.onBeat?.(subdivide ? i / 2 : i, this.next);
      this.next += step;
      this.sub++;
    }
  }
}
