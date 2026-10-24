# Rhythm Trainer

A browser page for practising basic rhythms on a MIDI keyboard, with one or two hands.
It shows each hit's timing error in ms, right on the notation.

## Run

```bash
npm install
npm run dev
```

Open http://localhost:5173 in **Chrome or Edge**. Safari has no Web MIDI.

## Using it

1. Connect the piano over USB, then reload. The MIDI chip turns green and blinks on every key.
2. **Calibrate** once per device and speaker setup: play on 12 clicks. The measured delay
   (audio output plus MIDI input) is subtracted from every hit.
3. Pick a tempo, time signature and hands, then **Generate** a rhythm or write your own.
4. **Listen** plays the rhythm once. **Play** gives a count-in, then you play along.
5. **Repeat** loops the exercise 3, 5 or 10 times, or until you press Stop. Only the first repetition
   gets a count-in; turn on *Bar of rest between repeats* for a breather (it clicks, so it doubles as a
   count-in). Each repetition is scored on its own, and the results show a per-repetition table with the trend.

Two hands: notes below the split point (default C4) count as left hand.
Keyboard fallback: `A S D F` = left hand, `J K L ;` / Space = right hand.

### Rhythm syntax

`w h q e s` whole, half, quarter, eighth, sixteenth · `.` dotted · `r` rest ·
`~` tied from the previous note · `|` optional bar line.

```
q q e e q | h. qr | q. e ~q q
```

**With pitches**, put the note before the duration: `c4/q d4/e e4/e f#4/h | ~f#4/q qr g4/h`.
Letter, then `#` / `b` (or `##` / `bb`), then the octave (C4 = middle C). Chords go in parentheses:
`(c4 e4 g4)/h (d4 f#4 a4)/q`. A tied note or chord may leave the pitch out (`~q`). In one part, either every note has a pitch or none does. Pick the key signature
under **Key**; only the accidentals the key and bar don't already imply are drawn.

### Pitched exercises

Set **Notes** to *Five-finger position* to generate notes in degrees 1–5 of the chosen key
(right hand from the tonic at or above middle C, left hand an octave or so lower). With MIDI, a note
played on time but on the wrong key shows in red beside the written one (with an accidental where
needed) and scores no points; the timing is still graded. The laptop keyboard only checks timing.

Each key of a chord is matched and graded on its own. Under the chord you see the average offset and
the **spread** (`↔ 18`: ms from the first to the last key), coloured by how together it was; chord
notes you didn't play get a red ring. The results show the average spread. In two-hand mode a key the
exercise is waiting for counts for the hand it's written in, even across the split point.

### Grades (Normal strictness)

perfect ≤ 25 ms · good ≤ 50 ms · ok ≤ 100 ms · poor beyond that · missed · extra (an unexpected hit).
The summary gives a **timing** figure (average early or late, i.e. rushing or dragging) and a
**consistency** figure (spread). Consistency is usually the one to improve first.

### Articulation

Under each staff, a grey bar shows each note's written length (ties included), and a colored bar shows
how long you actually held the key: **staccato** (< 50%), **detached** (50–85%), **legato** (≥ 85%),
or **held too long** (well past the written length, e.g. into a rest). Only the finger release
counts; the sustain pedal is ignored.

## Code

- `src/rhythm.ts`: rhythm model, text parser, level-based generator
- `src/pitch.ts`: pitches, keys, scale spelling
- `src/scoring.ts`: matches hits to notes and grades them
- `src/audio.ts`: Web Audio clock, clicks, metronome
- `src/input.ts`: MIDI and keyboard input behind one interface (the place to add an iPad bridge)
- `src/notation.ts`: VexFlow rendering and feedback marks
- `src/main.ts`: UI wiring, runs, calibration

`npm test` runs the unit tests.
