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

export class Session {
  readonly expected: Expected[];
  readonly hits: HitRecord[] = [];

  constructor(
    onsets: Onset[],
    /** Converts an onset's quarter position to audio time. */
    toTime: (q: number) => number,
    readonly thresholds: Thresholds,
  ) {
    this.expected = onsets.map((o) => ({ ...o, time: toTime(o.q), durSec: toTime(o.q + o.durQ) - toTime(o.q), window: 0 }));
    // Window: generous, but never more than ~half the gap to a neighbouring
    // onset in the same hand, so each hit can only belong to one note.
    for (const hand of ['R', 'L'] as Hand[]) {
      const list = this.expected.filter((e) => e.hand === hand);
      list.forEach((e, i) => {
        const gaps = [list[i - 1], list[i + 1]].filter(Boolean).map((n) => Math.abs(n!.time - e.time));
        const maxWin = (thresholds.ok * 1.5) / 1000;
        e.window = gaps.length ? Math.min(maxWin, 0.49 * Math.min(...gaps)) : maxWin;
      });
    }
  }

  registerHit(hand: Hand, time: number, label: string): HitRecord {
    let best: Expected | undefined;
    for (const e of this.expected) {
      if (e.hand !== hand || e.hit || e.missed) continue;
      const d = Math.abs(time - e.time);
      if (d <= e.window && (!best || d < Math.abs(time - best.time))) best = e;
    }
    let rec: HitRecord;
    if (best) {
      const deltaMs = (time - best.time) * 1000;
      rec = { hand, time, label, deltaMs, grade: gradeFor(Math.abs(deltaMs), this.thresholds), expected: best };
      best.hit = rec;
    } else {
      rec = { hand, time, label, grade: 'extra' };
    }
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

  summary(hand?: Hand): Summary {
    const exp = this.expected.filter((e) => !hand || e.hand === hand);
    const hits = this.hits.filter((h) => !hand || h.hand === hand);
    const matched = hits.filter((h) => h.grade !== 'extra');
    const deltas = matched.map((h) => h.deltaMs!);
    const mean = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;
    const sd = deltas.length > 1 ? Math.sqrt(deltas.reduce((a, b) => a + (b - mean) ** 2, 0) / (deltas.length - 1)) : 0;
    const count = (g: Grade) => matched.filter((h) => h.grade === g).length;
    const points = matched.reduce((s, h) => s + GRADE_POINTS[h.grade as Grade], 0);
    const extra = hits.length - matched.length;
    return {
      total: exp.length,
      perfect: count('perfect'),
      good: count('good'),
      ok: count('ok'),
      poor: count('poor'),
      missed: exp.filter((e) => !e.hit).length,
      extra,
      meanMs: mean,
      sdMs: sd,
      articulation: this.articulationSummary(matched),
      // Extra hits cost half a note each so mashing keys doesn't pay off.
      score: exp.length ? Math.max(0, (points - extra * 0.5) / exp.length) : 0,
    };
  }
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
  meanMs: number;
  sdMs: number;
  score: number;
  articulation: ArticulationSummary;
}
