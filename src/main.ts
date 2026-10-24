import { audioCtx, click, makeBus, Metronome, perfToAudio, tone } from './audio';
import { InputManager, midiNoteName, type MidiStatus, type RawHit } from './input';
import { renderScore, type NoteMark, type RenderedScore } from './notation';
import { KEYS, keyById, pitchName, spellMidi } from './pitch';
import {
  beatQuarters,
  exerciseOnsets,
  generateExercise,
  LEVEL_NAMES,
  isPitched,
  LH_PATTERN_NAMES,
  NOTES_MODE_NAMES,
  type NotesMode,
  MAX_LEVEL,
  measureQuarters,
  measuresToText,
  METERS,
  parseRhythm,
  splitMeasures,
  totalQuarters,
  type Exercise,
  type Hand,
  type LhPattern,
  type Meter,
} from './rhythm';
import {
  ARTICULATION_NAMES,
  gradeFor,
  Session,
  spreadOf,
  STRICTNESS,
  type Articulation,
  type Expected,
  type HitRecord,
  type Summary,
} from './scoring';

// ---------------------------------------------------------------------------
// Persistent settings (per browser/device)

interface Settings {
  bpm: number;
  meter: string;
  twoHands: boolean;
  countIn: number;
  strictness: string;
  split: number;
  clickDuring: boolean;
  subdivide: boolean;
  level: number;
  bars: number;
  lhPattern: LhPattern;
  notes: NotesMode;
  /** Key signature (KeyDef id) for pitched exercises. */
  key: string;
  /** 1 = play once, 0 = loop until stopped, otherwise that many times. */
  repeats: number;
  /** One bar of rest (with clicks) between repetitions. */
  restBar: boolean;
  /** Settings panels folded away. */
  menuFolded: boolean;
}

const DEFAULTS: Settings = {
  bpm: 80,
  meter: '4/4',
  twoHands: false,
  countIn: 1,
  strictness: 'normal',
  split: 60,
  clickDuring: true,
  subdivide: false,
  level: 1,
  bars: 4,
  lhPattern: 'steady',
  notes: 'rhythm',
  key: 'C',
  repeats: 1,
  restBar: false,
  menuFolded: false,
};

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: settings just won't persist */
  }
}

const settings: Settings = load('rt.settings', DEFAULTS);
let latencyMs: number | null = load<{ v: number | null }>('rt.latency', { v: null }).v;
const persist = () => save('rt.settings', settings);

const meterOf = (s: string): Meter => METERS.find((m) => `${m.num}/${m.den}` === s) ?? METERS[3];

// ---------------------------------------------------------------------------
// DOM

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const bpmInput = $<HTMLInputElement>('bpm');
const meterSel = $<HTMLSelectElement>('meter');
const countInSel = $<HTMLSelectElement>('countin');
const strictSel = $<HTMLSelectElement>('strictness');
const splitSel = $<HTMLSelectElement>('split');
const clickDuring = $<HTMLInputElement>('click-during');
const subdivide = $<HTMLInputElement>('subdivide');
const levelSel = $<HTMLSelectElement>('level');
const barsSel = $<HTMLSelectElement>('bars');
const lhPatternSel = $<HTMLSelectElement>('lh-pattern');
const notesSel = $<HTMLSelectElement>('notes');
const keySel = $<HTMLSelectElement>('key');
const repeatsSel = $<HTMLSelectElement>('repeats');
const restBar = $<HTMLInputElement>('rest-bar');
const rhText = $<HTMLTextAreaElement>('rh-text');
const lhText = $<HTMLTextAreaElement>('lh-text');
const parseError = $('parse-error');
const scoreEl = $('score');
const beatMain = $('beat-main');
const beatSub = $('beat-sub');
const startBtn = $<HTMLButtonElement>('start');
const listenBtn = $<HTMLButtonElement>('listen');
const metroBtn = $<HTMLButtonElement>('metronome');
const stopBtn = $<HTMLButtonElement>('stop');

const opt = (sel: HTMLSelectElement, value: string, text: string) => {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = text;
  sel.appendChild(o);
};
METERS.forEach((m) => opt(meterSel, `${m.num}/${m.den}`, `${m.num}/${m.den}${m.num === 2 && m.den === 2 ? ' (cut time)' : ''}`));
for (let l = 1; l <= MAX_LEVEL; l++) opt(levelSel, String(l), LEVEL_NAMES[l]);
(Object.keys(LH_PATTERN_NAMES) as LhPattern[]).forEach((k) => opt(lhPatternSel, k, LH_PATTERN_NAMES[k]));
(Object.keys(NOTES_MODE_NAMES) as NotesMode[]).forEach((k) => opt(notesSel, k, NOTES_MODE_NAMES[k]));
KEYS.forEach((k) => opt(keySel, k.id, k.label));
for (let n = 48; n <= 72; n++) opt(splitSel, String(n), `${midiNoteName(n)} and above = right hand`);

