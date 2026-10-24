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

export function click(bus: AudioNode, time: number, kind: ClickKind): void {
  const c = audioCtx();
  const osc = c.createOscillator();
  const env = c.createGain();
  const freq = kind === 'accent' ? 1760 : kind === 'beat' ? 1320 : 990;
  const peak = kind === 'accent' ? 0.9 : kind === 'beat' ? 0.6 : 0.25;
  osc.type = 'square';
  osc.frequency.value = freq;
  env.gain.setValueAtTime(0, time);
  env.gain.linearRampToValueAtTime(peak, time + 0.001);
  env.gain.exponentialRampToValueAtTime(0.001, time + 0.035);
  osc.connect(env).connect(bus);
  osc.start(time);
  osc.stop(time + 0.05);
}

/** A short tone used to demo the exercise ("Listen"); at the written pitch if there is one. */
export function tone(bus: AudioNode, time: number, hand: 'R' | 'L', durSec: number, midi?: number): void {
  const c = audioCtx();
  const osc = c.createOscillator();
  const env = c.createGain();
  osc.type = 'triangle';
  osc.frequency.value = midi !== undefined ? midiToFreq(midi) : hand === 'R' ? 784 : 262;
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
