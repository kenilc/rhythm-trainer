// Renders the exercise with VexFlow and draws timing feedback on top.
import { Beam, Dot, Formatter, Fraction, Renderer, Stave, StaveConnector, StaveNote, StaveTie, Voice } from 'vexflow';
import type { Exercise, Hand, RNote } from './rhythm';
import { measureQuarters } from './rhythm';
import type { Grade } from './scoring';

const VF_DUR: Record<RNote['base'], string> = { w: 'w', h: 'h', q: 'q', e: '8', s: '16' };
const SVG_NS = 'http://www.w3.org/2000/svg';

interface Anchor {
  q: number;
  x: number;
  line: number;
}

export interface RenderedScore {
  /** Draw a graded hit under the note at (hand, measure, index). */
  markHit(hand: Hand, measure: number, index: number, grade: Grade, deltaMs: number): void;
  markMiss(hand: Hand, measure: number, index: number): void;
  /** Draw an unmatched hit at its position in time (quarters from start). */
  markExtra(hand: Hand, q: number): void;
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

  // Measure widths grow with note density, then lines are packed greedily.
  const nMeasures = ex.rh.length;
  const density = (i: number) => Math.max(ex.rh[i].length, ex.lh?.[i].length ?? 0);
  const baseWidth = (i: number) => 60 + density(i) * 34;
  const lineStartExtra = 70;
  const left = 10;
  const usable = width - left * 2;
  const lines: number[][] = [];
  let cur: number[] = [];
  let curW = lineStartExtra;
  for (let i = 0; i < nMeasures; i++) {
    const w = baseWidth(i);
    if (cur.length && curW + w > usable) {
      lines.push(cur);
      cur = [];
      curW = lineStartExtra;
    }
    cur.push(i);
    curW += w;
  }
  if (cur.length) lines.push(cur);

  const staffGap = 110;
  const systemHeight = twoHands ? 250 : 140;
  const renderer = new Renderer(container as HTMLDivElement, Renderer.Backends.SVG);
  renderer.resize(width, lines.length * systemHeight + 10);
  const ctx = renderer.getContext();
  const svg = container.querySelector('svg') as SVGSVGElement;

  const noteAnchors = new Map<string, { x: number; y: number }>();
  const anchors: Record<Hand, Anchor[]> = { R: [], L: [] };
  const markerY: Record<Hand, number[]> = { R: [], L: [] };
  const lineBounds: { top: number; bottom: number; startQ: number; endQ: number }[] = [];

  lines.forEach((measures, li) => {
    const y = li * systemHeight;
    const natural = measures.reduce((s, i) => s + baseWidth(i), lineStartExtra);
    // Stretch each line to the full width, except a short last line.
    const stretch = li === lines.length - 1 && natural < usable * 0.7 ? 1 : usable / natural;
    let x = left;
    measures.forEach((mi, k) => {
      const w = (baseWidth(mi) + (k === 0 ? lineStartExtra : 0)) * stretch;
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
        let q = mi * mq;
        b.notes.forEach((n, ni) => {
          const sn = b.vfNotes[ni];
          const nx = (sn.getNoteHeadBeginX() + sn.getNoteHeadEndX()) / 2;
          noteAnchors.set(`${b.hand}:${mi}:${ni}`, { x: nx, y: my });
          anchors[b.hand].push({ q, x: nx, line: li });
          q += n.dur;
        });
        anchors[b.hand].push({ q: (mi + 1) * mq - 1e-6, x: x + w - 6, line: li });
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

  const marks = document.createElementNS(SVG_NS, 'g');
  marks.setAttribute('class', 'marks');
  svg.appendChild(marks);
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

  const xAt = (hand: Hand, q: number): Anchor | null => {
    const list = anchors[hand];
    if (!list.length) return null;
    let prev = list[0];
    for (const a of list) {
      if (a.q > q) {
        if (a.line !== prev.line || a.q === prev.q) return { ...prev };
        const f = (q - prev.q) / (a.q - prev.q);
        return { q, x: prev.x + f * (a.x - prev.x), line: prev.line };
      }
      prev = a;
    }
    return { ...prev };
  };

  return {
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
