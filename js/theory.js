// Music theory: note names, roman-numeral chord parsing, voicing, and the 20 style presets.
// Progressions are roman numerals relative to the key's tonic (accidentals against the major
// scale, case = major/minor triad, suffix = extension). "ii7:2" lasts 2 beats instead of the
// style's default. Pattern strings are 16 steps per bar (16th notes), any whole number of bars:
//   chords  x = hit (X accent)  - = hold  . = rest
//   lead    0-9 = chord tone index (climbing through octaves)  r = random tone  - hold  . rest
//   bass    x = root  3 / 5 / 6 / 7 = that chord degree  o = octave  - hold  . rest
//   perc    k = low chop  s = mid chop  h = bright chop  (upper case = accent)  . rest
window.CC = window.CC || {};

(function (CC) {
  'use strict';

  const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  CC.NOTE_NAMES = SHARP;

  CC.useFlats = function (key, mode) {
    const major = mode === 'min' ? (key + 3) % 12 : key;
    return [5, 10, 3, 8, 1, 6].includes(major);
  };
  CC.pcName = function (pc, flats) { return (flats ? FLAT : SHARP)[((pc % 12) + 12) % 12]; };
  CC.midiName = function (m, flats) {
    const r = Math.round(m);
    return CC.pcName(r, flats) + (Math.floor(r / 12) - 1);
  };

  const DEG = { I: 0, II: 2, III: 4, IV: 5, V: 7, VI: 9, VII: 11 };
  const RX = /^([b#]?)(VII|VI|IV|V|III|II|I|vii|vi|iv|v|iii|ii|i)([^:]*)(?::([\d.]+))?$/;

  // intervals + display suffix for [suffix][minor?]
  function quality(suffix, minor) {
    const tri = minor ? [0, 3, 7] : [0, 4, 7];
    switch (suffix) {
      case '': return [tri, minor ? 'm' : ''];
      case '°': case 'dim': return [[0, 3, 6], '°'];
      case '°7': case 'dim7': return [[0, 3, 6, 9], '°7'];
      case 'ø': case 'ø7': case 'm7b5': return [[0, 3, 6, 10], 'm7♭5'];
      case '+': return [[0, 4, 8], '+'];
      case '7': return minor ? [[0, 3, 7, 10], 'm7'] : [[0, 4, 7, 10], '7'];
      case 'maj7': return minor ? [[0, 3, 7, 11], 'm(maj7)'] : [[0, 4, 7, 11], 'maj7'];
      case '9': return minor ? [[0, 3, 7, 10, 14], 'm9'] : [[0, 4, 7, 10, 14], '9'];
      case 'maj9': return [[0, 4, 7, 11, 14], 'maj9'];
      case 'add9': return [tri.concat(14), minor ? 'm(add9)' : 'add9'];
      case '6': return [tri.concat(9), minor ? 'm6' : '6'];
      case '11': return [minor ? [0, 3, 7, 10, 14, 17] : [0, 4, 7, 10, 14, 17], minor ? 'm11' : '11'];
      case '13': return [[0, 4, 7, 10, 14, 21], '13'];
      case 'sus2': return [[0, 2, 7], 'sus2'];
      case 'sus4': return [[0, 5, 7], 'sus4'];
      case '7sus4': return [[0, 5, 7, 10], '7sus4'];
      default: return [tri, minor ? 'm' : ''];
    }
  }

  // "bVImaj7:2" in A minor -> {roman, beats, root (pc), ints, name: "Fmaj7"}
  CC.parseChord = function (token, key, mode, defBeats) {
    const m = RX.exec(token.trim());
    if (!m) return null;
    const acc = m[1] === 'b' ? -1 : m[1] === '#' ? 1 : 0;
    const minor = m[2] === m[2].toLowerCase();
    const [ints, suf] = quality(m[3], minor);
    const root = (((key + DEG[m[2].toUpperCase()] + acc) % 12) + 12) % 12;
    return {
      roman: m[1].replace('b', '♭') + m[2] + m[3],
      beats: m[4] ? parseFloat(m[4]) : defBeats,
      root, ints,
      name: CC.pcName(root, CC.useFlats(key, mode)) + suf,
    };
  };

  CC.parseProg = function (str, key, mode, defBeats) {
    return str.split(/\s+/).filter(Boolean).map((t) => CC.parseChord(t, key, mode, defBeats)).filter(Boolean);
  };

  // At most 4 voices: drop the plain fifth first when extensions are present.
  CC.voiceInts = function (ints) {
    let v = ints.slice();
    if (v.length > 4 && v.includes(7)) v = v.filter((i) => i !== 7);
    if (v.length > 4) v = [v[0], v[1], v[2], v[v.length - 1]]; // root, 3rd, 7th, top extension
    return v.sort((a, b) => a - b);
  };

  // Voice leading: tries every inversion / octave placement around `base` and keeps the one
  // closest to the previous voicing (or nearest the base for the first chord).
  CC.voice = function (chord, base, prev) {
    const ints = CC.voiceInts(chord.ints);
    const n = ints.length;
    let best = null;
    for (let inv = 0; inv < n; inv++) {
      const notes = [];
      for (let i = 0; i < n; i++) {
        const k = (i + inv) % n;
        notes.push(chord.root + ints[k] + (k < inv ? 12 : 0));
      }
      for (let oct = -1; oct <= 8; oct++) {
        const v = notes.map((x) => x + oct * 12);
        if (v[0] < base - 5 || v[0] > base + 7) continue;
        let cost;
        if (prev && prev.length) {
          cost = 0;
          for (let i = 0; i < n; i++) cost += Math.abs(v[i] - prev[Math.min(i, prev.length - 1)]);
          cost += Math.abs(v[0] - base) * 0.15; // don't drift away from the register
        } else cost = Math.abs(v[0] - base) + inv * 2;
        if (!best || cost < best.cost) best = { cost, v };
      }
    }
    return best ? best.v : ints.map((i) => base + i);
  };

  // ---------- styles ----------
  const T = (s) => s.replace(/\s+/g, '');
  const style = (o) => {
    ['chords', 'lead', 'bass', 'perc'].forEach((k) => { o[k] = o[k].map(T); });
    return o;
  };

  CC.STYLES = [
    style({
      id: 'pop', name: 'Pop', bpm: 104, swing: 0, mode: 'maj', beats: 4,
      maj: ['I V vi IV', 'vi IV I V', 'I vi IV V', 'IV I V vi', 'I IV vi V', 'I V IV IV', 'I iii IV V', 'vi V IV V'],
      min: ['i bVI bIII bVII', 'i bVII bVI bVII', 'i iv bVI bVII', 'bVI bVII i i', 'i bIII bVII iv'],
      chords: ['x---x---x---x---', 'x--x--x-x--x--x-', 'x-------x-------', 'x.x.x.x.x.x.x.x.'],
      lead: ['0.1.2.1.0.1.2.4.', '2-1-0---4-2-1---', '0..2..4.2..1..0.', '4.2.0.2.4.2.0.r.'],
      bass: ['x-------x-------', 'x..x..x.x..x..x.', 'x...x...x...o.5.', 'x-x-x-x-x-x-x-x-'],
      perc: ['k...s...k...s...', 'k..ks...k.k.s...', 'k.h.s.h.k.h.s.h.'],
      glitch: { stutter: 0.15, reverse: 0.1, scatter: 0.1, gate: 0.8, tape: 0.1 },
    }),
    style({
      id: 'trap', name: 'Trap', bpm: 140, swing: 0, mode: 'min', beats: 4,
      maj: ['vi IV I V', 'I iii vi IV', 'IV V vi vi', 'vi V IV V'],
      min: ['i bVI bVII i', 'i iv bVI V', 'i bVI iv bVII', 'i bII i bVII', 'i bVI bIII bVII', 'i v bVI bVII'],
      chords: ['x---------------', 'x-------x--x----', 'x-----x-----x---', 'x..x..x.........'],
      lead: ['0.0.2.0.4.2.0...', '0-2-4---2-0-r---', '4.2.0.4.2.0.4.2.', '0...0.2.0...4.2.'],
      bass: ['x-------------x-', 'x---------x-----', 'x-----x-------x.', 'x-------x-x-----'],
      perc: ['k.......S.......', 'k......k..k.S...', 'k.h.h.h.S.hhh.h.', 'k.hhh.h.S.h.hhhh'],
      glitch: { stutter: 0.3, reverse: 0.15, scatter: 0.15, gate: 0.7, tape: 0.2 },
    }),
    style({
      id: 'lofi', name: 'Lo-Fi', bpm: 82, swing: 0.55, mode: 'maj', beats: 4,
      maj: ['Imaj7 vi7 ii7 V7', 'IVmaj7 iii7 ii7 Imaj7', 'ii9 V9 Imaj9 vi9', 'Imaj7 IVmaj7 iii7 vi7', 'IVmaj7 V7 iii7 vi7', 'Imaj9 iv7 iii7 vi7'],
      min: ['i9 iv9 bVIImaj7 bIIImaj7', 'i7 iv7 v7 i7', 'iiø V7 i9 i9', 'bVImaj7 v7 i9 i9', 'i7 bVII7 bVImaj7 V7'],
      chords: ['x-------x-------', 'x--x--------x---', 'x-----x---------', '..x-..x-..x-..x-'],
      lead: ['0..2..4..3..2...', '4.3.2.0.......r.', '..4..2..0..1..2.', '0-2-4-6-4-2-....'],
      bass: ['x-----5-x-------', 'x.....x...5.....', 'x---o---5---x---'],
      perc: ['k...s...k.k.s...', 'k..s..k.k..s....', 'k.h.s.h.hkh.s.h.'],
      glitch: { stutter: 0.1, reverse: 0.25, scatter: 0.15, gate: 0.9, tape: 0.25 },
    }),
    style({
      id: 'rnb', name: 'R&B / Neo-Soul', bpm: 88, swing: 0.4, mode: 'maj', beats: 4,
      maj: ['IVmaj7 iii7 ii9 Imaj9', 'ii9 V13 Imaj9 vi9', 'Imaj9 iii7 IVmaj9 iv7', 'vi9 ii9 V7sus4 Imaj9', 'IVmaj9 V9 iii7 vi9', 'Imaj7 bVII9 IVmaj7 iv7'],
      min: ['i9 iv9 bVImaj7 V7', 'i11 bVII9 bVImaj7 V7', 'iv9 v7 i9 i9', 'i9 bIIImaj7 bVImaj7 iiø'],
      chords: ['x-------x-------', 'x----x-------x--', '..x-----..x-----', 'x--x----x--x----'],
      lead: ['0.2.4.3.2...0.1.', '..4-3-2-..0-1-2-', '6.4.2.0.r...2.4.', '0--2--4-3--2--1-'],
      bass: ['x-----x-5-------', 'x.......x..5.o..', 'x---5---x-----3-'],
      perc: ['k...s...kk..s...', 'k..s..k...k.s..h', 'k.hhs.h.k.hhs.h.'],
      glitch: { stutter: 0.1, reverse: 0.15, scatter: 0.1, gate: 0.9, tape: 0.1 },
    }),
    style({
      id: 'jazz', name: 'Jazz', bpm: 120, swing: 0.6, mode: 'maj', beats: 4,
      maj: ['ii7 V7 Imaj7 Imaj7', 'Imaj7 vi7 ii7 V7', 'iii7:2 vi7:2 ii7:2 V7:2 Imaj7 Imaj7', 'Imaj7 VI7 ii7 V7', 'IVmaj7 iv7 iii7 VI7 ii7 V7 Imaj7 Imaj7', 'Imaj7 #i°7 ii7 V7'],
      min: ['iiø V7 i7 i7', 'i7 iv7 bVII7 bIIImaj7', 'i6 iiø:2 V7:2 i6 V7', 'i7 bVI7 iiø V7'],
      chords: ['x.....x.........', '..x...x..x....x.', 'x---..x-..x-....', 'x--x--x-x--x--x-'],
      lead: ['0.2.4.6.7.6.4.2.', '4.3.2.1.0...r.2.', '0.1.2.3.4.5.6.r.', '7.6.4.2.0.......'],
      bass: ['x...3...5...7...', 'x...5...o...5...', 'x...7...5...3...'],
      perc: ['h..hh..hh..hh..h', 'k...h..hs..hh..h'],
      glitch: { stutter: 0.1, reverse: 0.1, scatter: 0.1, gate: 0.75, tape: 0.05 },
    }),
    style({
      id: 'gospel', name: 'Gospel', bpm: 72, swing: 0.3, mode: 'maj', beats: 4,
      maj: ['I iii IV iv', 'IVmaj7 V7 iii7 vi7 ii7 V7 Imaj7 I7', 'I I7 IV iv I vi ii7 V7', 'IV V iii vi ii V I I', 'vi7 V7sus4 IVmaj7 I'],
      min: ['i iv7 bVII7 bIIImaj7 bVImaj7 iiø V7 i', 'i7 iv7 i7 V7', 'iv9 V7 i9 i9'],
      chords: ['x---------x-----', 'x--x--x---------', 'x-------x--x-x--'],
      lead: ['0-1-2-4-2-1-0---', '4..3..2...1.0...', '0.2.4.6.4.2.0.2.'],
      bass: ['x-------5---x---', 'x-----o-5-------', 'x..x....x..5.o..'],
      perc: ['k...s...k...s...', 'k..ss...k.k.s...'],
      glitch: { stutter: 0.1, reverse: 0.1, scatter: 0.05, gate: 0.9, tape: 0.05 },
    }),
    style({
      id: 'house', name: 'House', bpm: 124, swing: 0.1, mode: 'min', beats: 4,
      maj: ['Imaj7 vi7 ii7 V7', 'IVmaj7 V7 iii7 vi7', 'vi7 IVmaj7 Imaj7 V7', 'ii9 ii9 Imaj9 Imaj9'],
      min: ['i7 iv7 i7 iv7', 'i9 bVIImaj7 bVImaj7 bVII', 'i7 bIIImaj7 bVImaj7 bVII7', 'iv9 i9 iv9 v7'],
      chords: ['..x...x...x...x.', 'x..x..x...x..x..', '..x-..x-..x-..x-', 'x.x...x.x.x...x.'],
      lead: ['0.2.4.2.0.2.4.2.', '4.4.2.2.0.0.2.2.', '0..3..1..4..2..5', '0.1.2.3.4.5.6.7.'],
      bass: ['..x...x...x...x.', 'x.x.x.x.x.x.x.x.', '..o...o...o...o.', 'x..x..x.o..x..5.'],
      perc: ['k...k...k...k...', 'k.h.k.h.k.h.k.h.', 'k.hsk.h.k.hsk.hh'],
      glitch: { stutter: 0.2, reverse: 0.1, scatter: 0.15, gate: 0.6, tape: 0.05 },
    }),
    style({
      id: 'liquid', name: 'Liquid DnB', bpm: 174, swing: 0, mode: 'min', beats: 4,
      maj: ['IVmaj7 V iii7 vi7', 'Imaj9 iii7 vi9 IVmaj7', 'vi9 IVmaj7 Imaj7 V', 'IVmaj7 Imaj7 vi9 V7sus4'],
      min: ['i9 bVImaj7 bIIImaj7 bVII', 'i7 iv7 bVIImaj7 bIIImaj7', 'bVImaj7 bVII i9 i9', 'i9 v7 bVImaj7 bVII'],
      chords: ['x---------------', 'x-------x-------', 'x---------x-----', 'x.....x-----x---'],
      lead: ['0.2.4.6.4.2.0.2.', '0...4...2...6...', '0.1.2.4.2.1.0.r.', '4---2---0-1-2---'],
      bass: ['x---------x-----', 'x-----x---------', 'x.......o.....5.'],
      perc: ['k...S.....k.S...', 'k...S..k..k.S...', 'k.h.S.h.h.k.S.h.'],
      glitch: { stutter: 0.25, reverse: 0.2, scatter: 0.15, gate: 0.8, tape: 0.1 },
    }),
    style({
      id: 'future', name: 'Future Bass', bpm: 150, swing: 0, mode: 'maj', beats: 4,
      maj: ['IVmaj7 V7 iii7 vi', 'vi IV I V', 'IVmaj9 V iii7 vi7', 'I V vi iii IV I IV V', 'IVmaj7 Imaj7 V vi'],
      min: ['i bVI bIII bVII', 'bVImaj7 bVII i9 i9', 'i iv bVI bVII'],
      chords: ['x--x--x-x--x--x-', 'x---------------', 'x.x.x.x.x.x.x.x.', 'x--x--x---x--x--'],
      lead: ['0.2.4.6.7.6.4.2.', '4-4-2-2-0-0-r---', '0.4.2.6.0.4.2.6.', '6.4.2.0.6.4.2.0.'],
      bass: ['x-----------x---', 'x--x--x-x--x--x-', 'x-------x-------'],
      perc: ['k.......S.......', 'k......k..k.S...', 'k.h.h.h.S.h.h.hh'],
      glitch: { stutter: 0.4, reverse: 0.2, scatter: 0.25, gate: 0.7, tape: 0.15 },
    }),
    style({
      id: 'edm', name: 'EDM Anthem', bpm: 128, swing: 0, mode: 'maj', beats: 4,
      maj: ['vi IV I V', 'I V vi IV', 'IV V vi vi', 'vi IV V I', 'I V vi iii IV I IV V'],
      min: ['i bVI bIII bVII', 'i bVII bVI bVII', 'bVI bVII i i', 'i bVI bVII bVII'],
      chords: ['..x...x...x...x.', 'x.x.x.x.x.x.x.x.', 'x--x--x---x--x--', 'x---x---x---x---'],
      lead: ['0.2.4.2.0.2.4.2.', '4.2.0.2.4.2.0.2.', '0..2..4.6..4..2.', '0.0.2.2.4.4.2.2.'],
      bass: ['..x...x...x...x.', 'x.x.x.x.x.x.x.x.', 'xoxoxoxoxoxoxoxo'],
      perc: ['k...k...k...k...', 'k.h.k.h.k.h.k.h.', 'k...k.s.k...k.s.'],
      glitch: { stutter: 0.3, reverse: 0.1, scatter: 0.15, gate: 0.6, tape: 0.1 },
    }),
    style({
      id: 'synthwave', name: 'Synthwave', bpm: 100, swing: 0, mode: 'min', beats: 4,
      maj: ['I bVII IV I', 'vi IV I V', 'I V vi IV', 'IV V I I'],
      min: ['i bVI bIII bVII', 'i bVII bVI bVII', 'i iv bVI bVII', 'bVI bVII i i', 'i bVI iv V'],
      chords: ['x-------x-------', 'x---------------', 'x--x--x-x--x--x-'],
      lead: ['0.2.4.2.0.2.4.2.', '0.1.2.3.2.1.0.2.', '4-------2---0---'],
      bass: ['x.o.x.o.x.o.x.o.', 'x.x.x.x.x.x.x.x.', 'xxxxxxxxxxxxxxxx'],
      perc: ['k...S...k...S...', 'k...S...k.k.S...'],
      glitch: { stutter: 0.15, reverse: 0.15, scatter: 0.1, gate: 0.7, tape: 0.15 },
    }),
    style({
      id: 'rock', name: 'Rock', bpm: 120, swing: 0, mode: 'maj', beats: 4,
      maj: ['I bVII IV I', 'I IV V IV', 'I V vi IV', 'I bIII IV I', 'I IV I V'],
      min: ['i bVII bVI bVII', 'i bIII bVII IV', 'i bVI bIII bVII', 'i iv i V'],
      chords: ['x-x-x-x-x-x-x-x-', 'x---x---x---x---', 'x--x--x-x--x--x-', 'x-------x-x-x---'],
      lead: ['0.0.1.2.1.0.2.r.', '0---2---4---2---', '4.4.2.2.0.0.1.2.'],
      bass: ['x.x.x.x.x.x.x.x.', 'x---x---x---5---', 'x.xxx.x.x.x.o.5.'],
      perc: ['k...S...k.k.S...', 'k.h.S.h.k.k.S.h.', 'k.k.S...k.k.S...'],
      glitch: { stutter: 0.1, reverse: 0.1, scatter: 0.1, gate: 0.75, tape: 0.1 },
    }),
    style({
      id: 'blues', name: 'Blues', bpm: 96, swing: 0.6, mode: 'maj', beats: 4,
      maj: ['I7 I7 I7 I7 IV7 IV7 I7 I7 V7 IV7 I7 V7', 'I7 IV7 I7 I7 IV7 IV7 I7 I7 V7 IV7 I7 V7', 'I7 IV7 I7 V7'],
      min: ['i7 i7 i7 i7 iv7 iv7 i7 i7 bVI7 V7 i7 V7', 'i7 iv7 i7 V7', 'i7 iv7 bVI7 V7'],
      chords: ['x.x.x.x.x.x.x.x.', '..x...x...x...x.', 'x--x--x---x--x--'],
      lead: ['0.1.2.3.4.3.2.1.', '4...3.2.0...r...', '0..2..0.3.2.0...'],
      bass: ['x.3.5.6.o.6.5.3.', 'x...5...o...5...', 'x...3...5...7...'],
      perc: ['k.h.s.h.k.h.s.h.', 'k..hs..hk..hs..h'],
      glitch: { stutter: 0.1, reverse: 0.1, scatter: 0.1, gate: 0.8, tape: 0.05 },
    }),
    style({
      id: 'reggae', name: 'Reggae', bpm: 74, swing: 0.2, mode: 'maj', beats: 4,
      maj: ['I IV I V', 'I V vi IV', 'I vi IV V', 'ii V I I', 'I iii IV V'],
      min: ['i bVII i bVII', 'i iv i iv', 'i bVII bVI bVII', 'i iv bVII i'],
      chords: ['....x.......x...', '..x...x...x...x.', '..x.x...x.x...x.'],
      lead: ['0...2...4...2...', '4.2.0...2.0.....', '0.2.4.r.........'],
      bass: ['x.....x.x.......', 'x..x....5..x....', 'x-----5-o---5---'],
      perc: ['....h...K...h...', 'h.h.h.h.K.h.h.h.', '....s...K...s...'],
      glitch: { stutter: 0.1, reverse: 0.2, scatter: 0.1, gate: 0.7, tape: 0.1 },
    }),
    style({
      id: 'bossa', name: 'Bossa Nova', bpm: 130, swing: 0.1, mode: 'maj', beats: 4,
      maj: ['Imaj7 II7 ii7 V7', 'Imaj7 vi7 ii7 V7', 'ii9 V13 Imaj9 VI7', 'Imaj7 bIImaj7 Imaj7 bIImaj7', 'IVmaj7 iv6 iii7 VI7 ii7 V7 Imaj7 Imaj7'],
      min: ['i6 iiø V7 i6', 'i7 iv7 bVII7 bIIImaj7 bVImaj7 iiø V7 i7', 'i7 iv7 i7 V7'],
      chords: ['x..x..x...x..x..', 'x..x...x..x..x..', 'x--x--x---x-x---'],
      lead: ['0.2.4.2.6.4.2.0.', '..4-3-2-..1-0-..', '0..2..4...6..4..'],
      bass: ['x.....5.x.....5.', 'x..5....x..5....'],
      perc: ['k..s..k...s..s..', 'h.hhh.hhh.hhh.hh', 'k.hsh.hkk.hsh.hh'],
      glitch: { stutter: 0.1, reverse: 0.1, scatter: 0.1, gate: 0.8, tape: 0.05 },
    }),
    style({
      id: 'funk', name: 'Funk', bpm: 108, swing: 0.15, mode: 'min', beats: 4,
      maj: ['I7 I7 IV7 IV7', 'I9 IV9 I9 V9', 'I7 bVII7 IV7 I7', 'I7 IV7 I7 V7'],
      min: ['i7 i7 IV7 IV7', 'i9 IV9 i9 IV9', 'i7 bVII7 i7 bVII7', 'i7 iv7 bVII7 bIII'],
      chords: ['.x.x..x..x.x..x.', 'x..x.x..x..x.x..', '..x...x.x.x...x.', 'x.xx.x.xx.x.x.xx'],
      lead: ['0.0.2.0.r.0.2.4.', '0..0..2.4.2.0...', '4.2.4.2.0.2.0.2.'],
      bass: ['x..o..x.5.x..o..', 'x.xo..x..5x.o...', 'x...o.x.x..5.o.x'],
      perc: ['k..kS..kk.k.S..h', 'k.hkS.h.k.hkS.hk', 'k..k.S..k.kk.S..'],
      glitch: { stutter: 0.15, reverse: 0.1, scatter: 0.15, gate: 0.5, tape: 0.05 },
    }),
    style({
      id: 'kpop', name: 'K-Pop / J-Pop', bpm: 120, swing: 0, mode: 'maj', beats: 4,
      maj: ['IVmaj7 V7 iii7 vi', 'I V vi iii IV I IV V', 'vi IV V I', 'IVmaj7 V iii7 vi IVmaj7 V I I', 'ii7 V7 iii7 vi7'],
      min: ['i bVI bVII i', 'bVImaj7 bVII7 i i', 'i iv bVII bIIImaj7', 'i bVI bIII bVII'],
      chords: ['x---x---x---x---', 'x--x--x-x--x--x-', '..x...x...x...x.', 'x.x.x.x.x.x.x.x.'],
      lead: ['0.2.4.2.6.4.2.4.', '4-2-0-2-4-6-4---', '0.1.2.0.1.2.4.2.'],
      bass: ['x.x.x.x.x.x.x.x.', 'x..x..x.x..x..x.', 'xoxoxoxoxoxoxoxo'],
      perc: ['k...S...k...S...', 'k.hhS.h.k.hhS.hh', 'k..kS...k.k.S...'],
      glitch: { stutter: 0.2, reverse: 0.1, scatter: 0.15, gate: 0.7, tape: 0.1 },
    }),
    style({
      id: 'cinematic', name: 'Cinematic', bpm: 90, swing: 0, mode: 'min', beats: 4,
      maj: ['I bVI bVII I', 'I iii IV iv', 'I V vi IV', 'IV I V vi'],
      min: ['i bVI bIII bVII', 'i bVI iv V', 'bVI bVII i i', 'i bIII bVII IV', 'i bVI bVII V'],
      chords: ['x---------------', 'x-------x-------', 'x-----------x---'],
      lead: ['0...1...2...4...', '4-------2---0---', '0.2.4.6.4.2.0.2.'],
      bass: ['x---------------', 'x-------x-------', 'x.......o.......'],
      perc: ['K.......k.......', 'K.....k...k.....', 'k...S...k.k.S...'],
      glitch: { stutter: 0.1, reverse: 0.3, scatter: 0.1, gate: 0.95, tape: 0.2 },
    }),
    style({
      id: 'afro', name: 'Afrobeats', bpm: 106, swing: 0.1, mode: 'maj', beats: 4,
      maj: ['vi IV I V', 'ii V I I', 'IV V vi vi', 'I IV vi V', 'ii7 V7 Imaj7 Imaj7'],
      min: ['i iv bVII bIII', 'i bVII bVI bVII', 'i iv i bVII', 'iv v i i'],
      chords: ['x..x..x...x.x...', '..x..x..x..x..x.', 'x..x..x.x..x..x.'],
      lead: ['0..2..4.2..0..2.', '4.2.0..2.4.2.0..', '0.2..4.2..0.r...'],
      bass: ['x..x....x.x.....', 'x...x..x..x.....', 'x..5..o.x..5....'],
      perc: ['k..s..k.k..s..k.', 'k..h..s.h.k.s..h', 'k.hsk.h.k.hsk.hh'],
      glitch: { stutter: 0.15, reverse: 0.1, scatter: 0.15, gate: 0.7, tape: 0.1 },
    }),
    style({
      id: 'drill', name: 'Drill', bpm: 142, swing: 0, mode: 'min', beats: 4,
      maj: ['vi IV ii III', 'vi V IV III', 'vi ii III vi'],
      min: ['i bVI V7 i', 'i iv V7 i', 'i bVI bII V7', 'i bII i bVI', 'i bVI iv V'],
      chords: ['x---------------', 'x-------x-------', 'x-----x---x-----'],
      lead: ['0..1..2.0..1..r.', '4.2.0.4.2.0...2.', '0...2.0...r.4...'],
      bass: ['x.....x...x-----', 'x---------x..x..', 'x-----x-------x.'],
      perc: ['k.....k.S.....h.', 'k..hh..kS..k..h.', 'k.h..hk.S.h.hk..'],
      glitch: { stutter: 0.35, reverse: 0.2, scatter: 0.2, gate: 0.6, tape: 0.2 },
    }),
  ];
  CC.styleById = (id) => CC.STYLES.find((s) => s.id === id) || CC.STYLES[0];
})(window.CC);