function syncControls(): void {
  bpmInput.value = String(settings.bpm);
  meterSel.value = settings.meter;
  countInSel.value = String(settings.countIn);
  strictSel.value = settings.strictness;
  splitSel.value = String(settings.split);
  clickDuring.checked = settings.clickDuring;
  subdivide.checked = settings.subdivide;
  levelSel.value = String(settings.level);
  barsSel.value = String(settings.bars);
  lhPatternSel.value = settings.lhPattern;
  notesSel.value = settings.notes;
  keySel.value = settings.key;
  // The key matters for generated notes and for pitched rhythms typed in.
  $('key-field').hidden = settings.notes === 'rhythm' && !(exercise && isPitched(exercise));
  repeatsSel.value = String(settings.repeats);
  restBar.checked = settings.restBar;
  $('rest-bar-field').hidden = settings.repeats === 1;
  document.querySelectorAll<HTMLButtonElement>('#hands button').forEach((b) => {
    b.classList.toggle('on', (b.dataset.hands === '2') === settings.twoHands);
  });
  $('lh-pattern-field').hidden = !settings.twoHands;
  $('lh-text-wrap').hidden = !settings.twoHands;
  $('split-field').hidden = !settings.twoHands;
  $('bpm-unit').textContent = meterOf(settings.meter).den === 2 ? '(𝅗𝅥 = BPM)' : '(♩ = BPM)';
  $('chord-legend').hidden = !(exercise && isPitched(exercise));
  $('keys-hint').textContent =
    (settings.twoHands
      ? 'Keyboard fallback: left hand A S D F · right hand J K L ; / Space'
      : 'Keyboard fallback: Space or J K L') +
    (exercise && isPitched(exercise) ? ' (timing only: checking notes needs MIDI)' : '');
  $('latency-text').textContent = latencyMs === null ? 'not calibrated' : `${Math.round(latencyMs)} ms`;

  // Folded menu: a one-line summary stands in for the panels.
  $('menu').hidden = settings.menuFolded;
  $('menu-summary').hidden = !settings.menuFolded;
  $('fold').textContent = settings.menuFolded ? 'Show settings' : 'Hide settings';
  $('fold').setAttribute('aria-expanded', String(!settings.menuFolded));
  const parts = [
    `<strong>${settings.bpm}</strong> BPM`,
    `<strong>${settings.meter}</strong>`,
    settings.twoHands ? 'Two hands' : 'One hand',
    settings.repeats === 1 ? 'Once' : settings.repeats === 0 ? 'Loop' : `${settings.repeats}×`,
  ];
  if (exercise && isPitched(exercise)) parts.push(keyById(exercise.key).label);
  $('menu-summary').innerHTML = `${parts.map((p) => `<span>${p}</span>`).join('<span>·</span>')}<span class="show">Show settings ▾</span>`;
}

function setMenuFolded(folded: boolean): void {
  settings.menuFolded = folded;
  persist();
  syncControls();
}

// ---------------------------------------------------------------------------
// Exercise

let exercise: Exercise;
let rendered: RenderedScore;

function setExercise(ex: Exercise): void {
  stopAll();
  exercise = ex;
  rhText.value = measuresToText(ex.rh);
  lhText.value = ex.lh ? measuresToText(ex.lh) : '';
  parseError.textContent = '';
  rendered = renderScore(scoreEl, ex);
  laidOutWidth = scoreEl.clientWidth;
  $('results').hidden = true;
  showBeat('Ready', '');
  syncControls();
}

function generate(): void {
  setExercise(
    generateExercise({
      meter: meterOf(settings.meter),
      bars: settings.bars,
      level: settings.level,
      twoHands: settings.twoHands,
      lhPattern: settings.lhPattern,
      notes: settings.notes,
      key: settings.key,
    }),
  );
}

function applyCustom(): void {
  const meter = meterOf(settings.meter);
  try {
    const rh = splitMeasures(parseRhythm(rhText.value), meter);
    let lh = null;
    if (settings.twoHands) {
      try {
        lh = splitMeasures(parseRhythm(lhText.value), meter);
      } catch (e) {
        throw new Error(`Left hand: ${(e as Error).message}`);
      }
      if (lh.length !== rh.length) throw new Error(`Right hand has ${rh.length} bars but left hand has ${lh.length}.`);
    }
    setExercise({ meter, key: settings.key, rh, lh });
  } catch (e) {
    parseError.textContent = (e as Error).message;
  }
}

// ---------------------------------------------------------------------------
// Running an exercise
//
// A run is one or more repetitions of the exercise. Only the first gets a
// count-in; later ones follow seamlessly (or after a bar of rest). Every
// repetition's notes go into one Session so hits near the seam match the
// right note, and each repetition is summarised on its own.

interface Run {
  mode: 'play' | 'listen';
  bus: GainNode;
  start: number;
  /** Start of the first repetition. */
  exStart: number;
  /** Length of the exercise itself, and of one repetition including rest. */
  exSec: number;
  repSec: number;
  /** Number of repetitions; Infinity loops until stopped. */
  repeats: number;
  scheduled: number;
  /** Repetitions that are over, in order. */
  completed: number[];
  /** Repetition whose marks are on the score. */
  shown: number;
  /** Finite runs end here; Infinity otherwise. */
  end: number;
  beatSec: number;
  quarterSec: number;
  session: Session | null;
  raf: number;
  timer: number;
  /** Keys currently held down, by input id. */
  held: Map<string, { rec: HitRecord; drawId: number }>;
}

