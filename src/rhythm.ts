// Rhythm model, text parser and random generator.
// Durations are measured in quarter notes ("q" = 1).

export type Base = 'w' | 'h' | 'q' | 'e' | 's';

export interface RNote {
  base: Base;
  dotted: boolean;
  rest: boolean;
  /** Tied from the previous note: sounds as a continuation, no new onset. */
  tie: boolean;
  dur: number;
}

export interface Meter {
  num: number;
  den: number;
}

export type Hand = 'R' | 'L';

export interface Exercise {
  meter: Meter;
  /** Notes per hand, split into measures. LH is null in one-hand mode. */
  rh: RNote[][];
  lh: RNote[][] | null;
}

export interface Onset {
  hand: Hand;
  /** Start time in quarter notes from the start of the exercise. */
  q: number;
  measure: number;
  index: number;
}

const BASE_DUR: Record<Base, number> = { w: 4, h: 2, q: 1, e: 0.5, s: 0.25 };

export const METERS: Meter[] = [
  { num: 2, den: 2 },
  { num: 2, den: 4 },
  { num: 3, den: 4 },
  { num: 4, den: 4 },
];

export function measureQuarters(m: Meter): number {
  return (m.num * 4) / m.den;
}

/** Quarter notes per metronome beat (a half note in 2/2). */
export function beatQuarters(m: Meter): number {
  return 4 / m.den;
}

export function makeNote(base: Base, dotted = false, rest = false, tie = false): RNote {
  return { base, dotted, rest, tie, dur: BASE_DUR[base] * (dotted ? 1.5 : 1) };
}

const TOKEN = /^(~)?([whqes])(\.)?(r)?$/;

/**
 * Parse text like `q q e e q | h. qr | ~q h e e`.
 *   w h q e s  = whole, half, quarter, eighth, sixteenth
 *   .          = dotted (suffix)
 *   r          = rest (suffix)
 *   ~          = tied from the previous note (prefix)
 *   |          = optional bar line (ignored; measures are split by duration)
 */
export function parseRhythm(text: string): RNote[] {
  const tokens = text.split(/[\s|]+/).filter(Boolean);
  const notes: RNote[] = [];
  for (const tok of tokens) {
    const m = TOKEN.exec(tok.toLowerCase());
    if (!m) throw new Error(`Unknown symbol "${tok}". Use w h q e s, "." for dotted, "r" for rest, "~" for tie.`);
    const [, tie, base, dot, rest] = m;
    if (tie && rest) throw new Error(`"${tok}": a rest can't be tied.`);
    if (tie) {
      const prev = notes[notes.length - 1];
      if (!prev || prev.rest) throw new Error(`"${tok}": a tie needs a note before it.`);
    }
    notes.push(makeNote(base as Base, !!dot, !!rest, !!tie));
  }
  if (notes.length === 0) throw new Error('The rhythm is empty.');
  return notes;
}

/** Split a flat note list into measures. Throws if a note crosses a bar line. */
export function splitMeasures(notes: RNote[], meter: Meter): RNote[][] {
  const len = measureQuarters(meter);
  const measures: RNote[][] = [];
  let cur: RNote[] = [];
  let pos = 0;
  for (const n of notes) {
    if (pos + n.dur > len + 1e-9) {
      throw new Error(
        `Measure ${measures.length + 1} overflows: a note crosses the bar line. Use a tie (~) to continue into the next bar.`,
      );
    }
    cur.push(n);
    pos += n.dur;
    if (Math.abs(pos - len) < 1e-9) {
      measures.push(cur);
      cur = [];
      pos = 0;
    }
  }
  if (cur.length) {
    const missing = len - pos;
    throw new Error(`The last measure is incomplete (${fmtQuarters(missing)} missing).`);
  }
  return measures;
}

function fmtQuarters(q: number): string {
  return q === 1 ? '1 beat (quarter)' : `${q} quarter${q === 1 ? '' : 's'}`;
}

export function noteToText(n: RNote): string {
  return `${n.tie ? '~' : ''}${n.base}${n.dotted ? '.' : ''}${n.rest ? 'r' : ''}`;
}

export function measuresToText(measures: RNote[][]): string {
  return measures.map((m) => m.map(noteToText).join(' ')).join(' | ');
}

export function exerciseOnsets(ex: Exercise): Onset[] {
  const out: Onset[] = [];
  const mq = measureQuarters(ex.meter);
  const add = (hand: Hand, measures: RNote[][]) => {
    measures.forEach((notes, mi) => {
      let pos = mi * mq;
      notes.forEach((n, ni) => {
        if (!n.rest && !n.tie) out.push({ hand, q: pos, measure: mi, index: ni });
        pos += n.dur;
      });
    });
  };
  add('R', ex.rh);
  if (ex.lh) add('L', ex.lh);
  return out.sort((a, b) => a.q - b.q);
}

