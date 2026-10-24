// Match played hits against the expected onsets and grade them.
import type { Hand, Onset } from './rhythm';

export type Grade = 'perfect' | 'good' | 'ok' | 'poor';

export interface Thresholds {
  perfect: number;
  good: number;
  ok: number;
}

export const STRICTNESS: Record<string, Thresholds> = {
  strict: { perfect: 15, good: 35, ok: 70 },
  normal: { perfect: 25, good: 50, ok: 100 },
  relaxed: { perfect: 40, good: 80, ok: 150 },
};

export type Articulation = 'staccato' | 'detached' | 'legato' | 'long';

export const ARTICULATION_NAMES: Record<Articulation, string> = {
  staccato: 'staccato',
  detached: 'detached',
  legato: 'legato',
  long: 'held too long',
};

/**
 * Classify by held time ÷ written length. "Long" needs both a ratio and an
 * absolute margin, so a tiny overlap into the next note still counts as legato.
 */
export function articulationFor(heldSec: number, writtenSec: number): Articulation {
  const ratio = heldSec / writtenSec;
  if (ratio > 1.25 && heldSec - writtenSec > 0.12) return 'long';
  if (ratio >= 0.85) return 'legato';
  if (ratio >= 0.5) return 'detached';
  return 'staccato';
}

export interface Expected extends Onset {
  /** Audio-clock time in seconds. */
  time: number;
  /** Written length in seconds. */
  durSec: number;
  /** Repetition index in loop mode (0 for a single run). */
  rep: number;
  /** Half-width of the matching window in seconds. */
  window: number;
  hit?: HitRecord;
  missed?: boolean;
}

export interface HitRecord {
  hand: Hand;
  /** Audio-clock time in seconds, after latency compensation. */
  time: number;
  label: string;
  /** Signed error in ms; negative = early. Undefined for extra hits. */
  deltaMs?: number;
  grade: Grade | 'extra';
  expected?: Expected;
  /** Repetition this hit counts towards. */
  rep: number;
  /** MIDI note played, when known (MIDI input). */
  played?: number;
  /** On time for a note, but not the written pitch. Scores no points. */
  wrongNote?: boolean;
  /** Release time (audio clock, latency-compensated); undefined while held. */
  release?: number;
  /** Held time ÷ written length, for matched hits. */
  heldRatio?: number;
  articulation?: Articulation;
}

export function gradeFor(absMs: number, t: Thresholds): Grade {
  if (absMs <= t.perfect) return 'perfect';
  if (absMs <= t.good) return 'good';
  if (absMs <= t.ok) return 'ok';
  return 'poor';
}

const GRADE_POINTS: Record<Grade, number> = { perfect: 1, good: 0.8, ok: 0.5, poor: 0.2 };

/** Which hits and notes a summary covers: one repetition, several, or all. */
export type RepFilter = number | number[] | undefined;

const inReps = (rep: number, f: RepFilter) => f === undefined || (Array.isArray(f) ? f.includes(rep) : f === rep);

export class Session {
  readonly expected: Expected[] = [];
  readonly hits: HitRecord[] = [];

  constructor(
    onsets: Onset[],
    /** Converts an onset's quarter position to audio time. */
    toTime: (q: number) => number,
    readonly thresholds: Thresholds,
  ) {
    this.addOnsets(onsets, toTime, 0);
  }

  /** Add another repetition's notes (loop mode). */
  addOnsets(onsets: Onset[], toTime: (q: number) => number, rep: number): void {
    for (const o of onsets) {
      this.expected.push({ ...o, rep, time: toTime(o.q), durSec: toTime(o.q + o.durQ) - toTime(o.q), window: 0 });
    }
    this.expected.sort((a, b) => a.time - b.time);
    // Window: generous, but never more than ~half the gap to the previous
    // or next moment in the same hand, so each hit can only belong to one
    // note (or chord). This also holds across the seam between repetitions.
    const maxWin = (this.thresholds.ok * 1.5) / 1000;
    for (const hand of ['R', 'L'] as Hand[]) {
      // Tones of a chord share a moment; gaps are between distinct moments.
      const times = [...new Set(this.expected.filter((e) => e.hand === hand).map((e) => e.time))].sort((a, b) => a - b);
      const win = new Map(
        times.map((t, i) => {
          const gaps = [times[i - 1], times[i + 1]].filter((n) => n !== undefined).map((n) => Math.abs(n - t));
          return [t, gaps.length ? Math.min(maxWin, 0.49 * Math.min(...gaps)) : maxWin];
        }),
      );
      for (const e of this.expected) if (e.hand === hand) e.window = win.get(e.time)!;
    }
  }

  /**
   * The hand whose open note this key is, if exactly one hand is waiting for
   * it right now. Lets a right-hand chord dip below the split point.
   */
  handForKey(midi: number, time: number): Hand | undefined {
    const hands = new Set(
      this.expected.filter((e) => e.midi === midi && !e.hit && !e.missed && Math.abs(time - e.time) <= e.window).map((e) => e.hand),
    );
    return hands.size === 1 ? [...hands][0] : undefined;
  }

