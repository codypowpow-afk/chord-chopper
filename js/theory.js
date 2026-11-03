// Music theory: note names, roman-numeral chord parsing, voicing, and the 20 style presets.
// Progressions are roman numerals relative to the key's tonic (accidentals against the major
// scale, case = major/minor triad, suffix = extension). "ii7:2" lasts 2 beats instead of the
// style's default. Pattern strings are 16 steps per bar (16th notes), any whole number of bars:
//   chords  x = hit (X accent)  - = hold  . = rest
//   bass    x = root (or the chord's slash note)  3 / 5 / 6 / 7 = that chord degree  o = octave  - hold  . rest
// A pattern of only holds plays one long note per chord. "IVmaj7/3" puts the 3rd in the bass.
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
  const RX = /^([b#]?)(VII|VI|IV|V|III|II|I|vii|vi|iv|v|iii|ii|i)([^:/]*)(?:\/(\d))?(?::([\d.]+))?$/;

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

  // Semitones above the root for a slash degree (3, 5 or 7), using the chord's own tones.
  function slashInt(deg, ints) {
    const find = (opts, dflt) => { const v = ints.find((i) => opts.includes(i % 12)); return v == null ? dflt : v % 12; };
    if (deg === 3) return find([3, 4], 4);
    if (deg === 5) return find([7, 6, 8], 7);
    if (deg === 7) return find([10, 11, 9], 10);
    return 0;
  }

  // "bVImaj7:2" in A minor -> {token, roman, beats, root (pc), ints, deg, bassOff, name: "Fmaj7"}
  CC.parseChord = function (token, key, mode, defBeats) {
    const m = RX.exec(token.trim());
    if (!m) return null;
    const acc = m[1] === 'b' ? -1 : m[1] === '#' ? 1 : 0;
    const minor = m[2] === m[2].toLowerCase();
    const [ints, suf] = quality(m[3], minor);
    const root = (((key + DEG[m[2].toUpperCase()] + acc) % 12) + 12) % 12;
    const flats = CC.useFlats(key, mode);
    const deg = m[4] ? parseInt(m[4], 10) : 0, bassOff = slashInt(deg, ints);
    return {
      token: token.trim(), deg, bassOff,
      roman: m[1].replace('b', '♭') + m[2] + m[3] + (deg ? '/' + deg : ''),
      beats: m[5] ? parseFloat(m[5]) : defBeats,
      root, ints,
      name: CC.pcName(root, flats) + suf + (deg ? '/' + CC.pcName(root + bassOff, flats) : ''),
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

  // Voice leading: tries every inversion / octave placement around `base`, shaped close, open
  // (drop 2) or wide (drop 2 + 4), and keeps the one nearest the previous voicing with the smoothest
  // top note. Tight intervals low down are penalised because they turn to mud.
  CC.voice = function (chord, base, prev, mode) {
    let ints = CC.voiceInts(chord.ints);
    if (mode !== 'close' && ints.length === 3) ints = ints.concat(12); // triads double the root on top
    const n = ints.length, centre = base + 5;
    let best = null;
    for (let inv = 0; inv < n; inv++) {
      const stack = [];
      for (let i = 0; i < n; i++) {
        const k = (i + inv) % n;
        stack.push(chord.root + ints[k] + (k < inv ? 12 : 0));
      }
      stack.sort((a, b) => a - b);
      if (n >= 4 && mode !== 'close') stack[n - 2] -= 12;
      if (n >= 4 && mode === 'wide') stack[n - 4] -= 12;
      stack.sort((a, b) => a - b);
      for (let oct = -1; oct <= 8; oct++) {
        const v = stack.map((x) => x + oct * 12);
        const mean = v.reduce((a, b) => a + b, 0) / n;
        if (Math.abs(mean - centre) > 7) continue;
        let cost = Math.abs(mean - centre) * 0.15;
        if (prev && prev.length) {
          for (let i = 0; i < n; i++) cost += Math.abs(v[i] - prev[Math.min(i, prev.length - 1)]);
          cost += Math.abs(v[n - 1] - prev[prev.length - 1]);
        } else cost += Math.abs(mean - centre) + inv * 2;
        for (let i = 0; i + 1 < n; i++) if (v[i] < 52 && v[i + 1] - v[i] <= 4) cost += 5;
        if (!best || cost < best.cost) best = { cost, v };
      }
    }
    return best ? best.v : ints.map((i) => base + i);
  };

  // ---------- editing single chords ----------
  // A token is "<numeral><suffix>[/slash][:beats]".
  CC.splitToken = function (tok) {
    const m = RX.exec(tok.trim());
    if (!m) return null;
    return { acc: m[1], num: m[2], suffix: m[3], deg: m[4] ? parseInt(m[4], 10) : 0, beats: m[5] ? parseFloat(m[5]) : null };
  };
  CC.joinToken = (p) => p.acc + p.num + p.suffix + (p.deg ? '/' + p.deg : '') + (p.beats ? ':' + p.beats : '');
  // [label, suffix, minor numeral]
  CC.TYPES = [
    ['maj', '', 0], ['m', '', 1], ['7', '7', 0], ['m7', '7', 1], ['maj7', 'maj7', 0], ['9', '9', 0], ['m9', '9', 1],
    ['maj9', 'maj9', 0], ['add9', 'add9', 0], ['m add9', 'add9', 1], ['6', '6', 0], ['m6', '6', 1], ['m11', '11', 1],
    ['13', '13', 0], ['sus2', 'sus2', 0], ['sus4', 'sus4', 0], ['7sus4', '7sus4', 0], ['dim', '°', 1], ['dim7', '°7', 1],
    ['m7♭5', 'ø', 1], ['aug', '+', 0],
  ];
  CC.typeOf = function (p) {
    const minor = p.num === p.num.toLowerCase() ? 1 : 0;
    return CC.TYPES.findIndex((ty) => ty[1] === p.suffix && ty[2] === minor);
  };
  // Key-relative root (0-11) + type index -> parts of a token.
  CC.partsFor = function (rel, typeIdx) {
    const ty = CC.TYPES[typeIdx];
    const name = ROOT_NAME[((rel % 12) + 12) % 12];
    const acc = name[0] === 'b' ? 'b' : '', base = acc ? name.slice(1) : name;
    return { acc, num: ty[2] ? base.toLowerCase() : base, suffix: ty[1], deg: 0, beats: null };
  };

  // Adds colour to plain triads in a progression. Chords that already have an extension, plus
  // diminished chords, are left alone.
  const MAJ7_ROOTS = { maj: [0, 5], min: [3, 8] };
  CC.colorize = function (tok, mode, color) {
    if (color === 'plain') return tok;
    const p = CC.splitToken(tok);
    if (!p || p.suffix) return tok;
    const rel = ((DEG[p.num.toUpperCase()] + (p.acc === 'b' ? -1 : p.acc === '#' ? 1 : 0)) % 12 + 12) % 12;
    const lush = color === 'lush';
    if (p.num === p.num.toLowerCase()) p.suffix = lush ? '9' : '7';
    else if (MAJ7_ROOTS[mode].includes(rel)) p.suffix = lush ? 'maj9' : 'maj7';
    else if (rel === 7) p.suffix = lush ? '9' : '7';
    else p.suffix = lush ? 'add9' : '7';
    return CC.joinToken(p);
  };
  CC.colorizeProg = (str, mode, color) => str.split(/\s+/).filter(Boolean).map((tk) => CC.colorize(tk, mode, color)).join(' ');

  // Chords that fit between two neighbours, best first: how often the style's progressions move
  // prev -> chord and chord -> next, plus how common the chord is. Diatonic chords are always in.
  const DIATONIC = { maj: ['I', 'ii', 'iii', 'IV', 'V', 'vi'], min: ['i', 'iv', 'v', 'bIII', 'bVI', 'bVII'] };
  CC.chordOptions = function (st, mode, prev, cur, next, color) {
    const bare = (tk) => { const p = CC.splitToken(tk); p.deg = 0; p.beats = null; return CC.joinToken(p); };
    const degOf = (tk) => { const p = CC.splitToken(tk); return p.acc + p.num; };
    const pool = st[mode].length ? st[mode] : st[mode === 'maj' ? 'min' : 'maj'];
    const after = {}, freq = {}, cands = {};
    const add = (tk, w) => { const c = bare(CC.colorize(tk, mode, color)); cands[c] = true; freq[c] = (freq[c] || 0) + w; };
    pool.forEach((pr) => {
      const toks = pr.split(/\s+/);
      toks.forEach((tk, i) => {
        add(tk, 1);
        const k = degOf(tk) + '>' + degOf(toks[(i + 1) % toks.length]);
        after[k] = (after[k] || 0) + 1;
      });
    });
    DIATONIC[mode].forEach((tk) => add(tk, 0.5));
    const curBare = bare(cur);
    return Object.keys(cands).filter((c) => c !== curBare).map((c) => ({
      tok: c,
      score: freq[c] * 0.5 + 3 * (after[degOf(prev) + '>' + degOf(c)] || 0) + 3 * (after[degOf(c) + '>' + degOf(next)] || 0),
    })).sort((a, b) => b.score - a.score);
  };

  // ---------- progression detection ----------
  // Splits the pitched part of the sample into ~1.6 s windows (2-8 of them), builds a pitch-class
  // histogram per window (chop overlap x confidence) and harmonises it with the best-fitting
  // diatonic chord: root / third / fifth reward, other notes penalise, a strong diatonic 7th adds
  // a 7th. Repeated chords merge into one longer chord. Returns roman numerals ("vi IV:8 V").
  const ROOT_NAME = { 0: 'I', 1: 'bII', 2: 'II', 3: 'bIII', 4: 'III', 5: 'IV', 6: 'bV', 7: 'V', 8: 'bVI', 9: 'VI', 10: 'bVII', 11: 'VII' };
  CC.detectProg = function (chops, key, mode, sampleRate) {
    const pcOf = (c) => ((Math.round(c.note != null ? c.note : c.midi) - key) % 12 + 12) % 12;
    const pitched = chops.filter((c) => c.pitched || c.note != null);
    if (!pitched.length) return '';
    const a = Math.min(...pitched.map((c) => c.start)), b = Math.max(...pitched.map((c) => c.end));
    const n = Math.max(1, Math.min(8, Math.round((b - a) / sampleRate / 1.6)));
    const scale = mode === 'min' ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
    const all = new Array(12).fill(0);
    const hists = [];
    for (let k = 0; k < n; k++) {
      const ws = a + ((b - a) * k) / n, we = a + ((b - a) * (k + 1)) / n, h = new Array(12).fill(0);
      pitched.forEach((c) => {
        const ov = Math.min(c.end, we) - Math.max(c.start, ws);
        if (ov > 0) { h[pcOf(c)] += ov * (0.3 + c.conf); all[pcOf(c)] += ov * (0.3 + c.conf); }
      });
      hists.push(h);
    }
    // minor with a raised 7th in the melody -> harmonic-minor V
    const raisedV = mode === 'min' && all[11] > all[10];
    const chordFor = (d) => {
      const r = scale[d], third = scale[(d + 2) % 7], fifth = scale[(d + 4) % 7], sev = scale[(d + 6) % 7];
      const iv = (x) => (x - r + 12) % 12;
      let i3 = iv(third);
      if (raisedV && d === 4) i3 = 4;
      const tones = [r, (r + i3) % 12, fifth];
      return { d, r, i3, i5: iv(fifth), i7: iv(sev), tones, sev };
    };
    const chords = scale.map((_, d) => chordFor(d));
    const tokens = [];
    let prev = null;
    hists.forEach((h, k) => {
      const tot = h.reduce((x, y) => x + y, 0);
      if (!tot) { tokens.push(prev || (mode === 'min' ? 'i' : 'I')); return; }
      let best = null;
      chords.forEach((c) => {
        let s = h[c.tones[0]] * 1.0 + h[c.tones[1]] * 0.9 + h[c.tones[2]] * 0.7;
        for (let p = 0; p < 12; p++) if (!c.tones.includes(p) && p !== c.sev) s -= h[p] * 0.35;
        if (c.d === 0) s += tot * (k === 0 ? 0.15 : 0.05);
        if (c.i5 === 6) s -= tot * 0.15; // diminished chords only when clearly implied
        if (!best || s > best.s) best = { s, c };
      });
      const c = best.c;
      const minor = c.i3 === 3, dim = c.i5 === 6;
      let tok = ROOT_NAME[c.r];
      if (minor || dim) tok = tok.toLowerCase();
      const seventh = h[c.sev] > 0.5 * h[c.r] && h[c.sev] > 0.15 * tot;
      if (dim) tok += seventh ? (c.i7 === 10 ? 'ø' : '°7') : '°';
      else if (seventh) tok += c.i7 === 11 ? 'maj7' : '7';
      tokens.push(tok);
      prev = tok;
    });
    const out = [];
    tokens.forEach((t) => {
      const last = out[out.length - 1];
      if (last && last.t === t) last.n++;
      else out.push({ t, n: 1 });
    });
    return out.map((o) => (o.n > 1 ? `${o.t}:${o.n * 4}` : o.t)).join(' ');
  };

  // ---------- styles ----------
  const T = (s) => s.replace(/\s+/g, '');
  const style = (o) => {
    ['chords', 'bass'].forEach((k) => { o[k] = o[k].map(T); });
    return o;
  };
  // Pattern 1 of every set is one long note per chord. The rest re-attack softly but never leave gaps.
  const ONE = '----------------';
  const CH_PAD = [ONE, 'x-------x-------', 'x-----------x---', 'x-----x---x-----'];
  const CH_SWELL = [ONE, 'x---------x-----', 'x-----x---------', 'x-------x---x---'];
  const CH_PUSH = [ONE, 'x-----x-----x---', 'x--x-----x------', 'x--x--x---x-----'];
  const BS_ROOT = [ONE, 'x-------5-------', 'x-----------5---', 'x-----x---------'];
  const BS_MOVE = [ONE, 'x-------5---o---', 'x-----5-o-------', 'x---3---5---7---'];
  const BS_WALK = ['x---3---5---7---', ONE, 'x---5---o---5---'];
  const BS_LATIN = [ONE, 'x-----5-x-----5-', 'x--5----x--5----'];

  CC.STYLES = [
    style({
      id: 'pop', name: 'Pop', bpm: 104, swing: 0, mode: 'maj', beats: 4,
      maj: ['I V vi IV', 'vi IV I V', 'I vi IV V', 'IV I V vi', 'I IV vi V', 'I V IV IV', 'I iii IV V', 'vi V IV V'],
      min: ['i bVI bIII bVII', 'i bVII bVI bVII', 'i iv bVI bVII', 'bVI bVII i i', 'i bIII bVII iv'],
      chords: CH_PAD,
      bass: BS_ROOT,
    }),
    style({
      id: 'trap', name: 'Trap', bpm: 140, swing: 0, mode: 'min', beats: 8,
      maj: ['vi IV I V', 'I iii vi IV', 'IV V vi vi', 'vi V IV V'],
      min: ['i bVI bVII i', 'i iv bVI V', 'i bVI iv bVII', 'i bII i bVII', 'i bVI bIII bVII', 'i v bVI bVII'],
      chords: CH_SWELL,
      bass: BS_ROOT,
    }),
    style({
      id: 'lofi', name: 'Lo-Fi', bpm: 82, swing: 0.55, mode: 'maj', beats: 4,
      maj: ['Imaj7 vi7 ii7 V7', 'IVmaj7 iii7 ii7 Imaj7', 'ii9 V9 Imaj9 vi9', 'Imaj7 IVmaj7 iii7 vi7', 'IVmaj7 V7 iii7 vi7', 'Imaj9 iv7 iii7 vi7'],
      min: ['i9 iv9 bVIImaj7 bIIImaj7', 'i7 iv7 v7 i7', 'iiø V7 i9 i9', 'bVImaj7 v7 i9 i9', 'i7 bVII7 bVImaj7 V7'],
      chords: CH_PAD,
      bass: BS_ROOT,
    }),
    style({
      id: 'rnb', name: 'R&B / Neo-Soul', bpm: 88, swing: 0.4, mode: 'maj', beats: 4,
      maj: ['IVmaj7 iii7 ii9 Imaj9', 'ii9 V13 Imaj9 vi9', 'Imaj9 iii7 IVmaj9 iv7', 'vi9 ii9 V7sus4 Imaj9', 'IVmaj9 V9 iii7 vi9', 'Imaj7 bVII9 IVmaj7 iv7'],
      min: ['i9 iv9 bVImaj7 V7', 'i11 bVII9 bVImaj7 V7', 'iv9 v7 i9 i9', 'i9 bIIImaj7 bVImaj7 iiø'],
      chords: CH_SWELL,
      bass: BS_MOVE,
    }),
    style({
      id: 'jazz', name: 'Jazz', bpm: 120, swing: 0.6, mode: 'maj', beats: 4,
      maj: ['ii7 V7 Imaj7 Imaj7', 'Imaj7 vi7 ii7 V7', 'iii7:2 vi7:2 ii7:2 V7:2 Imaj7 Imaj7', 'Imaj7 VI7 ii7 V7', 'IVmaj7 iv7 iii7 VI7 ii7 V7 Imaj7 Imaj7', 'Imaj7 #i°7 ii7 V7'],
      min: ['iiø V7 i7 i7', 'i7 iv7 bVII7 bIIImaj7', 'i6 iiø:2 V7:2 i6 V7', 'i7 bVI7 iiø V7'],
      chords: CH_PUSH,
      bass: BS_WALK,
    }),
    style({
      id: 'gospel', name: 'Gospel', bpm: 72, swing: 0.3, mode: 'maj', beats: 4,
      maj: ['I iii IV iv', 'IVmaj7 V7 iii7 vi7 ii7 V7 Imaj7 I7', 'I I7 IV iv I vi ii7 V7', 'IV V iii vi ii V I I', 'vi7 V7sus4 IVmaj7 I'],
      min: ['i iv7 bVII7 bIIImaj7 bVImaj7 iiø V7 i', 'i7 iv7 i7 V7', 'iv9 V7 i9 i9'],
      chords: CH_PAD,
      bass: BS_MOVE,
    }),
    style({
      id: 'house', name: 'House', bpm: 124, swing: 0.1, mode: 'min', beats: 8,
      maj: ['Imaj7 vi7 ii7 V7', 'IVmaj7 V7 iii7 vi7', 'vi7 IVmaj7 Imaj7 V7', 'ii9 ii9 Imaj9 Imaj9'],
      min: ['i7 iv7 i7 iv7', 'i9 bVIImaj7 bVImaj7 bVII', 'i7 bIIImaj7 bVImaj7 bVII7', 'iv9 i9 iv9 v7'],
      chords: CH_PUSH,
      bass: BS_ROOT,
    }),
    style({
      id: 'liquid', name: 'Liquid DnB', bpm: 174, swing: 0, mode: 'min', beats: 8,
      maj: ['IVmaj7 V iii7 vi7', 'Imaj9 iii7 vi9 IVmaj7', 'vi9 IVmaj7 Imaj7 V', 'IVmaj7 Imaj7 vi9 V7sus4'],
      min: ['i9 bVImaj7 bIIImaj7 bVII', 'i7 iv7 bVIImaj7 bIIImaj7', 'bVImaj7 bVII i9 i9', 'i9 v7 bVImaj7 bVII'],
      chords: CH_PAD,
      bass: BS_ROOT,
    }),
    style({
      id: 'future', name: 'Future Bass', bpm: 150, swing: 0, mode: 'maj', beats: 8,
      maj: ['IVmaj7 V7 iii7 vi', 'vi IV I V', 'IVmaj9 V iii7 vi7', 'I V vi iii IV I IV V', 'IVmaj7 Imaj7 V vi'],
      min: ['i bVI bIII bVII', 'bVImaj7 bVII i9 i9', 'i iv bVI bVII'],
      chords: CH_SWELL,
      bass: BS_ROOT,
    }),
    style({
      id: 'edm', name: 'EDM Anthem', bpm: 128, swing: 0, mode: 'maj', beats: 8,
      maj: ['vi IV I V', 'I V vi IV', 'IV V vi vi', 'vi IV V I', 'I V vi iii IV I IV V'],
      min: ['i bVI bIII bVII', 'i bVII bVI bVII', 'bVI bVII i i', 'i bVI bVII bVII'],
      chords: CH_PUSH,
      bass: BS_ROOT,
    }),
    style({
      id: 'synthwave', name: 'Synthwave', bpm: 100, swing: 0, mode: 'min', beats: 4,
      maj: ['I bVII IV I', 'vi IV I V', 'I V vi IV', 'IV V I I'],
      min: ['i bVI bIII bVII', 'i bVII bVI bVII', 'i iv bVI bVII', 'bVI bVII i i', 'i bVI iv V'],
      chords: CH_PAD,
      bass: BS_ROOT,
    }),
    style({
      id: 'rock', name: 'Rock', bpm: 120, swing: 0, mode: 'maj', beats: 4,
      maj: ['I bVII IV I', 'I IV V IV', 'I V vi IV', 'I bIII IV I', 'I IV I V'],
      min: ['i bVII bVI bVII', 'i bIII bVII IV', 'i bVI bIII bVII', 'i iv i V'],
      chords: CH_PUSH,
      bass: BS_ROOT,
    }),
    style({
      id: 'blues', name: 'Blues', bpm: 96, swing: 0.6, mode: 'maj', beats: 4,
      maj: ['I7 I7 I7 I7 IV7 IV7 I7 I7 V7 IV7 I7 V7', 'I7 IV7 I7 I7 IV7 IV7 I7 I7 V7 IV7 I7 V7', 'I7 IV7 I7 V7'],
      min: ['i7 i7 i7 i7 iv7 iv7 i7 i7 bVI7 V7 i7 V7', 'i7 iv7 i7 V7', 'i7 iv7 bVI7 V7'],
      chords: CH_PUSH,
      bass: BS_MOVE,
    }),
    style({
      id: 'reggae', name: 'Reggae', bpm: 74, swing: 0.2, mode: 'maj', beats: 4,
      maj: ['I IV I V', 'I V vi IV', 'I vi IV V', 'ii V I I', 'I iii IV V'],
      min: ['i bVII i bVII', 'i iv i iv', 'i bVII bVI bVII', 'i iv bVII i'],
      chords: CH_PUSH,
      bass: BS_ROOT,
    }),
    style({
      id: 'bossa', name: 'Bossa Nova', bpm: 130, swing: 0.1, mode: 'maj', beats: 4,
      maj: ['Imaj7 II7 ii7 V7', 'Imaj7 vi7 ii7 V7', 'ii9 V13 Imaj9 VI7', 'Imaj7 bIImaj7 Imaj7 bIImaj7', 'IVmaj7 iv6 iii7 VI7 ii7 V7 Imaj7 Imaj7'],
      min: ['i6 iiø V7 i6', 'i7 iv7 bVII7 bIIImaj7 bVImaj7 iiø V7 i7', 'i7 iv7 i7 V7'],
      chords: CH_PUSH,
      bass: BS_LATIN,
    }),
    style({
      id: 'funk', name: 'Funk', bpm: 108, swing: 0.15, mode: 'min', beats: 4,
      maj: ['I7 I7 IV7 IV7', 'I9 IV9 I9 V9', 'I7 bVII7 IV7 I7', 'I7 IV7 I7 V7'],
      min: ['i7 i7 IV7 IV7', 'i9 IV9 i9 IV9', 'i7 bVII7 i7 bVII7', 'i7 iv7 bVII7 bIII'],
      chords: CH_PUSH,
      bass: BS_MOVE,
    }),
    style({
      id: 'kpop', name: 'K-Pop / J-Pop', bpm: 120, swing: 0, mode: 'maj', beats: 4,
      maj: ['IVmaj7 V7 iii7 vi', 'I V vi iii IV I IV V', 'vi IV V I', 'IVmaj7 V iii7 vi IVmaj7 V I I', 'ii7 V7 iii7 vi7'],
      min: ['i bVI bVII i', 'bVImaj7 bVII7 i i', 'i iv bVII bIIImaj7', 'i bVI bIII bVII'],
      chords: CH_SWELL,
      bass: BS_ROOT,
    }),
    style({
      id: 'cinematic', name: 'Cinematic', bpm: 90, swing: 0, mode: 'min', beats: 8,
      maj: ['I bVI bVII I', 'I iii IV iv', 'I V vi IV', 'IV I V vi'],
      min: ['i bVI bIII bVII', 'i bVI iv V', 'bVI bVII i i', 'i bIII bVII IV', 'i bVI bVII V'],
      chords: CH_PAD,
      bass: BS_ROOT,
    }),
    style({
      id: 'afro', name: 'Afrobeats', bpm: 106, swing: 0.1, mode: 'maj', beats: 4,
      maj: ['vi IV I V', 'ii V I I', 'IV V vi vi', 'I IV vi V', 'ii7 V7 Imaj7 Imaj7'],
      min: ['i iv bVII bIII', 'i bVII bVI bVII', 'i iv i bVII', 'iv v i i'],
      chords: CH_PUSH,
      bass: BS_MOVE,
    }),
    style({
      id: 'drill', name: 'Drill', bpm: 142, swing: 0, mode: 'min', beats: 8,
      maj: ['vi IV ii III', 'vi V IV III', 'vi ii III vi'],
      min: ['i bVI V7 i', 'i iv V7 i', 'i bVI bII V7', 'i bII i bVI', 'i bVI iv V'],
      chords: CH_SWELL,
      bass: BS_ROOT,
    }),
  ];
  CC.styleById = (id) => CC.STYLES.find((s) => s.id === id) || CC.STYLES[0];
})(window.CC);
