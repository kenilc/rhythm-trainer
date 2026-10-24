// Renders the exercise with VexFlow and draws timing feedback on top.
import { Accidental, Beam, Dot, Formatter, Fraction, Renderer, Stave, StaveConnector, StaveNote, StaveTie, Voice } from 'vexflow';
import { keyById, midiOf, pitchName, scaleSpelling, staffLine, vfKey, type Pitch } from './pitch';
import type { Exercise, Hand, RNote } from './rhythm';
import { exerciseOnsets, isPitched, measureQuarters } from './rhythm';
import type { Articulation, Grade } from './scoring';

const VF_DUR: Record<RNote['base'], string> = { w: 'w', h: 'h', q: 'q', e: '8', s: '16' };
const SVG_NS = 'http://www.w3.org/2000/svg';

type Clef = 'treble' | 'bass';

interface Anchor {
  q: number;
  x: number;
  line: number;
}

/** Where a measure sits: time maps linearly onto x between x0 and x1. */
interface MeasureSpan {
  line: number;
  x0: number;
  x1: number;
  /** x of the bar line closing this measure. */
  barX: number;
}

export interface RenderedScore {
  /** Draw (or redraw) the feedback for the note or chord at (hand, measure, index). */
  markNote(hand: Hand, measure: number, index: number, mark: NoteMark): void;
  /** Draw an unmatched hit at its position in time (quarters from start). */
  markExtra(hand: Hand, q: number): void;
  /**
   * Draw (or update) the bar showing how long a key was held, from q0 to q1
   * in quarters. Each id is one key press; calling again replaces its bar.
   */
  drawHold(id: number, hand: Hand, q0: number, q1: number, kind: Articulation | 'holding' | 'extra'): void;
  /** Move the playback cursor to a quarter position (null hides it). */
  setCursor(q: number | null): void;
  clearMarks(): void;
}

/** Feedback for one written note or chord, built up as its keys are played. */
export interface NoteMark {
  /** Nothing was played for it. */
  missed: boolean;
  /** Timing grade and average offset of the keys played. */
  grade?: Grade;
  meanMs?: number;
  /** Chords: ms between the first and last key. */
  spreadMs?: number;
  /** Keys played on time that aren't written here. */
  wrong: Pitch[];
  /** Chords: written tones nobody played. */
  missedTones: Pitch[];
}

