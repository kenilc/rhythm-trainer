import { describe, expect, it } from 'vitest';
import {
  exerciseOnsets,
  generateExercise,
  measureQuarters,
  measuresToText,
  METERS,
  parseRhythm,
  splitMeasures,
} from './rhythm';
import { Session, STRICTNESS } from './scoring';

const m44 = { num: 4, den: 4 };

describe('parseRhythm / splitMeasures', () => {
  it('parses durations, dots, rests and ties', () => {
    const notes = parseRhythm('q. e | ~q hr');
    expect(notes.map((n) => n.dur)).toEqual([1.5, 0.5, 1, 2]);
    expect(notes[2].tie).toBe(true);
    expect(notes[3].rest).toBe(true);
  });

  it('splits by duration and round-trips to text', () => {
    const measures = splitMeasures(parseRhythm('q q e e q h. qr'), m44);
    expect(measures).toHaveLength(2);
    expect(measuresToText(measures)).toBe('q q e e q | h. qr');
  });

  it('rejects notes crossing the bar line and incomplete bars', () => {
    expect(() => splitMeasures(parseRhythm('h. h'), m44)).toThrow(/crosses the bar line/);
    expect(() => splitMeasures(parseRhythm('q q'), m44)).toThrow(/incomplete/);
  });

  it('rejects bad tokens and ties onto rests', () => {
    expect(() => parseRhythm('q x')).toThrow(/Unknown symbol/);
    expect(() => parseRhythm('qr ~q')).toThrow(/tie/);
  });

  it('cut time measures are 4 quarters long', () => {
    expect(measureQuarters({ num: 2, den: 2 })).toBe(4);
    expect(splitMeasures(parseRhythm('h h | w'), { num: 2, den: 2 })).toHaveLength(2);
  });
});

describe('exerciseOnsets', () => {
  it('skips rests and tied continuations', () => {
    const rh = splitMeasures(parseRhythm('q qr h | ~q q h'), m44);
    const onsets = exerciseOnsets({ meter: m44, rh, lh: null });
    expect(onsets.map((o) => o.q)).toEqual([0, 2, 5, 6]);
  });
});

describe('generateExercise', () => {
  it('always fills every bar exactly, for every meter and level', () => {
    for (const meter of METERS) {
      for (let level = 1; level <= 3; level++) {
        for (let i = 0; i < 30; i++) {
          const ex = generateExercise({ meter, bars: 4, level, twoHands: true, lhPattern: 'random' });
          for (const bar of [...ex.rh, ...ex.lh!]) {
            expect(bar.reduce((s, n) => s + n.dur, 0)).toBeCloseTo(measureQuarters(meter));
          }
          // Text round-trip must be parseable by the custom input.
          expect(() => splitMeasures(parseRhythm(measuresToText(ex.rh)), meter)).not.toThrow();
        }
      }
    }
  });
});

describe('Session', () => {
  const rh = splitMeasures(parseRhythm('q q q q'), m44);
  const onsets = exerciseOnsets({ meter: m44, rh, lh: null });
  const toTime = (q: number) => q * 0.5; // 120 BPM

  it('grades hits by offset and counts misses and extras', () => {
    const s = new Session(onsets, toTime, STRICTNESS.normal);
    expect(s.registerHit('R', 0.01, 'C4').grade).toBe('perfect');
    expect(s.registerHit('R', 0.5 - 0.04, 'C4').grade).toBe('good');
    expect(s.registerHit('R', 1.0 + 0.09, 'C4').grade).toBe('ok');
    expect(s.registerHit('R', 1.25, 'C4').grade).toBe('extra');
    s.sweepMisses(Infinity);
    const sum = s.summary();
    expect(sum).toMatchObject({ total: 4, perfect: 1, good: 1, ok: 1, missed: 1, extra: 1 });
    expect(sum.meanMs).toBeCloseTo((10 - 40 + 90) / 3);
  });

  it('does not let one note take two hits', () => {
    const s = new Session(onsets, toTime, STRICTNESS.normal);
    s.registerHit('R', 0, 'C4');
    expect(s.registerHit('R', 0.02, 'C4').grade).toBe('extra');
  });
});
