import { describe, expect, it } from 'vitest';
import { keyById, midiOf, parsePitch, pitchName, pitchText, scalePitch, scaleSpelling, spellMidi, staffLine } from './pitch';
import { exerciseOnsets, generateExercise, measuresToText, parseRhythm, splitMeasures } from './rhythm';
import { Session, spreadOf, STRICTNESS } from './scoring';

const m44 = { num: 4, den: 4 };
const names = (k: string) => scaleSpelling(keyById(k)).map((s) => pitchName({ ...s, octave: 4 }).replace('4', ''));

describe('pitches', () => {
  it('parses and converts to MIDI', () => {
    expect(midiOf(parsePitch('c4')!)).toBe(60);
    expect(midiOf(parsePitch('a4')!)).toBe(69);
    expect(midiOf(parsePitch('f#4')!)).toBe(66);
    expect(midiOf(parsePitch('bb3')!)).toBe(58);
    expect(midiOf(parsePitch('b#3')!)).toBe(60);
    expect(parsePitch('h4')).toBeNull();
    expect(pitchText(parsePitch('Eb5')!)).toBe('eb5');
  });

  it('spells scales with one letter per degree', () => {
    expect(names('G')).toEqual(['G', 'A', 'B', 'C', 'D', 'E', 'F♯']);
    expect(names('Eb')).toEqual(['E♭', 'F', 'G', 'A♭', 'B♭', 'C', 'D']);
    expect(names('Bm')).toEqual(['B', 'C♯', 'D', 'E', 'F♯', 'G', 'A']);
    expect(names('Gm')).toEqual(['G', 'A', 'B♭', 'C', 'D', 'E♭', 'F']);
  });

  it('changes octave between B and C', () => {
    const g = keyById('G');
    expect(pitchName(scalePitch(g, 0, 4))).toBe('G4');
    expect(pitchName(scalePitch(g, 3, 4))).toBe('C5');
    expect(pitchName(scalePitch(g, -1, 4))).toBe('F♯4');
  });

  it('spells played notes to suit the key', () => {
    expect(pitchName(spellMidi(66, keyById('G')))).toBe('F♯4');
    expect(pitchName(spellMidi(70, keyById('F')))).toBe('B♭4');
    expect(pitchName(spellMidi(61, keyById('F')))).toBe('D♭4'); // flat key, out of scale
    expect(pitchName(spellMidi(61, keyById('D')))).toBe('C♯4');
    expect(pitchName(spellMidi(71, keyById('F')))).toBe('B4');
  });

  it('places notes on VexFlow staff lines', () => {
    expect(staffLine(parsePitch('e4')!, 'treble')).toBe(1);
    expect(staffLine(parsePitch('f5')!, 'treble')).toBe(5);
    expect(staffLine(parsePitch('c4')!, 'treble')).toBe(0);
    expect(staffLine(parsePitch('g2')!, 'bass')).toBe(1);
    expect(staffLine(parsePitch('c4')!, 'bass')).toBe(6);
  });
});

