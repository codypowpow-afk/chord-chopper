# Chord Chopper

Load a music or vocal sample, let it chop the sample into notes, then remix those glitched-up chops onto
chord progressions in any key. It starts from the progression it hears in your sample. From there you can pick
one of 20 style presets and cycle through random progressions, or let it roam across styles on its own. Play
the found notes on a one-shot keyboard and draw your own notes into the remix. Runs fully offline.

Out of the box everything non-essential is off: no glitch, swing, delay, reverb, drive, crush, sustain looping or
percussion. Chords and lead are voiced around the sample's own pitch, so chops play close to how they sound in
the original.

## Run it

- **Windows app:** download `ChordChopper.exe` from the [Releases](../../releases) page and run it. It needs the
  Microsoft Edge WebView2 Runtime, which is built into Windows 11 (and most up-to-date Windows 10).
- **Browser:** open `index.html` in Chrome or Edge.

## How it works

1. **Sample → notes.** Drop in a WAV / MP3 / FLAC / OGG / M4A (or press DEMO VOX). A YIN pitch tracker finds the
   note of every chop (name, cents, confidence).
   - **NOTES** splits wherever the pitch changes. This works best for vocals and melodies. Drums and noisy material
     switch to ONSETS automatically.
   - **ONSETS** splits on transients. **GRID** gives 8 / 16 / 32 / 64 equal slices.
   - Sensitivity and minimum length control the cuts. Double-click the waveform to cut and Alt-click to merge.
     Override a chop's note, take chops out of the pool (Ctrl/Shift-click a pad) or keep pitched chops only.
   - The key is detected from the chops (Krumhansl profiles), and so is the **chord progression**. The pitched part
     of the sample is split into ~1.6 s windows, and each window is harmonised with the best-fitting diatonic chord
     (7ths when the melody implies them, harmonic-minor V when it uses the leading tone). That progression is
     the default. **FROM SAMPLE** brings it back, and **DETECT** re-runs both detections.
   - **One-shot keys:** a keyboard spanning the sample's range. Lit keys have chops at that note and play them
     untouched (round robin when there are several). Other keys play the nearest chop repitched. Use the mouse or
     A W S E D F T G Y H U J K O L P, with Z / X to shift the octave.
2. **Key + progression.** 12 keys × major / minor and **20 style presets**: Pop, Trap, Lo-Fi, R&B / Neo-Soul, Jazz,
   Gospel, House, Liquid DnB, Future Bass, EDM Anthem, Synthwave, Rock, Blues, Reggae, Bossa Nova, Funk,
   K-Pop / J-Pop, Cinematic, Afrobeats, Drill. Each preset sets tempo, swing, glitch amounts and pattern sets, and
   holds 6–13 progressions written as roman numerals (with 7ths, 9ths, 13ths, sus, dim, half-dim and borrowed
   chords), so they work in any key.
   - **NEW PROGRESSION** picks a random one from the style. ◀ ▶ step through your history.
   - Picking a style sets tempo, swing, patterns and progressions. It never turns glitch effects on.
   - **AUTO-CYCLE** swaps the progression every 1 / 2 / 4 loops. **ROAM STYLES** also jumps to a random style.
   - Click a chord to hear it voiced with your chops.
3. **Remix.** Chops are repitched (sampler style) onto voice-led chords, an arp / lead line over the chord tones,
   a bass line, and chop percussion built from the unpitched chops. Each layer has on/off, level, octave and
   pattern variants. Bass can be chops or a sine sub.
   - **Edit the remix:** click empty space in the roll to add a note on the DRAW layer (drag to stretch it), drag
     a note to move it in time or pitch, drag its right edge to stretch it, and right-click or Alt-click to delete.
     Snap is 1/8, 1/16, 1/32 or off (hold Shift to ignore it). Once edited, the loop is marked EDITED, and sliders
     and patterns stop regenerating it until you press **RESET EDITS**. Explicit actions (new progression, new
     groove, style, key) still start fresh.
4. **Glitch.** Stutter (2–8× retriggers, sometimes rising), reverse, scatter (octave jumps, mid-chop starts,
   random chop swaps, 32nd shoves), gate and end-of-loop tape stop. **EVOLVE** re-rolls the glitches every loop
   while the notes stay put. Chop pick: nearest pitch / random / cycle / one chop. HOLD loops a chop's body to
   sustain long notes. Crush to 12 / 8 / 6 bits and 22k / 11k / 6k.
5. **FX:** low-pass filter + resonance, 3/16 ping-pong delay, reverb, drive, volume.

**Export:** rendered WAV (1–8 loops), 3-track MIDI (chords / lead / bass), or a zip of every chop named by its note.

Keys: `Space` play/stop · `N` new progression · `Shift+G` glitch it · `R` new groove · `←/→` select chop · `A`–`P` one-shot keys · `Z/X` key octave.

## Build the exe

Uses only the C# compiler that ships with Windows (.NET Framework 4.x). The WebView2 SDK is fetched from NuGet on
the first build.

```
powershell -ExecutionPolicy Bypass -File desktop\build.ps1
```

Output: `dist\ChordChopper.exe` (about 1 MB). The web app is embedded and served from memory. Only the WebView2
loader DLL and the browser profile live in `%LOCALAPPDATA%\ChordChopper`.