/** How long to wait after the last note for keys still held down. */
const RELEASE_GRACE = 1.5;
/** Schedule audio this far ahead (background tabs only wake timers ~1/s). */
const SCHEDULE_AHEAD = 2.5;
/** Switch the score to the next repetition this long before it starts, so early hits on its first note show. */
const SHOW_AHEAD = 0.2;
let holdIds = 0;

let run: Run | null = null;
let calib: CalibRun | null = null;

const metronome = new Metronome(
  () => {
    const m = meterOf(settings.meter);
    return { beatSec: 60 / settings.bpm, beatsPerBar: m.num, subdivide: settings.subdivide };
  },
  (beat, time) => {
    const delay = Math.max(0, (time - audioCtx().currentTime) * 1000);
    setTimeout(() => {
      if (metronome.running) showBeat(String(beat + 1), '');
    }, delay);
  },
);

function showBeat(main: string, sub: string): void {
  beatMain.textContent = main;
  beatSub.textContent = sub;
}

function setRunning(on: boolean): void {
  startBtn.disabled = on;
  listenBtn.disabled = on;
  metroBtn.disabled = on && !metronome.running;
  stopBtn.disabled = !on;
  metroBtn.classList.toggle('on', metronome.running);
  document.body.classList.toggle('running', on);
}

function scheduleClicks(bus: GainNode, from: number, bars: number, beatSec: number, meter: Meter): void {
  const sub = settings.subdivide;
  for (let b = 0; b < bars * meter.num; b++) {
    const t = from + b * beatSec;
    click(bus, t, b % meter.num === 0 ? 'accent' : 'beat');
    if (sub) click(bus, t + beatSec / 2, 'sub');
  }
}

const repStart = (r: Run, n: number) => r.exStart + n * r.repSec;

function startRun(mode: 'play' | 'listen'): void {
  stopAll();
  const c = audioCtx();
  const meter = exercise.meter;
  const beatSec = 60 / settings.bpm;
  const quarterSec = beatSec / beatQuarters(meter);
  const barSec = measureQuarters(meter) * quarterSec;
  const exSec = totalQuarters(exercise) * quarterSec;
  const loop = mode === 'play' && settings.repeats !== 1;
  const restBars = loop && settings.restBar ? 1 : 0;
  const start = c.currentTime + 0.2;
  const exStart = start + settings.countIn * barSec;
  const repeats = mode === 'listen' ? 1 : settings.repeats === 0 ? Infinity : settings.repeats;
  const bus = makeBus();
  scheduleClicks(bus, start, settings.countIn, beatSec, meter);

  rendered.clearMarks();
  $('results').hidden = true;
  run = {
    mode,
    bus,
    start,
    exStart,
    exSec,
    repSec: exSec + restBars * barSec,
    repeats,
    scheduled: 0,
    completed: [],
    shown: 0,
    end: Infinity,
    beatSec,
    quarterSec,
    session: mode === 'play' ? new Session([], (q) => q, STRICTNESS[settings.strictness]) : null,
    raf: 0,
    timer: 0,
    held: new Map(),
  };
  scheduleAhead();
  renderRepStrip();
  setRunning(true);
  run.timer = window.setInterval(scheduleAhead, 200);
  run.raf = requestAnimationFrame(frame);
}

/** Schedule clicks, tones and expected notes for repetitions starting soon. */
function scheduleAhead(): void {
  if (!run) return;
  const r = run;
  const now = audioCtx().currentTime;
  const meter = exercise.meter;
  const onsets = exerciseOnsets(exercise);
  const bars = exercise.rh.length;
  const restBars = Math.round((r.repSec - r.exSec) / (r.beatSec * meter.num));
  while (r.scheduled < r.repeats && repStart(r, r.scheduled) < now + SCHEDULE_AHEAD) {
    const n = r.scheduled++;
    const t0 = repStart(r, n);
    if (settings.clickDuring || r.mode === 'listen') scheduleClicks(r.bus, t0, bars, r.beatSec, meter);
    // The rest bar always clicks: it works as a count-in for the next repetition.
    if (restBars && n + 1 < r.repeats) scheduleClicks(r.bus, t0 + r.exSec, restBars, r.beatSec, meter);
    if (r.session) {
      r.session.addOnsets(onsets, (q) => t0 + q * r.quarterSec, n);
    } else {
      for (const o of onsets) tone(r.bus, t0 + o.q * r.quarterSec, o.hand, o.durQ * r.quarterSec, o.midi);
    }
  }
  // Once the last repetition is scheduled, the end is known: after its
  // last note's matching window (or the end of the bar, if later).
  if (r.scheduled === r.repeats && !Number.isFinite(r.end)) {
    const lastNote = Math.max(0, ...(r.session?.expected.map((e) => e.time + e.window) ?? []));
    r.end = Math.max(lastNote, repStart(r, r.repeats - 1) + r.exSec) + 0.15;
  }
}

/** Current audible time, in the same frame as compensated hits. */
const nowAudible = () => perfToAudio(performance.now());