export function totalQuarters(ex: Exercise): number {
  return ex.rh.length * measureQuarters(ex.meter);
}

// ---------------------------------------------------------------------------
// Random generator

interface Cell {
  text: string;
  len: number;
  /** Allowed start positions must be multiples of this (in 4-quarter bars). */
  align: number;
  weight: number;
  level: number;
  /** Only allowed at the start of a bar of this exact length. */
  wholeBar?: number;
}

const CELLS: Cell[] = [
  { text: 'q', len: 1, align: 1, weight: 5, level: 1 },
  { text: 'h', len: 2, align: 2, weight: 3, level: 1 },
  { text: 'qr', len: 1, align: 1, weight: 1, level: 1 },
  { text: 'w', len: 4, align: 4, weight: 1, level: 1, wholeBar: 4 },
  { text: 'h.', len: 3, align: 4, weight: 1, level: 1 },
  { text: 'e e', len: 1, align: 1, weight: 5, level: 2 },
  { text: 'q. e', len: 2, align: 2, weight: 3, level: 3 },
  { text: 'er e', len: 1, align: 1, weight: 2, level: 3 },
  { text: 'e er', len: 1, align: 1, weight: 1, level: 3 },
  { text: 'q ~e e', len: 2, align: 2, weight: 1, level: 3 },
];

export const MAX_LEVEL = 3;

export const LEVEL_NAMES: Record<number, string> = {
  1: 'Level 1: whole, half, quarter, quarter rest',
  2: 'Level 2: + eighth pairs',
  3: 'Level 3: + dotted quarter, eighth rests, ties',
};

export type LhPattern = 'steady' | 'strong' | 'bar' | 'random';

export const LH_PATTERN_NAMES: Record<LhPattern, string> = {
  steady: 'Steady beat',
  strong: 'Strong beats only',
  bar: 'One note per bar',
  random: 'Random (same level)',
};

type Rng = () => number;

function pickWeighted<T extends { weight: number }>(items: T[], rng: Rng): T {
  const total = items.reduce((s, c) => s + c.weight, 0);
  let r = rng() * total;
  for (const c of items) {
    r -= c.weight;
    if (r <= 0) return c;
  }
  return items[items.length - 1];
}

function generateMeasure(meter: Meter, level: number, rng: Rng): RNote[] {
  const len = measureQuarters(meter);
  for (let attempt = 0; attempt < 50; attempt++) {
    const notes: RNote[] = [];
    let pos = 0;
    while (pos < len - 1e-9) {
      const remaining = len - pos;
      const options = CELLS.filter((c) => {
        if (c.level > level || c.len > remaining + 1e-9) return false;
        if (c.wholeBar !== undefined) return pos === 0 && len === c.wholeBar;
        // Alignment keeps longer values on strong beats in 2/2, 2/4 and 4/4.
        if (len !== 3 && pos % c.align !== 0) return false;
        if (len === 3 && c.align === 4 && pos !== 0) return false;
        return true;
      });
      // Favour the newest material of the chosen level a little.
      const weighted = options.map((c) => ({ ...c, weight: c.weight * (c.level === level ? 1.5 : 1) }));
      const cell = pickWeighted(weighted, rng);
      notes.push(...parseRhythm(cell.text));
      pos += cell.len;
    }
    const sounding = notes.filter((n) => !n.rest).length;
    if (sounding > 0 && !(notes.length === 1 && level > 1)) return notes;
  }
  return parseRhythm('q '.repeat(len).trim());
}

function lhMeasure(meter: Meter, pattern: LhPattern, level: number, rng: Rng): RNote[] {
  const key = `${meter.num}/${meter.den}`;
  switch (pattern) {
    case 'steady':
      return parseRhythm(meter.den === 2 ? 'h '.repeat(meter.num) : 'q '.repeat(meter.num));
    case 'strong':
      return parseRhythm({ '2/2': 'w', '2/4': 'h', '3/4': 'h.', '4/4': 'h h' }[key] ?? 'q');
    case 'bar':
      return parseRhythm({ '2/2': 'w', '2/4': 'h', '3/4': 'h.', '4/4': 'w' }[key] ?? 'q');
    case 'random':
      return generateMeasure(meter, Math.max(1, level - 1), rng);
  }
}

export interface GenerateOptions {
  meter: Meter;
  bars: number;
  level: number;
  twoHands: boolean;
  lhPattern: LhPattern;
  rng?: Rng;
}

export function generateExercise(o: GenerateOptions): Exercise {
  const rng = o.rng ?? Math.random;
  const rh: RNote[][] = [];
  const lh: RNote[][] = [];
  for (let i = 0; i < o.bars; i++) {
    rh.push(generateMeasure(o.meter, o.level, rng));
    if (o.twoHands) lh.push(lhMeasure(o.meter, o.lhPattern, o.level, rng));
  }
  return { meter: o.meter, rh, lh: o.twoHands ? lh : null };
}
