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

Two hands: notes below the split point (default C4) count as left hand.
Keyboard fallback: `A S D F` = left hand, `J K L ;` / Space = right hand.

### Rhythm syntax

`w h q e s` whole, half, quarter, eighth, sixteenth · `.` dotted · `r` rest ·
`~` tied from the previous note · `|` optional bar line.

```
q q e e q | h. qr | q. e ~q q
```

### Grades (Normal strictness)

perfect ≤ 25 ms · good ≤ 50 ms · ok ≤ 100 ms · poor beyond that · missed · extra (an unexpected hit).
The summary gives a **timing** figure (average early or late, i.e. rushing or dragging) and a
**consistency** figure (spread). Consistency is usually the one to improve first.

## Code

- `src/rhythm.ts`: rhythm model, text parser, level-based generator
- `src/scoring.ts`: matches hits to notes and grades them
- `src/audio.ts`: Web Audio clock, clicks, metronome
- `src/input.ts`: MIDI and keyboard input behind one interface (the place to add an iPad bridge)
- `src/notation.ts`: VexFlow rendering and feedback marks
- `src/main.ts`: UI wiring, runs, calibration

`npm test` runs the unit tests.