/** Repetition a moment belongs to (clamped to the scheduled ones). */
function repAt(r: Run, t: number): number {
  const n = Math.floor((t - r.exStart) / r.repSec);
  return Math.min(Math.max(0, n), Math.max(0, r.scheduled - 1));
}

/** Quarter position of a time within a given repetition. */
const qIn = (r: Run, t: number, rep: number) => (t - repStart(r, rep)) / r.quarterSec;

function frame(): void {
  if (!run) return;
  const r = run;
  const now = nowAudible();
  const meter = exercise.meter;
  const repLabel = r.repeats === 1 ? '' : ` · rep ${repAt(r, now) + 1}${Number.isFinite(r.repeats) ? ` / ${r.repeats}` : ''}`;
  if (now < r.start) {
    showBeat('…', 'get ready');
  } else if (now < r.exStart) {
    const beat = Math.floor((now - r.start) / r.beatSec);
    showBeat(String((beat % meter.num) + 1), 'count-in');
    rendered.setCursor(null);
  } else if (now < r.end) {
    const n = repAt(r, now);
    const inRep = now - repStart(r, n);
    if (inRep < r.exSec) {
      const q = inRep / r.quarterSec;
      const mq = measureQuarters(meter);
      const bar = Math.floor(q / mq);
      const beat = Math.floor((q - bar * mq) / beatQuarters(meter));
      showBeat(String(beat + 1), `bar ${bar + 1} / ${exercise.rh.length}${repLabel}`);
      rendered.setCursor(q);
    } else {
      const beat = Math.floor((inRep - r.exSec) / r.beatSec);
      showBeat(String((beat % meter.num) + 1), `rest · rep ${n + 2} next`);
      rendered.setCursor(null);
    }
  }

  // Move the score's marks to the next repetition just before it starts.
  const show = Math.min(repAt(r, now + SHOW_AHEAD), r.repeats - 1);
  if (show !== r.shown) {
    r.shown = show;
    rendered.clearMarks();
  }

  if (r.session) {
    for (const e of r.session.sweepMisses(now - lat())) {
      if (e.rep === r.shown) refreshMark(r.session, e);
    }
    // Grow the bars of keys still held down.
    for (const { rec, drawId } of r.held.values()) {
      if (rec.rep === r.shown) rendered.drawHold(drawId, rec.hand, qIn(r, rec.time, rec.rep), qIn(r, now - lat(), rec.rep), 'holding');
    }
    // A repetition is over once its last note's window has passed.
    const session = r.session;
    while (r.completed.length < r.scheduled) {
      const n = r.completed.length;
      const last = session.expected.filter((e) => e.rep === n).reduce((m, e) => Math.max(m, e.time + e.window), 0);
      if (now - lat() < Math.max(last, repStart(r, n) + r.exSec)) break;
      r.completed.push(n);
      renderRepStrip();
    }
  }

  // Wait a little past the end for the last notes to be released.
  if (now > r.end && (r.held.size === 0 || now > r.end + RELEASE_GRACE)) {
    finishRun();
    return;
  }
  r.raf = requestAnimationFrame(frame);
}

function finishRun(): void {
  if (!run) return;
  const r = run;
  // Keys still down at the very end: count them as released now.
  for (const id of [...r.held.keys()]) release(id, nowAudible() - lat());
  stopAll();
  if (!r.session) {
    showBeat('Ready', '');
    return;
  }
  // A single run always counts; in a loop, only repetitions that were finished.
  const reps = r.repeats === 1 ? [0] : r.completed;
  if (r.repeats === 1) r.session.sweepMisses(Infinity);
  if (!reps.length) {
    showBeat('Stopped', 'no complete repetition');
    return;
  }
  for (const e of r.session.expected) {
    if (e.rep === r.shown && reps.includes(e.rep) && !e.hit && e.missed) refreshMark(r.session, e);
  }
  showResults(r.session, reps);
  const s = r.session.summary(undefined, reps);
  const label = reps.length > 1 ? `average of ${reps.length} repetitions` : 'done';
  showBeat(`${Math.round(s.score * 100)}%`, `${label} — press Play to try again`);
}

function stopAll(): void {
  if (run) {
    cancelAnimationFrame(run.raf);
    clearInterval(run.timer);
    run.bus.disconnect();
    run = null;
    rendered?.setCursor(null);
    showBeat('Ready', '');
  }
  if (metronome.running) {
    metronome.stop();
    showBeat('Ready', '');
  }
  setRunning(false);
}

/** Stop button: in a loop, keep the finished repetitions and show their results. */
function stopPressed(): void {
  if (run?.session && run.repeats !== 1) finishRun();
  else stopAll();
}

const lat = () => (latencyMs ?? 0) / 1000;

function handFor(h: RawHit): Hand {
  if (!settings.twoHands) return 'R';
  if (h.source === 'midi') return h.note! < settings.split ? 'L' : 'R';
  return h.keyHand ?? 'R';
}

function release(id: string, t: number): void {
  const h = run?.held.get(id);
  if (!run?.session || !h) return;
  run.held.delete(id);
  run.session.registerRelease(h.rec, t);
  if (h.rec.rep !== run.shown) return;
  const kind = h.rec.articulation ?? (h.rec.expected ? 'holding' : 'extra');
  rendered.drawHold(h.drawId, h.rec.hand, qIn(run, h.rec.time, h.rec.rep), qIn(run, h.rec.release!, h.rec.rep), kind);
}

