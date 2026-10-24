// Renders the exercise with VexFlow and draws timing feedback on top.
import { Beam, Dot, Formatter, Fraction, Renderer, Stave, StaveConnector, StaveNote, StaveTie, Voice } from 'vexflow';
import type { Exercise, Hand, RNote } from './rhythm';
import { exerciseOnsets, measureQuarters } from './rhythm';
import type { Articulation, Grade } from './scoring';

const VF_DUR: Record<RNote['base'], string> = { w: 'w', h: 'h', q: 'q', e: '8', s: '16' };
const SVG_NS = 'http://www.w3.org/2000/svg';

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
  /** Draw a graded hit under the note at (hand, measure, index). */
  markHit(hand: Hand, measure: number, index: number, grade: Grade, deltaMs: number): void;
  markMiss(hand: Hand, measure: number, index: number): void;
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

export function renderScore(container: HTMLElement, ex: Exercise): RenderedScore {
  container.innerHTML = '';
  const width = Math.max(320, container.clientWidth);
  const mq = measureQuarters(ex.meter);
  const twoHands = !!ex.lh;
  const timeSig = `${ex.meter.num}/${ex.meter.den}`;

  // Notes are spaced in proportion to time, and every bar gets the same
  // note area, so one beat is the same width everywhere and the cursor
  // moves at one constant speed. The area must fit the busiest bar.
  const nMeasures = ex.rh.length;
  const density = (i: number) => Math.max(ex.rh[i].length, ex.lh?.[i].length ?? 0);
  const shortest = (i: number) => Math.min(...[...ex.rh[i], ...(ex.lh?.[i] ?? [])].map((n) => n.dur));
  const needArea = (i: number) => Math.max(20 + density(i) * 34, (mq / shortest(i)) * 30);
  // Where notes start in a plain stave, and how much a clef (+ time signature) adds.
  const plainNoteStart = new Stave(0, 0, 200).getNoteStartX();
  const clefOnlyExtra = new Stave(0, 0, 200).addClef('treble').getNoteStartX() - plainNoteStart;
  const clefExtra = new Stave(0, 0, 200).addClef('treble').addTimeSignature(timeSig).getNoteStartX() - plainNoteStart;
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

  // Below each staff: marker row (dot + ms), then the duration lane.
  const staffGap = 125;
  const laneOffset = 26;
  const systemHeight = twoHands ? 285 : 160;
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
  const spans: MeasureSpan[] = [];
  const markerY: Record<Hand, number[]> = { R: [], L: [] };
  const lineBounds: { top: number; bottom: number; startQ: number; endQ: number }[] = [];

  lines.forEach((measures, li) => {
    const y = li * systemHeight;
    let x = left;
    measures.forEach((mi, k) => {
      // First line also carries the time signature.
      const lead = k > 0 ? 0 : li === 0 ? clefExtra : clefOnlyExtra;
      const w = area + lead + (k === measures.length - 1 ? tail : 0);
      const rhStave = new Stave(x, y, w);
      const lhStave = twoHands ? new Stave(x, y + staffGap, w) : null;
      if (k === 0) {
        rhStave.addClef('treble');
        lhStave?.addClef('bass');
        if (li === 0) {
          rhStave.addTimeSignature(timeSig);
          lhStave?.addTimeSignature(timeSig);
        }
      }
      rhStave.setContext(ctx).draw();
      lhStave?.setContext(ctx).draw();
      if (lhStave && k === 0) {
        new StaveConnector(rhStave, lhStave).setType('brace').setContext(ctx).draw();
        new StaveConnector(rhStave, lhStave).setType('singleLeft').setContext(ctx).draw();
      }
      if (lhStave) new StaveConnector(rhStave, lhStave).setType('singleRight').setContext(ctx).draw();

      const parts: { hand: Hand; stave: Stave; notes: RNote[]; key: string }[] = [
        { hand: 'R', stave: rhStave, notes: ex.rh[mi], key: 'b/4' },
      ];
      if (lhStave && ex.lh) parts.push({ hand: 'L', stave: lhStave, notes: ex.lh[mi], key: 'd/3' });

      const startX = Math.max(...parts.map((p) => p.stave.getNoteStartX()));
      parts.forEach((p) => p.stave.setNoteStartX(startX));

      const built = parts.map((p) => {
        const vfNotes = p.notes.map((n) => {
          const sn = new StaveNote({
            keys: [p.key],
            duration: VF_DUR[n.base],
            dots: n.dotted ? 1 : 0,
            type: n.rest ? 'r' : 'n',
            clef: p.hand === 'R' ? 'treble' : 'bass',
          });
          if (n.dotted) Dot.buildAndAttach([sn], { all: true });
          // Attach now so positions can be read before drawing.
          sn.setStave(p.stave);
          return sn;
        });
        const voice = new Voice({ num_beats: ex.meter.num, beat_value: ex.meter.den });
        voice.setMode(Voice.Mode.SOFT);
        voice.addTickables(vfNotes);
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
          if (n.tie && ni > 0) {
            new StaveTie({ first_note: b.vfNotes[ni - 1], last_note: b.vfNotes[ni], first_indices: [0], last_indices: [0] })
              .setContext(ctx)
              .draw();
          }
        });
        const my = b.stave.getBottomLineY() + (b.hand === 'R' ? 22 : 26);
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
      top: y + 30,
      bottom: y + (twoHands ? staffGap : 0) + 90,
      startQ: measures[0] * mq,
      endQ: (measures[measures.length - 1] + 1) * mq,
    });
  });

  drawCrossBarTies(ex, noteAnchors, svg);

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

  const label = (x: number, y: number, text: string, cls: string) => {
    const t = document.createElementNS(SVG_NS, 'text');
    t.setAttribute('x', String(x));
    t.setAttribute('y', String(y + 16));
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('class', cls);
    t.textContent = text;
    marks.appendChild(t);
  };
  const dot = (x: number, y: number, cls: string) => {
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('cx', String(x));
    c.setAttribute('cy', String(y));
    c.setAttribute('r', '5');
    c.setAttribute('class', cls);
    marks.appendChild(c);
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
    markHit(hand, measure, index, grade, deltaMs) {
      const a = noteAnchors.get(`${hand}:${measure}:${index}`);
      if (!a) return;
      dot(a.x, a.y, `mark ${grade}`);
      const ms = Math.round(deltaMs);
      label(a.x, a.y, `${ms > 0 ? '+' : ''}${ms}`, `mark-text ${grade}`);
    },
    markMiss(hand, measure, index) {
      const a = noteAnchors.get(`${hand}:${measure}:${index}`);
      if (!a) return;
      label(a.x, a.y - 11, '✕', 'mark-text miss big');
      label(a.x, a.y, 'miss', 'mark-text miss');
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
      holds.innerHTML = '';
      holdEls.clear();
    },
  };
}