  /**
   * Match a hit to the nearest open note of that hand, preferring one with
   * the pitch played. `extraRep` is the repetition an unmatched hit is
   * charged to; `played` is the MIDI note, if known.
   */
  registerHit(hand: Hand, time: number, label: string, extraRep = 0, played?: number): HitRecord {
    const open = this.expected.filter((e) => e.hand === hand && !e.hit && !e.missed && Math.abs(time - e.time) <= e.window);
    // Nearest in time; between tones of the same chord, nearest in pitch, so
    // a wrong key takes the tone it most likely stands in for.
    const cost = (e: Expected) =>
      Math.abs(time - e.time) + (played !== undefined && e.midi !== undefined ? Math.abs(e.midi - played) * 1e-6 : 0);
    const nearest = (list: Expected[]) => list.reduce<Expected | undefined>((b, e) => (!b || cost(e) < cost(b) ? e : b), undefined);
    const best = (played !== undefined && nearest(open.filter((e) => e.midi === played))) || nearest(open);
    let rec: HitRecord;
    if (best) {
      const deltaMs = (time - best.time) * 1000;
      rec = { hand, time, label, deltaMs, grade: gradeFor(Math.abs(deltaMs), this.thresholds), expected: best, rep: best.rep };
      best.hit = rec;
    } else {
      rec = { hand, time, label, grade: 'extra', rep: extraRep };
    }
    if (played !== undefined) rec.played = played;
    if (best?.midi !== undefined && played !== undefined && best.midi !== played) rec.wrongNote = true;
    this.hits.push(rec);
    return rec;
  }

  registerRelease(rec: HitRecord, time: number): void {
    rec.release = Math.max(time, rec.time);
    if (!rec.expected) return;
    const held = rec.release - rec.time;
    rec.heldRatio = held / rec.expected.durSec;
    rec.articulation = articulationFor(held, rec.expected.durSec);
  }

  /** Mark expected onsets whose window has passed as missed. Returns the newly missed ones. */
  sweepMisses(now: number): Expected[] {
    const out: Expected[] = [];
    for (const e of this.expected) {
      if (!e.hit && !e.missed && now > e.time + e.window) {
        e.missed = true;
        out.push(e);
      }
    }
    return out;
  }

  private articulationSummary(matched: HitRecord[]): ArticulationSummary {
    const counts: Record<Articulation, number> = { staccato: 0, detached: 0, legato: 0, long: 0 };
    const released = matched.filter((h) => h.articulation);
    released.forEach((h) => counts[h.articulation!]++);
    const meanRatio = released.length ? released.reduce((s, h) => s + h.heldRatio!, 0) / released.length : 0;
    return { counts, meanRatio, measured: released.length };
  }

  summary(hand?: Hand, reps?: RepFilter): Summary {
    const exp = this.expected.filter((e) => (!hand || e.hand === hand) && inReps(e.rep, reps));
    const hits = this.hits.filter((h) => (!hand || h.hand === hand) && inReps(h.rep, reps));
    const matched = hits.filter((h) => h.grade !== 'extra');
    const deltas = matched.map((h) => h.deltaMs!);
    const mean = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;
    const sd = deltas.length > 1 ? Math.sqrt(deltas.reduce((a, b) => a + (b - mean) ** 2, 0) / (deltas.length - 1)) : 0;
    const count = (g: Grade) => matched.filter((h) => h.grade === g).length;
    const points = matched.reduce((s, h) => s + (h.wrongNote ? 0 : GRADE_POINTS[h.grade as Grade]), 0);
    const extra = hits.length - matched.length;
    return {
      total: exp.length,
      perfect: count('perfect'),
      good: count('good'),
      ok: count('ok'),
      poor: count('poor'),
      missed: exp.filter((e) => !e.hit).length,
      wrongNotes: matched.filter((h) => h.wrongNote).length,
      chordSpreadMs: chordSpread(exp),
      extra,
      meanMs: mean,
      sdMs: sd,
      articulation: this.articulationSummary(matched),
      // Extra hits cost half a note each so mashing keys doesn't pay off.
      score: exp.length ? Math.max(0, (points - extra * 0.5) / exp.length) : 0,
    };
  }
}

/** Expected tones grouped into the notes they belong to (a chord is one group). */
export function noteGroups(expected: Expected[]): Expected[][] {
  const groups = new Map<string, Expected[]>();
  for (const e of expected) {
    const k = `${e.rep}:${e.hand}:${e.measure}:${e.index}`;
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  return [...groups.values()];
}

/** ms between the first and last key played for one chord; undefined below 2 keys. */
export function spreadOf(group: Expected[]): number | undefined {
  const times = group.filter((e) => e.hit).map((e) => e.hit!.time);
  return times.length > 1 ? (Math.max(...times) - Math.min(...times)) * 1000 : undefined;
}

function chordSpread(expected: Expected[]): number | undefined {
  const spreads = noteGroups(expected)
    .filter((g) => g.length > 1)
    .map(spreadOf)
    .filter((v): v is number => v !== undefined);
  return spreads.length ? spreads.reduce((a, b) => a + b, 0) / spreads.length : undefined;
}

export interface ArticulationSummary {
  counts: Record<Articulation, number>;
  /** Mean held time ÷ written length over released notes. */
  meanRatio: number;
  measured: number;
}

export interface Summary {
  total: number;
  perfect: number;
  good: number;
  ok: number;
  poor: number;
  missed: number;
  extra: number;
  wrongNotes: number;
  /** Average ms between the first and last key of chords, if any chord had 2+ keys played. */
  chordSpreadMs?: number;
  meanMs: number;
  sdMs: number;
  score: number;
  articulation: ArticulationSummary;
}