function onHit(h: RawHit): void {
  if (h.kind === 'up') {
    if (run) release(h.id, perfToAudio(h.perf) - lat());
    return;
  }
  flashLed();
  if (calib) {
    calib.hits.push(perfToAudio(h.perf));
    return;
  }
  if (!run?.session || run.mode !== 'play') return;
  const r = run;
  const session = run.session;
  const t = perfToAudio(h.perf) - lat();
  // Ignore stray notes during the count-in.
  if (t < r.exStart - 0.25 || t > r.end) return;
  const played = h.source === 'midi' ? h.note : undefined;
  // A key the exercise is waiting for in one hand counts for that hand.
  const hand = (played !== undefined && settings.twoHands && session.handForKey(played, t)) || handFor(h);
  const rec = session.registerHit(hand, t, h.label, repAt(r, t), played);
  // A repeated press without a release (shouldn't happen) closes the old one first.
  release(h.id, t);
  r.held.set(h.id, { rec, drawId: holdIds++ });
  if (rec.rep !== r.shown) return;
  if (rec.expected) {
    refreshMark(session, rec.expected);
  } else {
    rendered.markExtra(hand, qIn(r, t, rec.rep));
  }
}

/** Redraw the mark of the note or chord an expected tone belongs to. */
function refreshMark(session: Session, e: Expected): void {
  const tones = session.expected.filter(
    (x) => x.rep === e.rep && x.hand === e.hand && x.measure === e.measure && x.index === e.index,
  );
  const hits = tones.filter((x) => x.hit).map((x) => x.hit!);
  const written = (e.hand === 'R' ? exercise.rh : exercise.lh!)[e.measure][e.index].pitches;
  const key = keyById(exercise.key);
  const mark: NoteMark = {
    missed: hits.length === 0 && tones.every((x) => x.missed),
    wrong: hits.filter((h) => h.wrongNote).map((h) => spellMidi(h.played!, key)),
    // Rings only for a chord that was partly played; a fully missed note says "miss".
    missedTones: written && tones.length > 1 && hits.length ? tones.filter((x) => x.missed).map((x) => written[x.tone]) : [],
  };
  if (hits.length) {
    mark.meanMs = hits.reduce((s, h) => s + h.deltaMs!, 0) / hits.length;
    mark.grade = gradeFor(Math.abs(mark.meanMs), session.thresholds);
  }
  const spread = spreadOf(tones);
  if (spread !== undefined) mark.spreadMs = spread;
  rendered.markNote(e.hand, e.measure, e.index, mark);
}

/** Live strip of per-repetition scores during a loop. */
function renderRepStrip(): void {
  const strip = $('rep-strip');
  if (!run?.session || run.repeats === 1) {
    strip.hidden = true;
    return;
  }
  const s = run.session;
  const scores = run.completed.map((n) => Math.round(s.summary(undefined, n).score * 100));
  const best = Math.max(...scores);
  strip.hidden = false;
  strip.innerHTML =
    '<span class="hint">Repetitions:</span>' +
    (scores.length
      ? scores.map((v, i) => `<span class="rep-chip${v === best ? ' best' : ''}">#${i + 1} ${v}%</span>`).join('')
      : '<span class="hint">scores appear after each one</span>');
}

// ---------------------------------------------------------------------------
// Results

function tendency(s: Summary): string {
  const m = Math.round(s.meanMs);
  if (s.perfect + s.good + s.ok + s.poor === 0) return '—';
  if (Math.abs(m) < 5) return 'On the beat';
  return m < 0 ? `Rushing ${-m} ms` : `Dragging ${m} ms`;
}

function consistency(sd: number): string {
  const v = Math.round(sd);
  const word = v <= 15 ? 'very steady' : v <= 30 ? 'steady' : v <= 50 ? 'uneven' : 'very uneven';
  return `±${v} ms (${word})`;
}

const ARTICULATION_ORDER: Articulation[] = ['staccato', 'detached', 'legato', 'long'];

function articulationLine(s: Summary): string {
  const a = s.articulation;
  if (!a.measured) return '—';
  const top = ARTICULATION_ORDER.reduce((x, y) => (a.counts[y] > a.counts[x] ? y : x));
  return `Mostly ${ARTICULATION_NAMES[top]} (held ${Math.round(a.meanRatio * 100)}% on average)`;
}

/** How together chord keys were, on average. */
function chordLine(ms: number): string {
  const v = Math.round(ms);
  const word = v <= 15 ? 'together' : v <= 30 ? 'nearly together' : v <= 50 ? 'a bit rolled' : 'rolled';
  return `↔ ${v} ms first to last key (${word})`;
}

