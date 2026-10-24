// Pitches, keys and scale spelling.
// A pitch keeps its spelling (F♯ vs G♭) because notation needs it; the
// MIDI number is derived from it for comparing with what was played.

export type Step = 'c' | 'd' | 'e' | 'f' | 'g' | 'a' | 'b';

export interface Pitch {
  step: Step;
  /** −2…2: double flat … double sharp. */
  alter: number;
  /** Scientific octave: C4 is middle C. */
  octave: number;
}

export const STEPS: Step[] = ['c', 'd', 'e', 'f', 'g', 'a', 'b'];
const STEP_SEMITONES: Record<Step, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

export function midiOf(p: Pitch): number {
  return (p.octave + 1) * 12 + STEP_SEMITONES[p.step] + p.alter;
}

const ALTER_TEXT: Record<number, string> = { [-2]: 'bb', [-1]: 'b', 0: '', 1: '#', 2: '##' };
const ALTER_DISPLAY: Record<number, string> = { [-2]: '𝄫', [-1]: '♭', 0: '', 1: '♯', 2: '𝄪' };

/** Text form used in the rhythm syntax, e.g. "f#4", "bb3". */
export function pitchText(p: Pitch): string {
  return `${p.step}${ALTER_TEXT[p.alter]}${p.octave}`;
}

/** Display form, e.g. "F♯4". */
export function pitchName(p: Pitch): string {
  return `${p.step.toUpperCase()}${ALTER_DISPLAY[p.alter]}${p.octave}`;
}

/** VexFlow key, e.g. "f#/4". */
export function vfKey(p: Pitch): string {
  return `${p.step}${ALTER_TEXT[p.alter]}/${p.octave}`;
}

const PITCH = /^([a-g])(##|#|bb|b)?(-?\d)$/;

export function parsePitch(text: string): Pitch | null {
  const m = PITCH.exec(text.toLowerCase());
  if (!m) return null;
  const alter = { '##': 2, '#': 1, bb: -2, b: -1 }[m[2] ?? ''] ?? 0;
  return { step: m[1] as Step, alter, octave: Number(m[3]) };
}

/** Staff line as VexFlow counts it: 1 = bottom line, 5 = top line. */
export function staffLine(p: Pitch, clef: 'treble' | 'bass'): number {
  const diatonic = p.octave * 7 + STEPS.indexOf(p.step);
  const c4 = 4 * 7;
  return (diatonic - c4) / 2 + (clef === 'bass' ? 6 : 0);
}

// ---------------------------------------------------------------------------
// Keys

export interface KeyDef {
  /** VexFlow key spec, also the settings value: "G", "Bb", "Am". */
  id: string;
  label: string;
  tonic: { step: Step; alter: number };
  mode: 'major' | 'minor';
}

const key = (id: string, label: string, mode: 'major' | 'minor'): KeyDef => {
  const p = parsePitch(id.replace(/m$/, '').toLowerCase() + '4')!;
  return { id, label, tonic: { step: p.step, alter: p.alter }, mode };
};

export const KEYS: KeyDef[] = [
  key('C', 'C major', 'major'),
  key('G', 'G major', 'major'),
  key('D', 'D major', 'major'),
  key('A', 'A major', 'major'),
  key('E', 'E major', 'major'),
  key('F', 'F major', 'major'),
  key('Bb', 'B♭ major', 'major'),
  key('Eb', 'E♭ major', 'major'),
  key('Ab', 'A♭ major', 'major'),
  key('Am', 'A minor', 'minor'),
  key('Em', 'E minor', 'minor'),
  key('Bm', 'B minor', 'minor'),
  key('Dm', 'D minor', 'minor'),
  key('Gm', 'G minor', 'minor'),
  key('Cm', 'C minor', 'minor'),
];

export const keyById = (id: string): KeyDef => KEYS.find((k) => k.id === id) ?? KEYS[0];

const MODE_STEPS = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10] };

/** The seven scale degrees, correctly spelled (one letter each). */
export function scaleSpelling(k: KeyDef): { step: Step; alter: number }[] {
  const t = STEPS.indexOf(k.tonic.step);
  const tonicSemi = STEP_SEMITONES[k.tonic.step] + k.tonic.alter;
  return MODE_STEPS[k.mode].map((iv, i) => {
    const step = STEPS[(t + i) % 7];
    let alter = (tonicSemi + iv - STEP_SEMITONES[step]) % 12;
    if (alter > 6) alter -= 12;
    if (alter < -6) alter += 12;
    return { step, alter };
  });
}

/**
 * Pitch of a scale degree (0 = tonic, may go above 6 or below 0), with the
 * tonic in `tonicOctave`.
 */
export function scalePitch(k: KeyDef, degree: number, tonicOctave: number): Pitch {
  const spelled = scaleSpelling(k);
  const d = ((degree % 7) + 7) % 7;
  const { step, alter } = spelled[d];
  // The octave number changes between B and C, so count letters from C.
  const letters = STEPS.indexOf(k.tonic.step) + degree;
  return { step, alter, octave: tonicOctave + Math.floor(letters / 7) };
}

/** Spell a played MIDI note the way it would be written in this key. */
export function spellMidi(midi: number, k: KeyDef): Pitch {
  const pc = ((midi % 12) + 12) % 12;
  const octaveOf = (step: Step, alter: number) => Math.round((midi - STEP_SEMITONES[step] - alter) / 12) - 1;
  const inScale = scaleSpelling(k).find((s) => (STEP_SEMITONES[s.step] + s.alter + 12) % 12 === pc);
  if (inScale) return { ...inScale, octave: octaveOf(inScale.step, inScale.alter) };
  const flats = scaleSpelling(k).some((s) => s.alter < 0);
  const natural = STEPS.find((s) => STEP_SEMITONES[s] === pc);
  if (natural) return { step: natural, alter: 0, octave: octaveOf(natural, 0) };
  const step = flats ? STEPS.find((s) => STEP_SEMITONES[s] === pc + 1)! : STEPS.find((s) => STEP_SEMITONES[s] === pc - 1)!;
  const alter = flats ? -1 : 1;
  return { step, alter, octave: octaveOf(step, alter) };
}

export function midiToFreq(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}
