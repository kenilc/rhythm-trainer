import { audioCtx, click, makeBus, Metronome, perfToAudio, tone } from './audio';
import { InputManager, midiNoteName, type MidiStatus, type RawHit } from './input';
import { renderScore, type RenderedScore } from './notation';
import {
  beatQuarters,
  exerciseOnsets,
  generateExercise,
  LEVEL_NAMES,
  LH_PATTERN_NAMES,
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
import { Session, STRICTNESS, type Expected, type HitRecord, type Summary } from './scoring';

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
  document.querySelectorAll<HTMLButtonElement>('#hands button').forEach((b) => {
    b.classList.toggle('on', (b.dataset.hands === '2') === settings.twoHands);
  });
  $('lh-pattern-field').hidden = !settings.twoHands;
  $('lh-text-wrap').hidden = !settings.twoHands;
  $('split-field').hidden = !settings.twoHands;
  $('bpm-unit').textContent = meterOf(settings.meter).den === 2 ? '(𝅗𝅥 = BPM)' : '(♩ = BPM)';
  $('keys-hint').textContent = settings.twoHands
    ? 'Keyboard fallback: left hand A S D F · right hand J K L ; / Space'
    : 'Keyboard fallback: Space or J K L';
  $('latency-text').textContent = latencyMs === null ? 'not calibrated' : `${Math.round(latencyMs)} ms`;
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
  $('results').hidden = true;
  showBeat('Ready', '');
}