export function renderScore(container: HTMLElement, ex: Exercise): RenderedScore {
  container.innerHTML = '';
  const width = Math.max(320, container.clientWidth);
  const mq = measureQuarters(ex.meter);
  const twoHands = !!ex.lh;
  const timeSig = `${ex.meter.num}/${ex.meter.den}`;
  const pitched = isPitched(ex);
  // One hand: low parts read better in the bass clef.
  const rhPitches = ex.rh.flat().flatMap((n) => n.pitches ?? []).map(midiOf);
  const rhClef: Clef =
    !twoHands && rhPitches.length && rhPitches.reduce((a, b) => a + b, 0) / rhPitches.length < 60 ? 'bass' : 'treble';

  // Notes are spaced in proportion to time, and every bar gets the same
  // note area, so one beat is the same width everywhere and the cursor
  // moves at one constant speed. The area must fit the busiest bar.
  const nMeasures = ex.rh.length;
  const density = (i: number) => Math.max(ex.rh[i].length, ex.lh?.[i].length ?? 0);
  const shortest = (i: number) => Math.min(...[...ex.rh[i], ...(ex.lh?.[i] ?? [])].map((n) => n.dur));
  const needArea = (i: number) => Math.max(20 + density(i) * 34, (mq / shortest(i)) * 30);
  // Where notes start in a plain stave, and how much a clef (+ time signature) adds.
  const plainNoteStart = new Stave(0, 0, 200).getNoteStartX();
  const lineStart = (withTime: boolean) => {
    const st = new Stave(0, 0, 200).addClef('treble');
    if (pitched) st.addKeySignature(ex.key);
    if (withTime) st.addTimeSignature(timeSig);
    return st.getNoteStartX() - plainNoteStart;
  };
  const clefOnlyExtra = lineStart(false);
  const clefExtra = lineStart(true);
  // Room after the last note of a line so it doesn't sit on the bar line.
  const tail = plainNoteStart + 24;
  const left = 10;
  const usable = width - left * 2;
  const room = usable - clefExtra - tail;
  const need = Math.max(...Array.from({ length: nMeasures }, (_, i) => needArea(i)));
  const perLine = Math.max(1, Math.min(nMeasures, Math.floor(room / need)));
  const area = Math.max(need, room / perLine);
  const lines: number[][] = [];
  for (let i = 0; i < nMeasures; i += perLine) lines.push(Array.from({ length: Math.min(perLine, nMeasures - i) }, (_, k) => i + k));

  // Vertical layout. Pitched notes can sit on ledger lines, so the space
  // above and below each staff comes from the exercise's pitch range.
  // Stave geometry: top line at y+40, bottom line at y+80 (VexFlow lines 5…1).
  const clefOf: Record<Hand, Clef> = { R: rhClef, L: 'bass' };
  const extent = (hand: Hand) => {
    const ls = [...(hand === 'R' ? ex.rh : ex.lh ?? [])].flat().flatMap((n) => n.pitches ?? []).map((p) => staffLine(p, clefOf[hand]));
    const lo = Math.min(3, ...ls);
    const hi = Math.max(3, ...ls);
    return { above: Math.max(0, (hi - 5) * 10 + 8), below: Math.max(0, (1 - lo) * 10 + 8) };
  };
  const ext = { R: extent('R'), L: extent('L') };
  // With chords, the marker row gets a second line (the chord spread).
  const hasChords = [...ex.rh, ...(ex.lh ?? [])].some((m) => m.some((n) => (n.pitches?.length ?? 0) > 1));
  const laneOffset = hasChords ? 38 : 26;
  const rhY = Math.max(0, ext.R.above - 30);
  const rhMarker = rhY + 80 + Math.max(32, ext.R.below + 20);
  const lhY = Math.max(rhY + 125, rhMarker + laneOffset + 6 + 12 + ext.L.above - 40);
  const lhMarker = lhY + 80 + Math.max(36, ext.L.below + 20);
  const systemHeight = (twoHands ? lhMarker : rhMarker) + laneOffset + 6 + 18;

  const renderer = new Renderer(container as HTMLDivElement, Renderer.Backends.SVG);
  const height = lines.length * systemHeight + 10;
  renderer.resize(width, height);
  const ctx = renderer.getContext();
  const svg = container.querySelector('svg') as SVGSVGElement;
  // Scale with the container, so small width changes (e.g. a scrollbar
  // appearing) never cause overflow; larger ones trigger a re-layout.
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.removeAttribute('width');
  svg.removeAttribute('height');
  svg.style.width = '100%';
  svg.style.height = 'auto';

  const noteAnchors = new Map<string, { x: number; y: number }>();
  const staves = new Map<string, Stave>();
  const spans: MeasureSpan[] = [];
  const markerY: Record<Hand, number[]> = { R: [], L: [] };
  const lineBounds: { top: number; bottom: number; startQ: number; endQ: number }[] = [];
  /** Last drawn note per hand, for ties across bar lines. */
  const lastNote: Partial<Record<Hand, { note: StaveNote; line: number }>> = {};

  lines.forEach((measures, li) => {
    const y = li * systemHeight;
    let x = left;
    measures.forEach((mi, k) => {
      // Every line starts with clef (and key); the first also has the time signature.
      const lead = k > 0 ? 0 : li === 0 ? clefExtra : clefOnlyExtra;
      const w = area + lead + (k === measures.length - 1 ? tail : 0);
      const rhStave = new Stave(x, y + rhY, w);
      const lhStave = twoHands ? new Stave(x, y + lhY, w) : null;
      if (k === 0) {
        for (const [st, clef] of [[rhStave, clefOf.R], [lhStave, clefOf.L]] as const) {
          if (!st) continue;
          st.addClef(clef);
          if (pitched) st.addKeySignature(ex.key);
          if (li === 0) st.addTimeSignature(timeSig);
        }
      }
      rhStave.setContext(ctx).draw();
      lhStave?.setContext(ctx).draw();
      if (lhStave && k === 0) {
        new StaveConnector(rhStave, lhStave).setType('brace').setContext(ctx).draw();
        new StaveConnector(rhStave, lhStave).setType('singleLeft').setContext(ctx).draw();
      }
      if (lhStave) new StaveConnector(rhStave, lhStave).setType('singleRight').setContext(ctx).draw();

      // Rhythm-only notes sit on the middle line.
      const parts: { hand: Hand; stave: Stave; notes: RNote[]; key: string }[] = [
        { hand: 'R', stave: rhStave, notes: ex.rh[mi], key: rhClef === 'treble' ? 'b/4' : 'd/3' },
      ];
      if (lhStave && ex.lh) parts.push({ hand: 'L', stave: lhStave, notes: ex.lh[mi], key: 'd/3' });
      parts.forEach((p) => staves.set(`${p.hand}:${mi}`, p.stave));

      const startX = Math.max(...parts.map((p) => p.stave.getNoteStartX()));
      parts.forEach((p) => p.stave.setNoteStartX(startX));

      const built = parts.map((p) => {
        const vfNotes = p.notes.map((n) => {
          const sn = new StaveNote({
            keys: n.pitches ? n.pitches.map(vfKey) : [p.key],
            duration: VF_DUR[n.base],
            dots: n.dotted ? 1 : 0,
            type: n.rest ? 'r' : 'n',
            clef: clefOf[p.hand],
            auto_stem: !!n.pitches,
          });
          if (n.dotted) Dot.buildAndAttach([sn], { all: true });
          // Attach now so positions can be read before drawing.
          sn.setStave(p.stave);
          return sn;
        });
        const voice = new Voice({ num_beats: ex.meter.num, beat_value: ex.meter.den });
        voice.setMode(Voice.Mode.SOFT);
        voice.addTickables(vfNotes);
        // Shows only the accidentals the key signature and the bar don't already imply.
        if (pitched) Accidental.applyAccidentals([voice], ex.key);
        // Beam per quarter beat in every meter: easiest to read at this level.
        const beams = Beam.generateBeams(vfNotes, { groups: [new Fraction(1, 4)] });
        return { ...p, vfNotes, voice, beams };
      });

      const fmt = new Formatter();
      built.forEach((b) => fmt.joinVoices([b.voice]));
      fmt.format(
        built.map((b) => b.voice),
        Math.max(40, x + w - startX - 18),
      );

      // Re-space notes in proportion to time so the cursor moves at a
      // constant speed. The bar's time span runs up to where the next bar's
      // first note sits, so the cursor crosses the bar line without a jump.
      const first = built[0].vfNotes[0];
      const origin = first.getAbsoluteX() - first.getTickContext().getX();
      const end = origin + area;
      built.forEach((b) => {
        let q = 0;
        b.notes.forEach((n, ni) => {
          b.vfNotes[ni].getTickContext().setX((q / mq) * (end - origin));
          q += n.dur;
        });
      });
      const headMid = (first.getNoteHeadBeginX() + first.getNoteHeadEndX()) / 2 - first.getAbsoluteX();
      spans[mi] = { line: li, x0: origin + headMid, x1: end + headMid, barX: x + w };

      built.forEach((b) => {
        b.voice.draw(ctx, b.stave);
        b.beams.forEach((beam) => beam.setContext(ctx).draw());
        b.notes.forEach((n, ni) => {
          const cur = b.vfNotes[ni];
          if (n.tie) {
            const prev = ni > 0 ? { note: b.vfNotes[ni - 1], line: li } : lastNote[b.hand];
            // Tie every tone of a chord.
            const idx = (n.pitches ?? [null]).map((_, i) => i);
            if (prev?.line === li) {
              new StaveTie({ first_note: prev.note, last_note: cur, first_indices: idx, last_indices: idx }).setContext(ctx).draw();
            } else if (prev) {
              // Across a line break: a tie out of the old line and one into the new.
              new StaveTie({ first_note: prev.note, last_note: null, first_indices: idx, last_indices: idx }).setContext(ctx).draw();
              new StaveTie({ first_note: null, last_note: cur, first_indices: idx, last_indices: idx }).setContext(ctx).draw();
            }
          }
        });
        lastNote[b.hand] = { note: b.vfNotes[b.vfNotes.length - 1], line: li };
        const my = y + (b.hand === 'R' ? rhMarker : lhMarker);
        markerY[b.hand][li] = my;
        b.notes.forEach((_, ni) => {
          const sn = b.vfNotes[ni];
          const nx = (sn.getNoteHeadBeginX() + sn.getNoteHeadEndX()) / 2;
          noteAnchors.set(`${b.hand}:${mi}:${ni}`, { x: nx, y: my });
        });
      });
      x += w;
    });
    lineBounds.push({
      top: y + rhY + 30,
      bottom: y + (twoHands ? lhY : rhY) + 90,
      startQ: measures[0] * mq,
      endQ: (measures[measures.length - 1] + 1) * mq,
    });
  });

  const group = (cls: string) => {
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', cls);
    svg.appendChild(g);
    return g;
  };
  const lanes = group('lanes');
  const holds = group('holds');
  const marks = group('marks');
  const cursor = document.createElementNS(SVG_NS, 'line');
  cursor.setAttribute('class', 'cursor');
  cursor.style.display = 'none';
  svg.appendChild(cursor);

  const label = (x: number, y: number, text: string, cls: string, parent: SVGElement = marks) => {
    const t = document.createElementNS(SVG_NS, 'text');
    t.setAttribute('x', String(x));
    t.setAttribute('y', String(y + 16));
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('class', cls);
    t.textContent = text;
    parent.appendChild(t);
  };
  const dot = (x: number, y: number, cls: string, parent: SVGElement = marks) => {
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('cx', String(x));
    c.setAttribute('cy', String(y));
    c.setAttribute('r', '5');
    c.setAttribute('class', cls);
    parent.appendChild(c);
  };

  /** The note that was played instead, drawn in red beside the written one. */
  const ghostNote = (stave: Stave, clef: Clef, x: number, p: Pitch, parent: SVGElement) => {
    const line = staffLine(p, clef);
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', 'wrong-note');
    // Offset by a head width, like the upper note of a second in a chord.
    const gx = x + 11;
    // Ledger lines for notes off the staff.
    for (let l = 0; l >= line; l--) ledger(g, gx, stave.getYForNote(l));
    for (let l = 6; l <= line; l++) ledger(g, gx, stave.getYForNote(l));
    const head = document.createElementNS(SVG_NS, 'ellipse');
    head.setAttribute('cx', String(gx));
    head.setAttribute('cy', String(stave.getYForNote(line)));
    head.setAttribute('rx', '5.5');
    head.setAttribute('ry', '4');
    head.setAttribute('transform', `rotate(-20 ${gx} ${stave.getYForNote(line)})`);
    g.appendChild(head);
    // An accidental when the played note differs from what the key implies
    // (e.g. B♮ in F major), so B and B♭ don't look the same.
    const keyAlter = scaleSpelling(keyById(ex.key)).find((s) => s.step === p.step)?.alter ?? 0;
    if (p.alter !== keyAlter) {
      const t = document.createElementNS(SVG_NS, 'text');
      // Left of the written note, where accidentals go.
      t.setAttribute('x', String(x - 8));
      t.setAttribute('y', String(stave.getYForNote(line) + 5));
      t.setAttribute('text-anchor', 'end');
      t.textContent = { [-2]: '𝄫', [-1]: '♭', 0: '♮', 1: '♯', 2: '𝄪' }[p.alter] ?? '';
      g.appendChild(t);
    }
    const title = document.createElementNS(SVG_NS, 'title');
    title.textContent = `Played ${pitchName(p)}`;
    g.appendChild(title);
    parent.appendChild(g);
  };
  /** A red ring around a written chord tone that wasn't played. */
  const missRing = (stave: Stave, clef: Clef, x: number, p: Pitch, parent: SVGElement) => {
    const y = stave.getYForNote(staffLine(p, clef));
    const ring = document.createElementNS(SVG_NS, 'ellipse');
    ring.setAttribute('cx', String(x));
    ring.setAttribute('cy', String(y));
    ring.setAttribute('rx', '8');
    ring.setAttribute('ry', '6.5');
    ring.setAttribute('class', 'missed-tone');
    const title = document.createElementNS(SVG_NS, 'title');
    title.textContent = `Not played: ${pitchName(p)}`;
    ring.appendChild(title);
    parent.appendChild(ring);
  };
  const noteMarks = new Map<string, SVGGElement>();
  const ledger = (g: SVGGElement, x: number, y: number) => {
    const l = document.createElementNS(SVG_NS, 'line');
    l.setAttribute('x1', String(x - 9));
    l.setAttribute('x2', String(x + 9));
    l.setAttribute('y1', String(y));
    l.setAttribute('y2', String(y));
    g.appendChild(l);
  };

  /** x position of a moment in time; the same for both hands. */
  const xAt = (_hand: Hand, q: number): Anchor | null => {
    if (!spans.length) return null;
    const mi = Math.min(Math.max(0, Math.floor(q / mq)), spans.length - 1);
    const sp = spans[mi];
    const f = Math.min(Math.max((q - mi * mq) / mq, 0), 1);
    return { q, x: sp.x0 + f * (sp.x1 - sp.x0), line: sp.line };
  };

  /** Rectangles covering q0..q1 in a hand's duration lane, split at line breaks. */
  const span = (parent: SVGGElement, hand: Hand, q0: number, q1: number, cls: string, trim = 0) => {
    const out: SVGRectElement[] = [];
    lineBounds.forEach((lb, li) => {
      const a = Math.max(q0, lb.startQ);
      const b = Math.min(q1, lb.endQ - 2e-6);
      if (b <= a) return;
      const xa = xAt(hand, a)!.x;
      let xb = xAt(hand, b)!.x - (b === q1 ? trim : 0);
      // Time spans run on to the next bar's first note; stop lanes at the bar line.
      const bar = Math.round(b / mq);
      if (bar > 0 && Math.abs(b - bar * mq) < 1e-3) xb = Math.min(xb, spans[bar - 1].barX - 4 - (b === q1 ? trim : 0));
      const r = document.createElementNS(SVG_NS, 'rect');
      r.setAttribute('x', String(xa - 4));
      r.setAttribute('y', String(markerY[hand][li] + laneOffset));
      r.setAttribute('width', String(Math.max(3, xb - xa)));
      r.setAttribute('height', '6');
      r.setAttribute('rx', '2');
      r.setAttribute('class', cls);
      parent.appendChild(r);
      out.push(r);
    });
    return out;
  };

  // Written lengths, always visible: the target for each held note.
  for (const o of exerciseOnsets(ex)) span(lanes, o.hand, o.q, o.q + o.durQ, 'written', 6);

  const holdEls = new Map<number, SVGRectElement[]>();

  return {
    drawHold(id, hand, q0, q1, kind) {
      holdEls.get(id)?.forEach((r) => r.remove());
      holdEls.set(id, span(holds, hand, q0, Math.max(q1, q0 + 0.02), `held ${kind}`));
    },
    markNote(hand, measure, index, m) {
      const k = `${hand}:${measure}:${index}`;
      const a = noteAnchors.get(k);
      const stave = staves.get(`${hand}:${measure}`);
      if (!a || !stave) return;
      noteMarks.get(k)?.remove();
      const g = document.createElementNS(SVG_NS, 'g');
      marks.appendChild(g);
      noteMarks.set(k, g);
      if (m.missed) {
        label(a.x, a.y - 11, '✕', 'mark-text miss big', g);
        label(a.x, a.y, 'miss', 'mark-text miss', g);
        return;
      }
      if (m.grade && m.meanMs !== undefined) {
        dot(a.x, a.y, `mark ${m.grade}`, g);
        const ms = Math.round(m.meanMs);
        label(a.x, a.y, `${ms > 0 ? '+' : ''}${ms}`, `mark-text ${m.grade}`, g);
      }
      if (m.spreadMs !== undefined) {
        const v = Math.round(m.spreadMs);
        const cls = v <= 15 ? 'perfect' : v <= 30 ? 'good' : v <= 50 ? 'ok' : 'poor';
        label(a.x, a.y + 12, `↔${v}`, `mark-text spread ${cls}`, g);
      }
      for (const p of m.wrong) ghostNote(stave, clefOf[hand], a.x, p, g);
      for (const p of m.missedTones) missRing(stave, clefOf[hand], a.x, p, g);
    },
    markExtra(hand, q) {
      const a = xAt(hand, q);
      if (!a) return;
      const y = markerY[hand][a.line];
      label(a.x, y - 11, '+', 'mark-text extra big');
    },
    setCursor(q) {
      if (q === null) {
        cursor.style.display = 'none';
        return;
      }
      const a = xAt('R', q);
      const lb = a && lineBounds[a.line];
      if (!a || !lb) return;
      cursor.style.display = '';
      cursor.setAttribute('x1', String(a.x));
      cursor.setAttribute('x2', String(a.x));
      cursor.setAttribute('y1', String(lb.top));
      cursor.setAttribute('y2', String(lb.bottom));
    },
    clearMarks() {
      marks.innerHTML = '';
      noteMarks.clear();
      holds.innerHTML = '';
      holdEls.clear();
    },
  };
}