function summaryCard(title: string, s: Summary): string {
  return `
    <div class="card">
      <h3>${title}</h3>
      <div class="big-score">${Math.round(s.score * 100)}<small>%</small></div>
      <dl>
        <dt>Timing</dt><dd>${tendency(s)}</dd>
        <dt>Consistency</dt><dd>${consistency(s.sdMs)}</dd>
        <dt>Articulation</dt><dd>${articulationLine(s)}</dd>
        ${s.chordSpreadMs === undefined ? '' : `<dt>Chords</dt><dd>${chordLine(s.chordSpreadMs)}</dd>`}
      </dl>
      <div class="counts">
        <span class="perfect">${s.perfect} perfect</span>
        <span class="good">${s.good} good</span>
        <span class="ok">${s.ok} ok</span>
        <span class="poor">${s.poor} poor</span>
        <span class="miss">${s.missed} missed</span>
        <span class="extra">${s.extra} extra</span>
        ${isPitched(exercise) ? `<span class="miss">${s.wrongNotes} wrong note${s.wrongNotes === 1 ? '' : 's'}</span>` : ''}
      </div>
      <div class="counts arts">
        ${ARTICULATION_ORDER.map((k) => `<span class="art-${k}">${s.articulation.counts[k]} ${ARTICULATION_NAMES[k]}</span>`).join('')}
      </div>
    </div>`;
}

function positionLabel(e: Expected): string {
  const meter = exercise.meter;
  const bq = beatQuarters(meter);
  const inBar = e.q - e.measure * measureQuarters(meter);
  const beat = Math.floor(inBar / bq + 1e-9);
  const frac = Math.round(((inBar - beat * bq) / bq) * 4) / 4;
  const syll = { 0: '', 0.25: ' e', 0.5: ' &', 0.75: ' a' }[frac] ?? '';
  return `bar ${e.measure + 1}, ${beat + 1}${syll}`;
}

function showResults(session: Session, reps: number[]): void {
  const loop = reps.length > 1 || reps[0] !== 0;
  const parts: string[] = [];
  const title = loop ? `${reps.length} repetitions` : 'Result';
  if (exercise.lh) {
    parts.push(summaryCard(loop ? `Both hands · ${title}` : 'Both hands', session.summary(undefined, reps)));
    parts.push(summaryCard('Right hand', session.summary('R', reps)));
    parts.push(summaryCard('Left hand', session.summary('L', reps)));
  } else {
    parts.push(summaryCard(title, session.summary(undefined, reps)));
  }
  $('summary').innerHTML = parts.join('');
  renderRepHistory(session, reps);

  type Row = { t: number; html: string };
  const rows: Row[] = [];
  const handName = (h: Hand) => (h === 'R' ? 'Right' : 'Left');
  const repCell = (n: number) => (loop ? `<td>${n + 1}</td>` : '');
  for (const h of session.hits) {
    if (!reps.includes(h.rep)) continue;
    const ms = h.deltaMs === undefined ? '' : `${h.deltaMs > 0 ? '+' : ''}${Math.round(h.deltaMs)} ms`;
    const pos = h.expected ? positionLabel(h.expected) : 'between notes';
    const held = h.release === undefined ? '' : `${Math.round((h.release - h.time) * 1000)} ms`;
    const art = h.articulation
      ? `<span class="art-${h.articulation}">${ARTICULATION_NAMES[h.articulation]}</span> <span class="hint">${Math.round(h.heldRatio! * 100)}%</span>`
      : '';
    rows.push({
      t: h.time,
      html: `${repCell(h.rep)}<td>${handName(h.hand)}</td><td>${pos}</td><td>${h.label}</td><td>${ms}</td><td class="${h.grade}">${h.grade}${wrongNote(h)}</td><td>${held}</td><td>${art}</td>`,
    });
  }
  for (const e of session.expected) {
    if (e.hit || !reps.includes(e.rep)) continue;
    rows.push({
      t: e.time,
      html: `${repCell(e.rep)}<td>${handName(e.hand)}</td><td>${positionLabel(e)}</td><td>—</td><td></td><td class="miss">missed</td><td></td><td></td>`,
    });
  }
  rows.sort((a, b) => a.t - b.t);
  const cols = ['Hand', 'Position', 'Key', 'Offset', 'Grade', 'Held', 'Articulation'];
  $('hit-head').innerHTML = `<tr>${(loop ? ['Rep', ...cols] : cols).map((c) => `<th>${c}</th>`).join('')}</tr>`;
  $('hit-rows').innerHTML = rows.map((r) => `<tr>${r.html}</tr>`).join('');
  $('results').hidden = false;
}

/** " · wrong note (E4)" for a hit on time but on the wrong key. */
function wrongNote(h: HitRecord): string {
  if (!h.wrongNote || !h.expected) return '';
  const part = h.expected.hand === 'R' ? exercise.rh : exercise.lh!;
  const want = part[h.expected.measure][h.expected.index].pitches?.[h.expected.tone];
  return ` <span class="miss">· wrong note${want ? ` (wanted ${pitchName(want)})` : ''}</span>`;
}