function generate(): void {
  setExercise(
    generateExercise({
      meter: meterOf(settings.meter),
      bars: settings.bars,
      level: settings.level,
      twoHands: settings.twoHands,
      lhPattern: settings.lhPattern,
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
    setExercise({ meter, rh, lh });
  } catch (e) {
    parseError.textContent = (e as Error).message;
  }
}

// ---------------------------------------------------------------------------
// Running an exercise

interface Run {
  mode: 'play' | 'listen';
  bus: GainNode;
  start: number;
  exStart: number;
  end: number;
  beatSec: number;
  quarterSec: number;
  session: Session | null;
  raf: number;
}

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

function startRun(mode: 'play' | 'listen'): void {
  stopAll();
  const c = audioCtx();
  const meter = exercise.meter;
  const beatSec = 60 / settings.bpm;
  const quarterSec = beatSec / beatQuarters(meter);
  const barSec = measureQuarters(meter) * quarterSec;
  const bars = exercise.rh.length;
  const start = c.currentTime + 0.2;
  const exStart = start + settings.countIn * barSec;
  const bus = makeBus();

  scheduleClicks(bus, start, settings.countIn, beatSec, meter);
  if (settings.clickDuring || mode === 'listen') scheduleClicks(bus, exStart, bars, beatSec, meter);

  const onsets = exerciseOnsets(exercise);
  let session: Session | null = null;
  if (mode === 'listen') {
    for (const o of onsets) {
      tone(bus, exStart + o.q * quarterSec, o.hand, soundingQuarters(o.hand, o.measure, o.index) * quarterSec);
    }
  } else {
    session = new Session(onsets, (q) => exStart + q * quarterSec, STRICTNESS[settings.strictness]);
  }

  rendered.clearMarks();
  $('results').hidden = true;
  const last = session ? Math.max(...session.expected.map((e) => e.time + e.window)) : 0;
  run = {
    mode,
    bus,
    start,
    exStart,
    end: Math.max(exStart + totalQuarters(exercise) * quarterSec, last) + 0.15,
    beatSec,
    quarterSec,
    session,
    raf: 0,
  };
  setRunning(true);
  run.raf = requestAnimationFrame(frame);
}

/** Length a note actually sounds, including notes tied onto it. */
function soundingQuarters(hand: Hand, measure: number, index: number): number {
  const measures = hand === 'R' ? exercise.rh : exercise.lh!;
  let total = 0;
  let mi = measure;
  let ni = index;
  for (;;) {
    total += measures[mi][ni].dur;
    ni++;
    if (ni >= measures[mi].length) {
      mi++;
      ni = 0;
    }
    if (mi >= measures.length || !measures[mi][ni].tie) return total;
  }
}

/** Current audible time, in the same frame as compensated hits. */
const nowAudible = () => perfToAudio(performance.now());

function frame(): void {
  if (!run) return;
  const now = nowAudible();
  const meter = exercise.meter;
  const q = (now - run.exStart) / run.quarterSec;
  if (now < run.start) {
    showBeat('…', 'get ready');
  } else if (now < run.exStart) {
    const beat = Math.floor((now - run.start) / run.beatSec);
    showBeat(String((beat % meter.num) + 1), 'count-in');
    rendered.setCursor(null);
  } else if (q < totalQuarters(exercise)) {
    const mq = measureQuarters(meter);
    const bar = Math.floor(q / mq);
    const beat = Math.floor((q - bar * mq) / beatQuarters(meter));
    showBeat(String(beat + 1), `bar ${bar + 1} / ${exercise.rh.length}`);
    rendered.setCursor(q);
  }

  if (run.session) {
    for (const e of run.session.sweepMisses(now - lat())) rendered.markMiss(e.hand, e.measure, e.index);
  }

  if (now > run.end) {
    finishRun();
    return;
  }
  run.raf = requestAnimationFrame(frame);
}

function finishRun(): void {
  if (!run) return;
  const r = run;
  stopAll();
  if (r.session) {
    for (const e of r.session.sweepMisses(Infinity)) rendered.markMiss(e.hand, e.measure, e.index);
    showResults(r.session);
    const s = r.session.summary();
    showBeat(`${Math.round(s.score * 100)}%`, 'done — press Play to try again');
  } else {
    showBeat('Ready', '');
  }
}

function stopAll(): void {
  if (run) {
    cancelAnimationFrame(run.raf);
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

const lat = () => (latencyMs ?? 0) / 1000;

function handFor(h: RawHit): Hand {
  if (!settings.twoHands) return 'R';
  if (h.source === 'midi') return h.note! < settings.split ? 'L' : 'R';
  return h.keyHand ?? 'R';
}

function onHit(h: RawHit): void {
  flashLed();
  if (calib) {
    calib.hits.push(perfToAudio(h.perf));
    return;
  }
  if (!run || run.mode !== 'play' || !run.session) return;
  const t = perfToAudio(h.perf) - lat();
  // Ignore stray notes during the count-in.
  if (t < run.exStart - 0.25 || t > run.end) return;
  const hand = handFor(h);
  const rec = run.session.registerHit(hand, t, h.label);
  if (rec.expected) {
    rendered.markHit(hand, rec.expected.measure, rec.expected.index, rec.grade as Exclude<HitRecord['grade'], 'extra'>, rec.deltaMs!);
  } else {
    rendered.markExtra(hand, (t - run.exStart) / run.quarterSec);
  }
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

function summaryCard(title: string, s: Summary): string {
  return `
    <div class="card">
      <h3>${title}</h3>
      <div class="big-score">${Math.round(s.score * 100)}<small>%</small></div>
      <dl>
        <dt>Timing</dt><dd>${tendency(s)}</dd>
        <dt>Consistency</dt><dd>${consistency(s.sdMs)}</dd>
      </dl>
      <div class="counts">
        <span class="perfect">${s.perfect} perfect</span>
        <span class="good">${s.good} good</span>
        <span class="ok">${s.ok} ok</span>
        <span class="poor">${s.poor} poor</span>
        <span class="miss">${s.missed} missed</span>
        <span class="extra">${s.extra} extra</span>
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

function showResults(session: Session): void {
  const parts: string[] = [];
  if (exercise.lh) {
    parts.push(summaryCard('Both hands', session.summary()));
    parts.push(summaryCard('Right hand', session.summary('R')));
    parts.push(summaryCard('Left hand', session.summary('L')));
  } else {
    parts.push(summaryCard('Result', session.summary()));
  }
  $('summary').innerHTML = parts.join('');

  type Row = { t: number; html: string };
  const rows: Row[] = [];
  const handName = (h: Hand) => (h === 'R' ? 'Right' : 'Left');
  for (const h of session.hits) {
    const ms = h.deltaMs === undefined ? '' : `${h.deltaMs > 0 ? '+' : ''}${Math.round(h.deltaMs)} ms`;
    const pos = h.expected ? positionLabel(h.expected) : 'between notes';
    rows.push({ t: h.time, html: `<td>${handName(h.hand)}</td><td>${pos}</td><td>${h.label}</td><td>${ms}</td><td class="${h.grade}">${h.grade}</td>` });
  }
  for (const e of session.expected) {
    if (!e.hit) rows.push({ t: e.time, html: `<td>${handName(e.hand)}</td><td>${positionLabel(e)}</td><td>—</td><td></td><td class="miss">missed</td>` });
  }
  rows.sort((a, b) => a.t - b.t);
  $('hit-rows').innerHTML = rows.map((r) => `<tr>${r.html}</tr>`).join('');
  $('results').hidden = false;
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

$('generate').addEventListener('click', generate);
$('apply').addEventListener('click', applyCustom);
startBtn.addEventListener('click', () => startRun('play'));
listenBtn.addEventListener('click', () => startRun('listen'));
stopBtn.addEventListener('click', stopAll);
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

// Re-layout the notation when the window width changes.
let resizeTimer = 0;
let lastWidth = scoreEl.clientWidth;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    if (run || Math.abs(scoreEl.clientWidth - lastWidth) < 20) return;
    lastWidth = scoreEl.clientWidth;
    rendered = renderScore(scoreEl, exercise);
  }, 200);
});

syncControls();
generate();
