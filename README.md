# Chord Chopper

Load a music or vocal sample, let it chop the sample into notes, then remix those glitched-up chops onto
chord progressions in any key. It starts from the progression it hears in your sample. From there you can pick
one of 20 style presets and cycle through random progressions, or let it roam across styles on its own. Play
the found notes on a one-shot keyboard and draw your own notes into the remix. Runs fully offline.

Effects start at 0 so chops still sound like the sample, and chords are voiced around the sample's own pitch. What
is on by default is what lets it breathe: chops sustain instead of stopping short, chords fade in and out softly,
and the chords get a little reverb. CLEAR, or the sliders and HOLD, change any of that per layer.

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
   - **Change one chord at a time:** click a chord to hear it and open its editor. **TRY ANOTHER** swaps in a chord
     that fits between its neighbours, **FITS HERE** lists the best options, and ROOT, TYPE, BASS NOTE (slash chords)
     and LENGTH set it exactly. ADD AFTER and REMOVE change the chord count. Every other chord keeps its exact
     notes, chops and glitches. ◀ ▶ step back through your changes.
   - **NEW PROGRESSIONS USE** PLAIN, 7THS or LUSH adds colour to plain triads in the next progression.
3. **Remix.** Two layers: voice-led chords, and a bass line that can be chops, a clean sub, or both. Chops are
   repitched (sampler style). Each layer has on/off, level, octave and pattern variants; pattern 1 is one long note
   per chord and the others re-attack without leaving gaps.
   - **Voicing:** CLOSE, OPEN (drop 2) or WIDE (drop 2 + 4). Voicings follow the smoothest top note and avoid tight
     intervals down low.
   - **Sustain:** with HOLD on, a note longer than its chop loops the chop's body, with the loop tuned to the pitch
     and crossfaded so it doesn't click.
   - **Edit the remix:** click empty space in the roll to add a note on the DRAW layer (drag to stretch it), drag
     a note to move it in time or pitch, drag its right edge to stretch it, and right-click or Alt-click to delete.
     Snap is 1/8, 1/16, 1/32 or off (hold Shift to ignore it). You edit a layer's notes (outlines). The filled
     blocks are what plays after that layer's glitch, so glitch and FX keep working on top of your edits.
   - An edited layer is marked EDITED and keeps its notes when you change its pattern, until you press
     **RESET EDITS**. Explicit actions (new progression, new groove, style, key) still start fresh.
4. **Per-layer glitch + FX.** Pick a layer under **EDITING** (or click a layer's name). The GLITCH and FX panels
   then show and change that layer only, live while it plays. Every other layer keeps its exact notes and sound.
   **BOTH** sets both layers at once; settings that differ between layers are marked MIX. Layer rows show
   GLITCH / FX tags when they're off their defaults, and **CLEAR** puts the selected layer back to its defaults.
   - **Glitch:** stutter (2–8× retriggers, sometimes rising), reverse, scatter (octave jumps, mid-chop starts,
     random chop swaps, 32nd shoves), gate and end-of-loop tape stop. Each note keeps its own random draws, so
     raising a slider only adds glitches on top of the current pattern instead of reshuffling it.
   - **Chop pick** (nearest pitch / random / cycle / one chop) reassigns chops without moving any notes.
   - Crush goes to 12 / 8 / 6 bits and 22k / 11k / 6k.
   - **FX:** attack and release, low-pass filter + resonance, drive, and sends into a shared 3/16 ping-pong delay and reverb. Master
     volume is global.
   - **EVOLVE** re-rolls every layer's glitches each loop while the notes stay put. **GLITCH IT** / Shift+G
     randomises the selected layer(s).
   - Previews, chord auditions and the one-shot keys always play the clean sample.

**Export:** rendered WAV (1–8 loops), 2-track MIDI (chords / bass), or a zip of every chop named by its note.

Keys: `Space` play/stop · `N` new progression · `Shift+G` glitch the selected layer(s) · `R` new groove · `←/→` select chop · `A`–`P` one-shot keys · `Z/X` key octave.

## Build the exe

Uses only the C# compiler that ships with Windows (.NET Framework 4.x). The WebView2 SDK is fetched from NuGet on
the first build.

```
powershell -ExecutionPolicy Bypass -File desktop\build.ps1
```

Output: `dist\ChordChopper.exe` (about 1 MB). The web app is embedded and served from memory. Only the WebView2
loader DLL and the browser profile live in `%LOCALAPPDATA%\ChordChopper`.