/** One row per repetition, so progress across a loop is visible. */
function renderRepHistory(session: Session, reps: number[]): void {
  const el = $('rep-history');
  if (reps.length < 2) {
    el.hidden = true;
    return;
  }
  const sums = reps.map((n) => session.summary(undefined, n));
  const scores = sums.map((s) => Math.round(s.score * 100));
  const best = Math.max(...scores);
  const half = Math.floor(reps.length / 2);
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const trend = avg(scores.slice(reps.length - half)) - avg(scores.slice(0, half));
  const trendText =
    Math.abs(trend) < 3
      ? 'Steady across repetitions.'
      : trend > 0
        ? `Improving: second half averaged ${Math.round(trend)} points higher.`
        : `Fading: second half averaged ${Math.round(-trend)} points lower. Maybe time for a break.`;
  el.hidden = false;
  el.innerHTML = `
    <h3>Repetitions</h3>
    <p class="hint">${trendText}</p>
    <table class="hits reps">
      <thead><tr><th>Rep</th><th>Score</th><th>Timing</th><th>Consistency</th><th>Articulation</th><th>Missed</th><th>Extra</th></tr></thead>
      <tbody>
        ${sums
          .map(
            (s, i) => `<tr${scores[i] === best ? ' class="best"' : ''}>
              <td>${reps[i] + 1}</td>
              <td><span class="score-bar" style="--w:${scores[i]}"></span>${scores[i]}%</td>
              <td>${tendency(s)}</td><td>${consistency(s.sdMs)}</td><td>${articulationLine(s)}</td>
              <td>${s.missed}</td><td>${s.extra}</td></tr>`,
          )
          .join('')}
      </tbody>
    </table>`;
}

// ---------------------------------------------------------------------------
// Calibration

interface CalibRun {
  bus: GainNode;
  clicks: number[];
  hits: number[];
  timer: number;
}

const CAL_BPM = 100;
const CAL_COUNT_IN = 4;
const CAL_CLICKS = 12;
let calResult: number | null = null;

function startCalibration(): void {
  stopCalibration();
  const c = audioCtx();
  const beat = 60 / CAL_BPM;
  const start = c.currentTime + 0.3;
  const bus = makeBus();
  const clicks: number[] = [];
  for (let i = 0; i < CAL_COUNT_IN + CAL_CLICKS; i++) {
    const t = start + i * beat;
    click(bus, t, i % 4 === 0 ? 'accent' : 'beat');
    if (i >= CAL_COUNT_IN) clicks.push(t);
  }
  const progress = $('cal-progress');
  progress.innerHTML = Array.from({ length: CAL_CLICKS }, () => '<i></i>').join('');
  $('cal-result').textContent = 'Listen for the count-in…';
  $('cal-save').hidden = true;
  $<HTMLButtonElement>('cal-start').disabled = true;
  const timer = window.setInterval(() => {
    if (!calib) return;
    const now = nowAudible();
    const passed = clicks.filter((t) => t <= now).length;
    progress.querySelectorAll('i').forEach((el, i) => el.classList.toggle('on', i < passed));
    if (now < clicks[0]) $('cal-result').textContent = `Count-in… ${Math.min(CAL_COUNT_IN, Math.floor((now - start) / beat) + 1)}`;
    else $('cal-result').textContent = 'Play on every click';
    if (now > clicks[clicks.length - 1] + 0.4) finishCalibration();
  }, 30);
  calib = { bus, clicks, hits: [], timer };
}

function finishCalibration(): void {
  if (!calib) return;
  const { clicks, hits } = calib;
  stopCalibration();
  const deltas: number[] = [];
  for (const h of hits) {
    const nearest = clicks.reduce((a, b) => (Math.abs(b - h) < Math.abs(a - h) ? b : a));
    const d = (h - nearest) * 1000;
    if (Math.abs(d) < 250) deltas.push(d);
  }
  const res = $('cal-result');
  if (deltas.length < 6) {
    res.textContent = `Only ${deltas.length} usable hits — try again and play on every click.`;
    calResult = null;
    return;
  }
  deltas.sort((a, b) => a - b);
  const median = deltas[Math.floor(deltas.length / 2)];
  const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const sd = Math.sqrt(deltas.reduce((a, b) => a + (b - mean) ** 2, 0) / deltas.length);
  calResult = median;
  res.innerHTML =
    `Measured offset: <strong>${Math.round(median)} ms</strong> (spread ±${Math.round(sd)} ms, ${deltas.length} hits).` +
    (sd > 40 ? '<br>The spread is large; consider running it again.' : '');
  $('cal-save').hidden = false;
}

function stopCalibration(): void {
  if (!calib) return;
  clearInterval(calib.timer);
  calib.bus.disconnect();
  calib = null;
  $<HTMLButtonElement>('cal-start').disabled = false;
}

// ---------------------------------------------------------------------------
// MIDI status

const midiChip = $('midi-chip');
let ledTimer = 0;
function flashLed(): void {
  midiChip.classList.add('flash');
  clearTimeout(ledTimer);
  ledTimer = window.setTimeout(() => midiChip.classList.remove('flash'), 120);
}

function onMidiStatus(s: MidiStatus): void {
  const text = $('midi-text');
  const btn = $('midi-connect');
  midiChip.classList.remove('ok', 'warn');
  btn.hidden = true;
  if (s.state === 'unsupported') {
    text.textContent = 'MIDI not supported in this browser (use Chrome or Edge)';
    midiChip.classList.add('warn');
  } else if (s.state === 'denied') {
    text.textContent = 'MIDI blocked';
    midiChip.classList.add('warn');
    btn.hidden = false;
  } else if (s.inputs.length === 0) {
    text.textContent = 'MIDI: no device connected';
    midiChip.classList.add('warn');
  } else {
    text.textContent = `MIDI: ${s.inputs.join(', ')}`;
    midiChip.classList.add('ok');
  }
}