/** Ties whose first note is in the previous measure (VexFlow ties are per-measure above). */
function drawCrossBarTies(ex: Exercise, anchors: Map<string, { x: number; y: number }>, svg: SVGSVGElement): void {
  const hands: [Hand, RNote[][] | null][] = [
    ['R', ex.rh],
    ['L', ex.lh],
  ];
  for (const [hand, measures] of hands) {
    measures?.forEach((notes, mi) => {
      if (mi === 0 || !notes[0]?.tie) return;
      const prevIdx = measures[mi - 1].length - 1;
      const from = anchors.get(`${hand}:${mi - 1}:${prevIdx}`);
      const to = anchors.get(`${hand}:${mi}:0`);
      if (!from || !to) return;
      // Note heads sit on the middle staff line, a fixed distance above the marker row.
      const lift = hand === 'R' ? 42 : 46;
      const y = from.y - lift;
      const y2 = to.y - lift;
      const path = document.createElementNS(SVG_NS, 'path');
      if (Math.abs(y - y2) > 1) {
        // Bar line falls on a line break: draw two half ties.
        path.setAttribute('d', `M${from.x + 6},${y + 6} q 14,8 28,0 M${to.x - 34},${y2 + 6} q 14,8 28,0`);
      } else {
        const mid = (from.x + to.x) / 2;
        path.setAttribute('d', `M${from.x + 6},${y + 6} Q${mid},${y + 16} ${to.x - 6},${y2 + 6}`);
      }
      path.setAttribute('class', 'xtie');
      svg.appendChild(path);
    });
  }
}
