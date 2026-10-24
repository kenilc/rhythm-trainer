// Input sources: MIDI (primary) and the computer keyboard (fallback).
// Both report a raw event; the app decides which hand it belongs to.
// Keeping this behind one interface means an iPad bridge (e.g. a native
// CoreMIDI wrapper) can feed the same events later.

export interface RawHit {
  /** performance.now() timestamp of the event. */
  perf: number;
  source: 'midi' | 'key';
  /** MIDI note number, for MIDI hits. */
  note?: number;
  /** Hand hint from the keyboard layout. */
  keyHand?: 'L' | 'R';
  label: string;
}

const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

export function midiNoteName(n: number): string {
  return `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`;
}

const LH_KEYS = new Set(['KeyA', 'KeyS', 'KeyD', 'KeyF']);
const RH_KEYS = new Set(['KeyJ', 'KeyK', 'KeyL', 'Semicolon', 'Space']);

export type MidiStatus =
  | { state: 'unsupported' }
  | { state: 'denied'; message: string }
  | { state: 'ready'; inputs: string[] };

export class InputManager {
  private listeners = new Set<(h: RawHit) => void>();
  private access: MIDIAccess | null = null;

  constructor(private onMidiStatus: (s: MidiStatus) => void) {
    window.addEventListener('keydown', (e) => this.onKey(e));
  }

  onHit(fn: (h: RawHit) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(h: RawHit): void {
    for (const fn of this.listeners) fn(h);
  }

  private onKey(e: KeyboardEvent): void {
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    const keyHand = LH_KEYS.has(e.code) ? 'L' : RH_KEYS.has(e.code) ? 'R' : undefined;
    if (!keyHand) return;
    if (e.code === 'Space') e.preventDefault();
    this.emit({ perf: e.timeStamp, source: 'key', keyHand, label: e.code === 'Space' ? 'Space' : e.key.toUpperCase() });
  }

  async initMidi(): Promise<void> {
    if (!('requestMIDIAccess' in navigator)) {
      this.onMidiStatus({ state: 'unsupported' });
      return;
    }
    try {
      this.access = await navigator.requestMIDIAccess();
    } catch (err) {
      this.onMidiStatus({ state: 'denied', message: (err as Error).message || 'Permission denied' });
      return;
    }
    this.access.onstatechange = () => this.bindInputs();
    this.bindInputs();
  }

  private bindInputs(): void {
    if (!this.access) return;
    const names: string[] = [];
    this.access.inputs.forEach((input) => {
      input.onmidimessage = (e) => this.onMidi(e);
      if (input.state === 'connected') names.push(input.name || 'MIDI input');
    });
    this.onMidiStatus({ state: 'ready', inputs: names });
  }

  private onMidi(e: MIDIMessageEvent): void {
    const d = e.data;
    if (!d || d.length < 3) return;
    const cmd = d[0] & 0xf0;
    // Note-on with velocity > 0. Note-offs, pedal etc. are ignored.
    if (cmd !== 0x90 || d[2] === 0) return;
    this.emit({ perf: e.timeStamp, source: 'midi', note: d[1], label: midiNoteName(d[1]) });
  }
}