describe('pitched rhythms', () => {
  it('parses pitches, round-trips and lets ties inherit the pitch', () => {
    const notes = parseRhythm('c4/q d4/e. f#4/s g4/h | ~q qr bb3/h');
    expect(notes[4].pitches?.map(midiOf)).toEqual([67]);
    const measures = splitMeasures(notes, m44);
    expect(measuresToText(measures)).toBe('c4/q d4/e. f#4/s g4/h | ~g4/q qr bb3/h');
    const onsets = exerciseOnsets({ meter: m44, key: 'C', rh: measures, lh: null });
    expect(onsets.map((o) => o.midi)).toEqual([60, 62, 66, 67, 58]);
  });

  it('rejects mixed, bad and mis-tied pitches', () => {
    expect(() => parseRhythm('c4/q q')).toThrow(/every note a pitch/);
    expect(() => parseRhythm('x4/q')).toThrow(/isn't a pitch/);
    expect(() => parseRhythm('c4/q ~d4/q')).toThrow(/same pitch/);
    expect(() => parseRhythm('c4/qr')).toThrow(/rest has no pitch/);
  });

  it('generates five-finger notes in the key, ending on the tonic', () => {
    for (const key of ['C', 'G', 'F', 'Bb', 'Am']) {
      for (let i = 0; i < 20; i++) {
        const ex = generateExercise({ meter: m44, key, notes: 'five', bars: 4, level: 3, twoHands: true, lhPattern: 'random' });
        const k = keyById(key);
        const allowed = (oct: number) => [0, 1, 2, 3, 4].map((d) => midiOf(scalePitch(k, d, oct)));
        const check = (measures: typeof ex.rh, oct: number) => {
          const onsets = exerciseOnsets({ ...ex, rh: measures, lh: null });
          onsets.forEach((o) => expect(allowed(oct)).toContain(o.midi));
          expect(onsets[onsets.length - 1].midi).toBe(allowed(oct)[0]);
        };
        check(ex.rh, 4);
        // Of these keys only C's tonic is low enough to keep the left hand in octave 3.
        check(ex.lh!, key === 'C' ? 3 : 2);
        // Generated text must parse back.
        expect(() => splitMeasures(parseRhythm(measuresToText(ex.rh)), m44)).not.toThrow();
      }
    }
  });
});

describe('chords', () => {
  it('parses chords with spaces or commas, sorts them and round-trips', () => {
    const notes = parseRhythm('(g4 c4 e4)/h (d4,f#4)/e | ~(d4 f#4)/e ~q');
    expect(notes[0].pitches?.map(midiOf)).toEqual([60, 64, 67]);
    expect(notes[1].pitches?.map(midiOf)).toEqual([62, 66]);
    expect(notes[3].pitches?.map(midiOf)).toEqual([62, 66]); // ~q inherits the chord
    expect(measuresToText([notes])).toBe('(c4 e4 g4)/h (d4 f#4)/e ~(d4 f#4)/e ~(d4 f#4)/q');
    expect(parseRhythm('(c4 e4)/q|d4/q')).toHaveLength(2); // bar line right after a chord
  });

  it('rejects bad chords', () => {
    expect(() => parseRhythm('(c4 c4)/q')).toThrow(/twice/);
    expect(() => parseRhythm('(c4 x9)/q')).toThrow(/isn't a pitch/);
    expect(() => parseRhythm('(c4 e4)/q ~(c4 f4)/q')).toThrow(/same pitches/);
  });

  // (C E G) then (D F A), quarters at 120 BPM.
  const rh = splitMeasures(parseRhythm('(c4 e4 g4)/q (d4 f4 a4)/q (c4 e4 g4)/h'), m44);
  const onsets = exerciseOnsets({ meter: m44, key: 'C', rh, lh: null });
  const toTime = (q: number) => q * 0.5;

  it('has one onset per chord tone', () => {
    expect(onsets).toHaveLength(9);
    expect(onsets.filter((o) => o.q === 0).map((o) => o.tone)).toEqual([0, 1, 2]);
  });

  it('matches each key to its own tone and measures the spread', () => {
    const s = new Session(onsets, toTime, STRICTNESS.normal);
    [
      [60, 0.0],
      [67, 0.012],
      [64, 0.03],
    ].forEach(([m, t]) => expect(s.registerHit('R', t, 'k', 0, m).wrongNote).toBeUndefined());
    expect(s.expected.filter((e) => e.q === 0).every((e) => e.hit)).toBe(true);
    expect(spreadOf(s.expected.filter((e) => e.q === 0))).toBeCloseTo(30);
  });

  it('lets a wrong key take the nearest tone in pitch, whatever the order', () => {
    const s = new Session(onsets, toTime, STRICTNESS.normal);
    const a = s.registerHit('R', 0, 'A4', 0, 69); // wrong key first
    s.registerHit('R', 0.01, 'C4', 0, 60);
    s.registerHit('R', 0.01, 'E4', 0, 64);
    expect(a.wrongNote).toBe(true);
    expect(a.expected?.midi).toBe(67); // stood in for G, not C
    const first = s.expected.filter((e) => e.q === 0);
    expect(first.filter((e) => e.hit?.wrongNote).map((e) => e.midi)).toEqual([67]);
  });

  it('gives repeated chords their own windows and reports average spread', () => {
    const s = new Session(onsets, toTime, STRICTNESS.normal);
    // Second chord played 40 ms late, spread 20 ms: must not land on the first chord.
    s.registerHit('R', 0.54, 'D4', 0, 62);
    s.registerHit('R', 0.55, 'F4', 0, 65);
    s.registerHit('R', 0.56, 'A4', 0, 69);
    expect(s.expected.filter((e) => e.q === 1).every((e) => e.hit)).toBe(true);
    s.sweepMisses(Infinity);
    expect(s.summary().chordSpreadMs).toBeCloseTo(20);
  });

  it('works out the hand from the key when a part dips past the split', () => {
    const both = exerciseOnsets({
      meter: m44,
      key: 'C',
      rh: splitMeasures(parseRhythm('(b3 d4 g4)/w'), m44),
      lh: splitMeasures(parseRhythm('g2/w'), m44),
    });
    const s = new Session(both, toTime, STRICTNESS.normal);
    expect(s.handForKey(59, 0)).toBe('R'); // B3 is below middle C but written for the right hand
    expect(s.handForKey(43, 0)).toBe('L');
    expect(s.handForKey(50, 0)).toBeUndefined(); // not in the exercise
  });
});

describe('wrong notes', () => {
  const rh = splitMeasures(parseRhythm('c4/q d4/q e4/q f4/q'), m44);
  const onsets = exerciseOnsets({ meter: m44, key: 'C', rh, lh: null });
  const toTime = (q: number) => q * 0.5;

  it('flags a wrong pitch on time and gives it no points', () => {
    const s = new Session(onsets, toTime, STRICTNESS.normal);
    s.registerHit('R', 0, 'C4', 0, 60);
    const wrong = s.registerHit('R', 0.5, 'E4', 0, 64);
    expect(wrong.wrongNote).toBe(true);
    expect(wrong.grade).toBe('perfect'); // the timing is still graded
    s.sweepMisses(Infinity);
    const sum = s.summary();
    expect(sum.wrongNotes).toBe(1);
    expect(sum.score).toBeCloseTo(1 / 4);
  });

  it('does not judge pitch without MIDI', () => {
    const s = new Session(onsets, toTime, STRICTNESS.normal);
    expect(s.registerHit('R', 0, 'J').wrongNote).toBeUndefined();
  });
});