// ---------------------------------------------------------------------------
// Wiring

const input = new InputManager(onMidiStatus);
input.onHit(onHit);
void input.initMidi();
$('midi-connect').addEventListener('click', () => void input.initMidi());

function setBpm(v: number): void {
  settings.bpm = Math.min(240, Math.max(30, Math.round(v)));
  bpmInput.value = String(settings.bpm);
  persist();
}
bpmInput.addEventListener('change', () => setBpm(Number(bpmInput.value) || DEFAULTS.bpm));
document.querySelectorAll<HTMLButtonElement>('[data-bpm]').forEach((b) =>
  b.addEventListener('click', () => setBpm(settings.bpm + Number(b.dataset.bpm))),
);

let taps: number[] = [];
$('tap').addEventListener('click', () => {
  const now = performance.now();
  if (taps.length && now - taps[taps.length - 1] > 2000) taps = [];
  taps.push(now);
  taps = taps.slice(-5);
  if (taps.length >= 2) {
    const avg = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
    setBpm(60000 / avg);
  }
});

const onChange = (el: HTMLElement, fn: () => void) => el.addEventListener('change', fn);
onChange(meterSel, () => {
  settings.meter = meterSel.value;
  persist();
  syncControls();
  generate();
});
document.querySelectorAll<HTMLButtonElement>('#hands button').forEach((b) =>
  b.addEventListener('click', () => {
    const two = b.dataset.hands === '2';
    if (two === settings.twoHands) return;
    settings.twoHands = two;
    persist();
    syncControls();
    generate();
  }),
);
onChange(countInSel, () => ((settings.countIn = Number(countInSel.value)), persist()));
onChange(strictSel, () => ((settings.strictness = strictSel.value), persist()));
onChange(splitSel, () => ((settings.split = Number(splitSel.value)), persist()));
onChange(clickDuring, () => ((settings.clickDuring = clickDuring.checked), persist()));
onChange(subdivide, () => ((settings.subdivide = subdivide.checked), persist()));
onChange(levelSel, () => ((settings.level = Number(levelSel.value)), persist()));
onChange(barsSel, () => ((settings.bars = Number(barsSel.value)), persist()));
onChange(lhPatternSel, () => ((settings.lhPattern = lhPatternSel.value as LhPattern), persist()));
onChange(notesSel, () => {
  settings.notes = notesSel.value as NotesMode;
  persist();
  generate();
});
onChange(keySel, () => {
  settings.key = keySel.value;
  persist();
  // New notes for a generated exercise; a typed one just gets the new key signature.
  if (settings.notes !== 'rhythm') generate();
  else setExercise({ ...exercise, key: settings.key });
});
onChange(repeatsSel, () => {
  settings.repeats = Number(repeatsSel.value);
  persist();
  syncControls();
});
onChange(restBar, () => ((settings.restBar = restBar.checked), persist()));

$('generate').addEventListener('click', generate);
$('fold').addEventListener('click', () => setMenuFolded(!settings.menuFolded));
$('menu-summary').addEventListener('click', () => setMenuFolded(false));
$('apply').addEventListener('click', applyCustom);
startBtn.addEventListener('click', () => startRun('play'));
listenBtn.addEventListener('click', () => startRun('listen'));
stopBtn.addEventListener('click', stopPressed);
metroBtn.addEventListener('click', () => {
  if (metronome.running) {
    stopAll();
    return;
  }
  stopAll();
  metronome.start();
  setRunning(true);
  metroBtn.classList.add('on');
});

// Calibration dialog
const calDialog = $<HTMLDialogElement>('cal-dialog');
$('calibrate').addEventListener('click', () => {
  stopAll();
  calResult = null;
  $('cal-result').textContent =
    latencyMs === null ? '' : `Current offset: ${Math.round(latencyMs)} ms`;
  $('cal-progress').innerHTML = '';
  $('cal-save').hidden = true;
  calDialog.showModal();
});
$('cal-start').addEventListener('click', startCalibration);
$('cal-cancel').addEventListener('click', () => {
  stopCalibration();
  calDialog.close();
});
calDialog.addEventListener('close', stopCalibration);
$('cal-save').addEventListener('click', () => {
  if (calResult !== null) {
    latencyMs = calResult;
    save('rt.latency', { v: latencyMs });
    syncControls();
  }
  calDialog.close();
});
$('cal-reset').addEventListener('click', () => {
  latencyMs = 0;
  save('rt.latency', { v: 0 });
  syncControls();
  $('cal-result').textContent = 'Offset reset to 0 ms.';
});

// Re-layout the notation when its width changes a lot (small changes just scale).
let laidOutWidth = 0;
new ResizeObserver(() => {
  const w = scoreEl.clientWidth;
  if (run || !exercise || Math.abs(w - laidOutWidth) < 40) return;
  rendered = renderScore(scoreEl, exercise);
  laidOutWidth = w;
}).observe(scoreEl);

syncControls();
generate();
