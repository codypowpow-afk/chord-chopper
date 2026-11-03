// Audio engine: shared state, loading + chopping, the remix generator (progression -> per-layer
// notes -> per-layer glitch pass), per-layer FX chains, chop voices, step scheduler and offline render.
window.CC = window.CC || {};

(function (CC) {
  'use strict';

  const LAYERS = ['chords', 'bass'];
  let editGrp = 1e7; // note groups made by edits, above any a pattern produces
  CC.LAYERS = LAYERS;

  // Every layer has its own glitch (g) and fx settings. Effects default to off so chops sound like
  // the sample; what's on by default is what makes it sustain instead of dot: HOLD, soft envelopes
  // and a little reverb on the chords.
  const defG = () => ({ stutter: 0, reverse: 0, scatter: 0, gate: 1, tape: 0, hold: true, pick: 'near', bits: 16, rate: 0 });
  const defFx = (l) => ({ cutoff: 1, res: 0, delay: 0, verb: l === 'chords' ? 0.25 : 0, drive: 0,
    attack: l === 'chords' ? 0.2 : 0.05, release: l === 'chords' ? 0.5 : 0.25 });
  CC.defG = defG; CC.defFx = defFx;

  const S = (CC.S = {
    // source
    name: '', src: null, tr: null, x: null,
    chops: [], sel: 0, analyzing: false,
    chopMode: 'notes', sens: 0.5, grid: 16, minLen: 0.09,
    // harmony
    key: 9, mode: 'min', style: 'pop', progStr: '', sampleProg: '', register: 60, history: [], histPos: -1,
    pat: { chords: 0, bass: 0 },
    color: 'lush', voicing: 'open',
    cycle: 0, roam: false, evolve: false,
    // layers
    layers: {
      chords: { on: true, level: 0.55, oct: 0, g: defG(), fx: defFx('chords') },
      bass: { on: true, level: 0.6, oct: 0, src: 'both', g: defG(), fx: defFx('bass') },
    },
    target: 'all', // which layer(s) the GLITCH / FX panels edit
    volume: 0.8, bpm: 104, swing: 0,
    // generator
    seed: 1, gseed: 1, loopCount: 0, loop: null,
    playing: false,
  });

  const E = (CC.engine = {});
  E.onChange = null; // (progressionChanged) -> UI refresh after an automatic cycle

  E.init = function () {
    if (E.ctx) return;
    E.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    E.chain = E.buildChain(E.ctx, E.ctx.destination, true);
    E.updateChain();
  };
  E.resume = function () { if (E.ctx && E.ctx.state !== 'running') E.ctx.resume(); };
  E.stepDur = function () { return 60 / S.bpm / 4; };
  E.chopMidi = (c) => (c.note != null ? c.note : c.midi);

  // ---------- loading + chopping ----------
  E.load = async function (buffer, name, onProgress) {
    E.init();
    S.src = buffer; S.name = name;
    S.x = CC.mono(buffer);
    S.analyzing = true;
    S.tr = await CC.track(buffer, onProgress);
    S.analyzing = false;
    bufCache = {};
    if (S.autoOnsets) S.chopMode = 'notes';
    S.autoOnsets = false;
    E.rechop();
    // drums / noisy material: note splitting finds little, transients work better
    if (S.chopMode === 'notes' && S.chops.filter((c) => c.pitched).length < S.chops.length * 0.25) {
      S.chopMode = 'onsets'; S.autoOnsets = true;
      E.rechop();
    }
    E.fromSample();
  };

  // Key and chord progression heard in the chops; the progression becomes the current one.
  E.fromSample = function () {
    const k = CC.detectKey(S.chops);
    if (k) { S.key = k.key; S.mode = k.mode; }
    S.sampleProg = CC.detectProg(S.chops, S.key, S.mode, S.src.sampleRate);
    if (S.sampleProg) E.setProg(S.sampleProg);
    else E.newProg();
    return k;
  };

  // Voice chords around the sample's own pitch so chops are repitched as little as possible.
  function updateRegister() {
    const m = S.chops.filter((c) => c.pitched || c.note != null).map(E.chopMidi).sort((a, b) => a - b);
    S.register = m.length ? Math.max(48, Math.min(76, Math.round(m[m.length >> 1]))) : 60;
  }

  E.rechop = function () {
    if (!S.src) return;
    let raw;
    if (S.chopMode === 'grid') raw = CC.chopGrid(S.src, S.tr, S.grid);
    else if (S.chopMode === 'onsets') raw = CC.chopOnsets(S.src, S.tr, S.sens, S.minLen);
    else raw = CC.chopNotes(S.src, S.tr, S.sens, S.minLen);
    if (!raw.length) raw = [{ start: 0, end: S.src.length }];
    S.chops = raw.map((c) => E.analyze({ start: c.start, end: c.end, on: true, note: null }));
    S.sel = Math.min(S.sel, S.chops.length - 1);
    updateRegister();
  };
  E.analyze = (c) => CC.analyzeChop(S.src, S.tr, S.x, c);

  // Split the chop under `pos` (samples), or merge chop i into the next one.
  E.splitAt = function (pos) {
    const i = S.chops.findIndex((c) => pos > c.start && pos < c.end);
    if (i < 0) return -1;
    const c = S.chops[i], sr = S.src.sampleRate;
    if (pos - c.start < 0.02 * sr || c.end - pos < 0.02 * sr) return -1;
    const b = E.analyze({ start: pos, end: c.end, on: c.on, note: null });
    c.end = pos; c.note = null; E.analyze(c);
    S.chops.splice(i + 1, 0, b);
    return i;
  };
  E.mergeNext = function (i) {
    const a = S.chops[i], b = S.chops[i + 1];
    if (!a || !b) return;
    a.end = b.end; a.note = null;
    S.chops.splice(i + 1, 1);
    E.analyze(a);
  };

  // Source buffers per crush setting (forward + reversed), built on first use.
  let bufCache = {};
  E.buf = function (bits, rate) {
    const k = bits + '_' + rate;
    if (!bufCache[k] && S.src) {
      const fwd = rate || bits < 16 ? CC.degrade(E.ctx, S.src, { rate, bits }) : S.src;
      bufCache[k] = { fwd, rev: CC.reverseBuffer(E.ctx, fwd) };
    }
    return bufCache[k];
  };

  // ---------- harmony ----------
  E.style = () => CC.styleById(S.style);
  E.pool = () => { const st = E.style(); return st[S.mode].length ? st[S.mode] : st[S.mode === 'maj' ? 'min' : 'maj']; };

  function remember(str) {
    S.history = S.history.slice(0, S.histPos + 1);
    S.history.push({ style: S.style, mode: S.mode, prog: str });
    if (S.history.length > 40) S.history.shift();
    S.histPos = S.history.length - 1;
  }
  E.setProg = function (str, record) {
    S.progStr = str;
    if (record !== false) remember(str);
    E.regen();
  };
  E.newProg = function () {
    const pool = E.pool();
    let p = pool[Math.floor(Math.random() * pool.length)];
    const colored = (x) => CC.colorizeProg(x, S.mode, S.color);
    for (let i = 0; i < 6 && pool.length > 1 && colored(p) === S.progStr; i++) p = pool[Math.floor(Math.random() * pool.length)];
    E.setProg(colored(p));
  };
  E.histStep = function (dir) {
    const h = S.history[S.histPos + dir];
    if (!h) return false;
    S.histPos += dir;
    S.style = h.style; S.mode = h.mode;
    E.setProg(h.prog, false);
    return true;
  };

  // A style is a preset: tempo, swing, pattern set and progressions. Glitch / fx stay where the
  // user put them. keepFeel keeps the user's tempo / swing (used when roaming styles mid-play).
  E.setStyle = function (id, keepFeel) {
    S.style = id;
    const st = E.style();
    if (!keepFeel) {
      S.bpm = st.bpm; S.swing = st.swing;
    }
    LAYERS.forEach((l) => { S.pat[l] = 0; });
    E.updateChain();
  };
  E.newGroove = function () {
    const st = E.style();
    S.seed = (Math.random() * 1e9) >>> 0;
    LAYERS.forEach((l) => { S.pat[l] = Math.floor(Math.random() * st[l].length); });
    E.regen();
  };

  // ---------- per-layer settings ----------
  E.targets = () => (S.target === 'all' ? LAYERS : [S.target]);
  // Glitch changes re-run only the targeted layers' glitch pass over their unchanged notes; FX
  // changes only touch those layers' chains; PICK reassigns chops without moving notes.
  E.setLayerParam = function (group, key, v) {
    const ts = E.targets();
    ts.forEach((l) => { S.layers[l][group][key] = v; });
    if (group === 'fx') { E.updateChain(); return; }
    if (key === 'bits' || key === 'rate') { ts.forEach((l) => { const g = S.layers[l].g; E.buf(g.bits, g.rate); }); return; }
    if (key === 'hold') return; // read at play time
    if (key === 'pick') ts.forEach(repick);
    E.reglitch(ts);
  };
  // Random glitch amounts for the targeted layer(s) only.
  E.glitchIt = function () {
    const r = Math.random;
    E.targets().forEach((l) => {
      Object.assign(S.layers[l].g, {
        stutter: Math.round(r() * 60) / 100, reverse: Math.round(r() * 50) / 100, scatter: Math.round(r() * 50) / 100,
        gate: Math.round((0.35 + r() * 0.65) * 100) / 100, tape: Math.round(r() * 40) / 100,
      });
    });
    E.reglitch(E.targets());
  };

  // ---------- generator ----------
  function pools() {
    const on = S.chops.map((c, i) => ({ c, i })).filter((o) => o.c.on);
    const pitched = on.filter((o) => o.c.pitched || o.c.note != null);
    return { pitched: pitched.length ? pitched : on };
  }

  // Pattern char -> semitone above the chord root for bass.
  function bassInt(ch, ints) {
    const has = (a) => ints.find((i) => a.includes(i % 12));
    if (ch === '3') { const v = has([3, 4]); return v == null ? 4 : v % 12; }
    if (ch === '5') { const v = has([7, 6, 8]); return v == null ? 7 : v % 12; }
    if (ch === '6') return 9;
    if (ch === '7') { const v = has([10, 11, 9]); return v == null ? 10 : v % 12; }
    if (ch === 'o') return 12;
    return 0;
  }
  const DETUNE = [-5, 4, -3, 6]; // cents per chord voice: a little width when chops sustain together
  const near = (pc, base) => { let d = (((pc - base) % 12) + 12) % 12; if (d > 6) d -= 12; return base + d; };

  // A loop holds the chord timeline, each layer's base notes (loop.base[l]: what the patterns and
  // manual edits produce) and each layer's glitched output (loop.out[l]: what plays). Layers are
  // built and glitched independently from their own seeds, so changing one never moves another.
  E.anyEdited = () => !!S.loop && LAYERS.some((l) => S.loop.edited[l]);
  // New timeline and fresh notes everywhere (drops manual edits).
  E.regen = function () { return E.generate(true); };
  // Without force only layers that have no manual edits are rebuilt (e.g. a chop left the pool).
  function buildTimeline(str) {
    const chords = CC.parseProg(str, S.key, S.mode, E.style().beats);
    let pos = 0;
    const timeline = chords.map((ch) => {
      const len = Math.max(1, Math.round(ch.beats * 4));
      const o = Object.assign({ start: pos, len }, ch);
      pos += len;
      return o;
    });
    const total = Math.max(16, Math.ceil(pos / 16) * 16);
    if (timeline.length) timeline[timeline.length - 1].len += total - pos;
    return { total, chords: timeline, base: {}, out: {}, events: [], buckets: [], edited: {} };
  }
  E.generate = function (force) {
    const loop = !force && S.loop ? S.loop : buildTimeline(S.progStr || E.pool()[0]);
    LAYERS.forEach((l) => { if (!loop.edited[l]) loop.base[l] = buildLayer(loop, l); });
    S.loop = loop;
    E.reglitch();
    return loop;
  };

  // ---------- changing chords one at a time ----------
  // list: [{tok, from}] with `from` the chord's old index (-1 for new). A chord whose token and
  // length are unchanged keeps its exact notes, chops and glitches, shifted to its new position.
  // Only changed chords get new notes, so every other chord sounds the same as before.
  function editChords(list) {
    const old = S.loop;
    const str = list.map((x) => x.tok).join(' ');
    const loop = buildTimeline(str);
    loop.edited = old.edited;
    LAYERS.forEach((l) => {
      const fresh = buildLayer(loop, l), off = editGrp;
      editGrp += 200000;
      const notes = [];
      loop.chords.forEach((c, k) => {
        const o = list[k].from >= 0 ? old.chords[list[k].from] : null;
        if (o && o.token === c.token && o.len === c.len) {
          (old.base[l] || []).forEach((n) => {
            if (n.step >= o.start && n.step < o.start + o.len) notes.push(Object.assign({}, n, { step: n.step - o.start + c.start }));
          });
        } else {
          fresh.forEach((n) => {
            if (n.step >= c.start && n.step < c.start + c.len) notes.push(Object.assign({}, n, { grp: n.grp + off }));
          });
        }
      });
      loop.base[l] = notes.sort((a, b) => a.step - b.step);
    });
    S.progStr = str;
    remember(str);
    S.loop = loop;
    E.reglitch();
  }
  const chordList = () => S.loop.chords.map((c, i) => ({ tok: c.token, from: i }));
  // Replace chord i's numeral / type / slash; its length stays.
  E.setChord = function (i, parts) {
    const list = chordList();
    const beats = CC.splitToken(list[i].tok).beats;
    list[i] = { tok: CC.joinToken(Object.assign({}, parts, { beats })), from: i };
    editChords(list);
  };
  E.setChordBeats = function (i, beats) {
    const list = chordList();
    const p = CC.splitToken(list[i].tok);
    p.beats = beats;
    list[i] = { tok: CC.joinToken(p), from: i };
    editChords(list);
  };
  E.addChordAfter = function (i) {
    const list = chordList();
    list.splice(i + 1, 0, { tok: list[i].tok, from: i });
    editChords(list);
  };
  E.removeChord = function (i) {
    const list = chordList();
    if (list.length < 2) return false;
    list.splice(i, 1);
    editChords(list);
    return true;
  };
  E.chordOptions = function (i) {
    const n = S.loop.chords.length, c = S.loop.chords;
    return CC.chordOptions(E.style(), S.mode, c[(i - 1 + n) % n].token, c[i].token, c[(i + 1) % n].token, S.color);
  };
  // TRY ANOTHER: a random pick weighted toward what fits between the neighbours.
  E.rerollChord = function (i) {
    const opts = E.chordOptions(i).slice(0, 8);
    if (!opts.length) return;
    let r = Math.random() * opts.reduce((a, o) => a + o.score + 0.5, 0), pick = opts[0];
    for (const o of opts) { r -= o.score + 0.5; if (r <= 0) { pick = o; break; } }
    const parts = CC.splitToken(pick.tok);
    E.setChord(i, parts);
  };

  // Rebuild one layer's notes (pattern / octave / bass source changed). False if it has manual edits.
  E.rebuildLayer = function (l) {
    if (!S.loop || S.loop.edited[l]) return false;
    S.loop.base[l] = buildLayer(S.loop, l);
    E.reglitch([l]);
    return true;
  };

  const layerRng = (l, salt) => CC.rng(S.seed * 31 + 7 + LAYERS.indexOf(l) * 7777 + (salt || 0));

  // Chop chooser for a layer's PICK mode.
  function chooser(l, rng, P) {
    let rr = 0;
    return (target, avoid) => {
      const pool = P.pitched, mode = S.layers[l].g.pick;
      if (mode === 'one' && S.chops[S.sel] && S.chops[S.sel].on) return S.sel;
      if (mode === 'random') return rng.pick(pool).i;
      if (mode === 'cycle') return pool[(rr++) % pool.length].i;
      const ranked = pool.filter((o) => !avoid || !avoid.includes(o.i))
        .map((o) => ({ i: o.i, d: Math.abs(target - E.chopMidi(o.c)) + rng() * 2 }))
        .sort((a, b) => a.d - b.d);
      if (!ranked.length) return pool[rng.int(pool.length)].i;
      return ranked[Math.min(ranked.length - 1, rng.int(3))].i;
    };
  }

  function buildLayer(loop, l) {
    const P = pools();
    const timeline = loop.chords, total = loop.total;
    if (!S.chops.length || !P.pitched.length || !timeline.length) return [];
    const st = E.style(), L = S.layers;
    const rng = layerRng(l), pick = chooser(l, rng, P);
    const chordIdx = new Int16Array(total);
    timeline.forEach((c, k) => { for (let s = c.start; s < c.start + c.len && s < total; s++) chordIdx[s] = k; });
    const p = st[l][S.pat[l] % st[l].length];
    let grp = LAYERS.indexOf(l) * 100000;
    const ev = [];
    // Walks the pattern: fn(step, char, dur, chord) for each note start. Holds ('-') run until the
    // next non-hold char; a hold that crosses a chord change re-attacks on the new chord. A pattern
    // that starts on a hold plays from the top, so all holds means one long note per chord.
    const walk = (fn) => {
      let held = p[0] === '-' ? 'x' : null;
      for (let s = 0; s < total; s++) {
        const c = p[s % p.length];
        const chordStart = timeline[chordIdx[s]].start === s;
        if (c === '.') { held = null; continue; }
        if (c === '-' && !(held && chordStart)) continue;
        if (c !== '-') held = c;
        let d = 1;
        while (s + d < total && p[(s + d) % p.length] === '-' && timeline[chordIdx[s + d]].start !== s + d) d++;
        fn(s, held, d, timeline[chordIdx[s]]);
      }
    };
    if (l === 'chords') {
      // voice-led stabs, one chop per voice
      const voicings = [];
      let prev = null;
      timeline.forEach((c) => { prev = CC.voice(c, S.register - 5 + 12 * L.chords.oct, prev, S.voicing); voicings.push(prev); });
      walk((s, c, d) => {
        const notes = voicings[chordIdx[s]], used = [], g = grp++;
        notes.forEach((m, k) => {
          const chop = pick(m, used);
          used.push(chop);
          ev.push({ layer: l, step: s, dur: d, midi: m, chop, vel: (c === 'X' ? 1 : 0.8) * (0.62 - notes.length * 0.04),
            pan: notes.length > 1 ? (k / (notes.length - 1) - 0.5) * 0.7 : 0, grp: g, detune: DETUNE[k % DETUNE.length] });
        });
      });
    } else {
      const bassBase = 40 + 12 * L.bass.oct; // B1 - A#2: low, but still heard on small speakers
      walk((s, c, d, ch) => {
        const m = c === 'x' ? near(ch.root + ch.bassOff, bassBase) : near(ch.root, bassBase) + bassInt(c, ch.ints);
        ev.push({ layer: l, step: s, dur: d, midi: m, chop: pick(m), vel: 0.9, pan: 0, grp: grp++ });
      });
    }
    return ev;
  }

  // New chop assignment for a layer's notes (PICK changed); positions and pitches stay.
  function repick(l) {
    if (!S.loop) return;
    const P = pools();
    if (!P.pitched.length) return;
    const pick = chooser(l, layerRng(l, 99), P), used = {};
    S.loop.base[l].forEach((e) => {
      const u = used[e.grp] || (used[e.grp] = []);
      e.chop = pick(e.midi, u);
      u.push(e.chop);
    });
  }

  // Stable uniform in [0,1) for (seed, note group, slot): a note keeps the same draws while a
  // slider moves, so raising STUTTER only adds stutters instead of reshuffling everything.
  function uni(a, b, k) {
    let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x632be5ab, 0xc2b2ae35) ^ Math.imul(k + 1, 0x27d4eb2f);
    h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
  }
  const choose = (arr, u) => arr[Math.min(arr.length - 1, Math.floor(u * arr.length))];

  // Glitch pass for one layer. Decisions are per note group (a chord hit's voices move together).
  function glitchLayer(loop, l, P, gseed) {
    const G = S.layers[l].g;
    const seed = (gseed * 7919 + S.seed + LAYERS.indexOf(l) * 104729) >>> 0;
    const gate = 0.15 + 0.85 * G.gate;
    const out = [];
    (loop.base[l] || []).forEach((e0) => {
      const e = Object.assign({ rev: false, offs: 0, tape: false }, e0);
      const u = (k) => uni(seed, e.grp, k);
      e.dur = Math.max(0.25, e.dur * gate);
      e.rev = u(0) < G.reverse;
      if (u(1) < G.scatter) {
        const kind = Math.floor(u(2) * 4);
        if (kind === 0) e.midi += u(3) < 0.5 ? 12 : -12;
        else if (kind === 1) e.offs = 0.15 + u(3) * 0.5;
        else if (kind === 2) e.chop = choose(P.pitched, u(3)).i;
        else if (kind === 3) { e.step += 0.5; e.dur = Math.max(0.25, e.dur - 0.5); }
      }
      if (u(4) < G.stutter) {
        const n = choose([2, 3, 4, 4, 6, 8], u(5)), span = Math.min(e.dur, choose([1, 1, 2, 2, 4], u(6))), sub = span / n, asc = u(7) < 0.25;
        for (let k = 0; k < n; k++) {
          out.push(Object.assign({}, e, {
            step: e.step + k * sub,
            dur: k === n - 1 ? e.dur - k * sub : sub * 0.8,
            midi: e.midi + (asc ? Math.round((k * 12) / n) : 0),
            vel: e.vel * (0.6 + (0.4 * (k + 1)) / n),
          }));
        }
      } else out.push(e);
    });
    if (uni(seed, -1, 9) < G.tape) {
      const from = loop.total - 4;
      out.forEach((e) => { if (e.step >= from) { e.tape = true; e.dur = Math.max(e.dur, loop.total - e.step); } });
    }
    return out.filter((e) => e.step < loop.total);
  }

  // Merge the layers' outputs into the scheduler's per-step buckets.
  function compose(loop, outs) {
    const events = [].concat(...LAYERS.map((l) => outs[l] || [])).sort((a, b) => a.step - b.step);
    const buckets = [];
    for (let i = 0; i < loop.total; i++) buckets.push([]);
    events.forEach((e) => { buckets[Math.max(0, Math.min(loop.total - 1, Math.floor(e.step)))].push(e); });
    return { events, buckets };
  }

  // Re-run the glitch pass for the given layers (default all). Safe while playing: the scheduler
  // picks up the new buckets on its next step, other layers' events are reused as they are.
  E.reglitch = function (layers) {
    const loop = S.loop;
    if (!loop) return;
    const P = pools();
    (layers || LAYERS).forEach((l) => { loop.out[l] = P.pitched.length ? glitchLayer(loop, l, P, S.gseed) : []; });
    const c = compose(loop, loop.out);
    loop.events = c.events; loop.buckets = c.buckets;
  };

  // ---------- FX chain ----------
  function impulse(ctx, seconds) {
    const len = Math.round(ctx.sampleRate * seconds);
    const b = ctx.createBuffer(2, len, ctx.sampleRate);
    const r = CC.rng(1234);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (r() * 2 - 1) * Math.pow(1 - i / len, 2.6);
    }
    return b;
  }

  // Each layer: bus (level) -> drive -> filter -> dry mix, plus its own sends into the shared
  // ping-pong delay and reverb. Previews and one-shot keys go straight to the mix, untouched.
  E.buildChain = function (ctx, out, withAnalyser) {
    const c = { bus: {}, lay: {} };
    c.mix = ctx.createGain();
    c.dIn = ctx.createGain();
    c.vIn = ctx.createGain();
    LAYERS.forEach((l) => {
      const s = (c.lay[l] = {});
      s.bus = c.bus[l] = ctx.createGain();
      s.shaper = ctx.createWaveShaper(); s.shaper.oversample = '2x';
      s.filter = ctx.createBiquadFilter(); s.filter.type = 'lowpass';
      s.dSend = ctx.createGain(); s.vSend = ctx.createGain();
      s.bus.connect(s.shaper); s.shaper.connect(s.filter); s.filter.connect(c.mix);
      s.filter.connect(s.dSend); s.dSend.connect(c.dIn);
      s.filter.connect(s.vSend); s.vSend.connect(c.vIn);
    });
    c.preview = ctx.createGain(); c.preview.connect(c.mix);
    c.keys = ctx.createGain(); c.keys.connect(c.mix);
    c.dl = ctx.createDelay(2); c.dr = ctx.createDelay(2);
    c.fb = ctx.createGain(); c.fb.gain.value = 0.42;
    c.fbTone = ctx.createBiquadFilter(); c.fbTone.type = 'lowpass'; c.fbTone.frequency.value = 3800;
    c.merge = ctx.createChannelMerger(2);
    c.verb = ctx.createConvolver(); c.verb.buffer = impulse(ctx, 2.4);
    c.master = ctx.createGain();
    c.limiter = ctx.createDynamicsCompressor();
    c.limiter.threshold.value = -1.5; c.limiter.knee.value = 0; c.limiter.ratio.value = 20;
    c.limiter.attack.value = 0.001; c.limiter.release.value = 0.08;
    c.mix.connect(c.master);
    c.dIn.connect(c.dl); c.dl.connect(c.dr); c.dr.connect(c.fbTone); c.fbTone.connect(c.fb); c.fb.connect(c.dl);
    c.dl.connect(c.merge, 0, 0); c.dr.connect(c.merge, 0, 1); c.merge.connect(c.master);
    c.vIn.connect(c.verb); c.verb.connect(c.master);
    c.master.connect(c.limiter);
    if (withAnalyser) {
      c.analyser = ctx.createAnalyser(); c.analyser.fftSize = 1024;
      c.limiter.connect(c.analyser); c.analyser.connect(out);
    } else c.limiter.connect(out);
    return c;
  };

  const curves = {};
  function driveCurve(drive) {
    const k = Math.round(drive * 100) / 5; // 0..20, cached per percent
    if (k < 0.01) return null;
    if (!curves[k]) {
      const n = 2048, curve = new Float32Array(n), norm = Math.tanh(1 + k);
      for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = Math.tanh(x * (1 + k)) / norm; }
      curves[k] = curve;
    }
    return curves[k];
  }
  E.applyChain = function (c) {
    LAYERS.forEach((l) => {
      const L = S.layers[l], f = L.fx, s = c.lay[l];
      s.bus.gain.value = L.on ? L.level : 0;
      const curve = driveCurve(f.drive);
      if (s.shaper.curve !== curve) s.shaper.curve = curve;
      s.filter.frequency.value = f.cutoff >= 0.999 ? 22000 : 40 * Math.pow(2, f.cutoff * 9);
      s.filter.Q.value = 0.5 + f.res * 14;
      s.dSend.gain.value = f.delay * 0.55;
      s.vSend.gain.value = f.verb * 0.7;
    });
    const t = E.stepDur() * 3;
    c.dl.delayTime.value = t; c.dr.delayTime.value = t;
    c.master.gain.value = S.volume;
  };
  E.updateChain = function () { if (E.chain) E.applyChain(E.chain); };

  // ---------- voices ----------
  // Seconds for an ATTACK / RELEASE slider value (2 ms .. 1.2 s, curved).
  E.envTime = (v) => 0.002 + v * v * 1.2;

  // A copy of the chop whose body loops seamlessly: the loop length is a whole number of pitch
  // periods and its end crossfades into what comes before the loop start, so there's no click or
  // buzz. Built on first use, per chop and crush setting.
  function sustainBuf(bufs, rev, chop) {
    const cache = bufs.sus || (bufs.sus = {});
    const key = (rev ? 'r' : 'f') + chop.start + '_' + chop.end;
    if (cache[key]) return cache[key];
    const src = rev ? bufs.rev : bufs.fwd, sr = src.sampleRate;
    const s0 = rev ? src.length - chop.end : chop.start, n = chop.end - chop.start;
    const a = Math.round(n * 0.25);
    let b = Math.round(n * 0.9);
    if (chop.pitched) {
      const period = sr / (440 * Math.pow(2, (chop.midi - 69) / 12));
      const fit = a + Math.round(Math.max(1, Math.round((b - a) / period)) * period);
      if (fit <= n) b = fit;
    }
    const xf = Math.min(Math.round((b - a) * 0.5), a);
    const out = E.ctx.createBuffer(src.numberOfChannels, b, sr);
    for (let c = 0; c < src.numberOfChannels; c++) {
      const x = src.getChannelData(c), o = out.getChannelData(c);
      for (let i = 0; i < b; i++) o[i] = x[s0 + i];
      for (let i = 0; i < xf; i++) {
        const w = ((i + 0.5) / xf) * Math.PI * 0.5;
        o[b - xf + i] = x[s0 + b - xf + i] * Math.cos(w) + x[s0 + a - xf + i] * Math.sin(w);
      }
    }
    return (cache[key] = { buf: out, a: a / sr, b: b / sr });
  }

  // Plays one event at time t. The chop is repitched by playback rate (sampler style). With the
  // layer's HOLD on, a note longer than its chop sustains on a seamless loop of the chop's body.
  // e.clean plays the unprocessed sample (previews, one-shots); e.sustain lets a clean note hold.
  E.playEvent = function (ctx, dest, e, t, stepDur) {
    const chop = S.chops[e.chop];
    if (!chop || !S.src) return null;
    const dur = e.dur * stepDur;
    const layer = S.layers[e.layer];
    const bassSrc = e.layer === 'bass' ? layer.src : null;
    if (bassSrc === 'sub') return playSub(ctx, dest, e, t, dur);
    const G = !e.clean && layer ? layer.g : null;
    const bufs = G ? E.buf(G.bits, G.rate) : E.buf(16, 0);
    const fwdOrRev = e.rev ? bufs.rev : bufs.fwd, sr = fwdOrRev.sampleRate;
    const len = (chop.end - chop.start) / sr, offs = e.offs || 0;
    const rate = e.midi == null ? 1 : Math.min(8, Math.max(1 / 16, Math.pow(2, (e.midi - E.chopMidi(chop)) / 12)));
    const avail = (len * (1 - offs)) / rate;
    const src = ctx.createBufferSource();
    let play = Math.min(dur, avail), offset, looped = false;
    if ((G ? G.hold : e.sustain) && dur > avail * 1.05 && len > 0.03) {
      const sus = sustainBuf(bufs, e.rev, chop);
      src.buffer = sus.buf;
      src.loop = true; src.loopStart = sus.a; src.loopEnd = sus.b;
      offset = Math.min(offs * len, sus.a);
      play = dur; looped = true;
    } else {
      src.buffer = fwdOrRev;
      offset = (e.rev ? (fwdOrRev.length - chop.end) / sr : chop.start / sr) + offs * len;
    }
    if (play < 0.004) return bassSrc === 'both' ? playSub(ctx, dest, e, t, dur) : null;
    src.playbackRate.setValueAtTime(rate, t);
    if (src.detune && e.detune) src.detune.value = e.detune;
    if (e.tape) src.playbackRate.exponentialRampToValueAtTime(rate * 0.06, t + play);
    // Envelope. Attack and release shrink with the note so stutters stay tight. The release rings
    // past the note when there's audio left to ring; otherwise it fades inside the chop's end.
    const F = layer ? layer.fx : null;
    const atk = Math.min(F ? E.envTime(F.attack) : 0.002, play * 0.4);
    const rel = Math.min(F ? E.envTime(F.release) : 0.06, Math.max(0.01, play));
    const tail = looped || dur < avail ? rel : 0;
    const v = bassSrc === 'both' ? e.vel * 0.5 : e.vel;
    const env = ctx.createGain(), choke = ctx.createGain(), pan = ctx.createStereoPanner();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(v, t + atk);
    env.gain.setValueAtTime(v, Math.max(t + atk + 0.001, t + play - (tail ? 0 : Math.min(0.06, play * 0.3))));
    env.gain.linearRampToValueAtTime(0, t + play + tail);
    pan.pan.value = e.pan || 0;
    src.connect(env); env.connect(choke); choke.connect(pan); pan.connect(dest);
    src.start(t, offset);
    src.stop(t + play + tail + 0.02);
    const voice = { src, choke, start: t, holdEnd: t + play, rel, end: t + play + tail, chop: e.chop, layer: e.layer };
    if (bassSrc === 'both') voice.extra = playSub(ctx, dest, e, t, dur);
    return voice;
  };

  // Clean sub under the bass: sine + a little triangle, so it reads on small speakers too.
  function playSub(ctx, dest, e, t, dur) {
    const f = 440 * Math.pow(2, (e.midi - 69) / 12);
    const o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), g = ctx.createGain(), choke = ctx.createGain(), mix = ctx.createGain();
    o1.type = 'sine'; o2.type = 'triangle';
    o1.frequency.value = f; o2.frequency.value = f;
    mix.gain.value = 0.18;
    const F = S.layers.bass.fx, hold = Math.max(0.05, dur);
    const atk = Math.min(Math.max(0.005, E.envTime(F.attack)), hold * 0.4), rel = Math.min(E.envTime(F.release), hold);
    const v = e.vel * 0.65, end = t + hold + rel;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(v, t + atk);
    g.gain.setValueAtTime(v, t + hold);
    g.gain.linearRampToValueAtTime(0, end);
    o1.connect(g); o2.connect(mix); mix.connect(g); g.connect(choke); choke.connect(dest);
    o1.start(t); o2.start(t); o1.stop(end + 0.02); o2.stop(end + 0.02);
    return { src: o1, src2: o2, choke, start: t, holdEnd: t + hold, rel, end, chop: -1, layer: e.layer };
  }

  E.choke = function (v, t, fade) {
    if (!v || v.end <= t) return;
    const f = fade || 0.006;
    try {
      v.choke.gain.setValueAtTime(1, t);
      v.choke.gain.linearRampToValueAtTime(0, t + f);
      v.src.stop(t + f + 0.002);
      if (v.src2) v.src2.stop(t + f + 0.002);
    } catch (err) { /* already stopped */ }
    if (v.extra) E.choke(v.extra, t, f);
  };

  // Each layer plays one note or chord at a time: a new one crossfades out whatever of that layer
  // is still holding from earlier steps. Notes already in their release just ring out.
  E.scheduleStep = function (ctx, chain, bucket, t, stepDur, state) {
    const voices = [];
    if (!bucket || !bucket.length) return voices;
    const fresh = {};
    bucket.forEach((e) => {
      const tt = t + (e.step - Math.floor(e.step)) * stepDur;
      if (!fresh[e.layer]) {
        fresh[e.layer] = [];
        (state.last[e.layer] || []).forEach((v) => {
          if (v.holdEnd > tt + 0.005) E.choke(v, tt, Math.max(0.012, Math.min(v.rel, 0.35)));
        });
      }
      const v = E.playEvent(ctx, chain.bus[e.layer], e, tt, stepDur);
      if (v) { voices.push(v); if (fresh[e.layer]) fresh[e.layer].push(v); }
    });
    Object.keys(fresh).forEach((l) => { state.last[l] = fresh[l]; });
    return voices;
  };

  E.stepTime = function (i, base, stepDur) {
    return i % 2 === 1 ? base + S.swing * stepDur * 0.5 : base;
  };

  // ---------- realtime transport ----------
  const LOOKAHEAD = 0.12, TICK = 25;
  let timer = null, nextTime = 0, stepIdx = 0;
  const live = { last: {} };
  E.queue = []; // {time, step, voices} for the UI

  function loopEnd() {
    S.loopCount++;
    let changed = false;
    if (S.cycle && S.loopCount % S.cycle === 0) {
      if (S.roam) {
        const others = CC.STYLES.filter((s) => s.id !== S.style);
        E.setStyle(others[Math.floor(Math.random() * others.length)].id, true);
      }
      E.newProg();
      changed = true;
    } else if (S.evolve) {
      S.gseed = (S.gseed + 1) >>> 0;
      E.reglitch();
    }
    if (E.onChange) E.onChange(changed);
  }

  function tick() {
    const ctx = E.ctx;
    while (nextTime < ctx.currentTime + LOOKAHEAD) {
      const stepDur = E.stepDur();
      if (!S.loop) { nextTime += stepDur; continue; }
      if (stepIdx >= S.loop.total) { stepIdx = 0; loopEnd(); }
      const t = E.stepTime(stepIdx, nextTime, stepDur);
      const voices = E.scheduleStep(ctx, E.chain, S.loop.buckets[stepIdx], t, stepDur, live);
      E.queue.push({ time: nextTime, step: stepIdx, voices });
      nextTime += stepDur;
      stepIdx++;
    }
  }

  E.start = function () {
    E.init(); E.resume();
    if (S.playing || !S.loop) return;
    S.playing = true;
    stepIdx = 0; S.loopCount = 0;
    live.last = {};
    nextTime = E.ctx.currentTime + 0.06;
    E.queue = [];
    tick();
    timer = setInterval(tick, TICK);
  };
  E.stop = function () {
    S.playing = false;
    clearInterval(timer); timer = null;
    if (!E.ctx) return;
    const t = E.ctx.currentTime;
    E.queue.forEach((q) => q.voices.forEach((v) => E.choke(v, t, 0.03)));
    Object.values(live.last).forEach((vs) => vs.forEach((v) => E.choke(v, t, 0.03)));
    E.queue = [];
  };

  // ---------- previews ----------
  let previewVoices = [];
  const stopPreview = (t) => { previewVoices.forEach((v) => E.choke(v, t)); previewVoices = []; };
  E.previewChop = function (i) {
    E.init(); E.resume();
    if (!S.chops[i]) return;
    const t = E.ctx.currentTime + 0.005;
    stopPreview(t);
    const c = S.chops[i], dur = (c.end - c.start) / S.src.sampleRate;
    const v = E.playEvent(E.ctx, E.chain.preview, { layer: 'shot', chop: i, midi: null, dur: dur / E.stepDur(), vel: 0.9, clean: true }, t, E.stepDur());
    if (v) previewVoices.push(v);
  };
  // Audition a chord of the progression with the chops that would play it.
  E.previewChord = function (k) {
    E.init(); E.resume();
    const loop = S.loop;
    if (!loop || !loop.chords[k]) return;
    const t = E.ctx.currentTime + 0.005;
    stopPreview(t);
    const ch = loop.chords[k];
    const evs = (loop.base.chords || []).filter((e) => e.step >= ch.start && e.step < ch.start + ch.len);
    const first = evs.length ? evs[0].grp : null;
    const notes = evs.filter((e) => e.grp === first);
    const dur = Math.min(16, ch.len);
    if (notes.length) {
      notes.forEach((e) => {
        const v = E.playEvent(E.ctx, E.chain.preview, Object.assign({}, e, { dur, clean: true, sustain: true }), t, E.stepDur());
        if (v) previewVoices.push(v);
      });
    } else {
      // chord layer silent on this chord: voice it fresh with the nearest chops
      const P = pools();
      if (!P.pitched.length) return;
      CC.voice(ch, S.register - 5, null, S.voicing).forEach((m) => {
        let best = P.pitched[0];
        P.pitched.forEach((o) => { if (Math.abs(m - E.chopMidi(o.c)) < Math.abs(m - E.chopMidi(best.c))) best = o; });
        const v = E.playEvent(E.ctx, E.chain.preview, { layer: 'chords', chop: best.i, midi: m, dur, vel: 0.45, pan: 0, clean: true, sustain: true }, t, E.stepDur());
        if (v) previewVoices.push(v);
      });
    }
  };

  // ---------- manual edits ----------
  // The roll edits a layer's base notes. The layer is marked edited (pattern changes leave it alone)
  // and its glitch pass re-runs, so that layer's glitch / fx keep applying on top of the edits.
  E.editedLayer = function (l) {
    S.loop.base[l].sort((a, b) => a.step - b.step);
    S.loop.edited[l] = true;
    E.reglitch([l]);
  };
  E.resetEdits = function () {
    if (!S.loop) return;
    S.loop.edited = {};
    E.generate();
  };
  E.nearestChop = function (midi) {
    const pool = pools().pitched;
    if (!pool.length) return -1;
    let best = pool[0];
    pool.forEach((o) => { if (Math.abs(midi - E.chopMidi(o.c)) < Math.abs(midi - E.chopMidi(best.c))) best = o; });
    return best.i;
  };
  E.newEvent = function (layer, step, midi, dur) {
    if (!pools().pitched.length) return null;
    return { layer, step, dur, midi, chop: E.nearestChop(midi), vel: layer === 'chords' ? 0.5 : 0.8, pan: 0, grp: editGrp++ };
  };
  E.previewEvent = function (e) {
    E.init(); E.resume();
    const t = E.ctx.currentTime + 0.005;
    stopPreview(t);
    const v = E.playEvent(E.ctx, E.chain.preview, Object.assign({}, e, { dur: Math.min(e.dur, 4), tape: false }), t, E.stepDur());
    if (v) previewVoices.push(v);
  };

  // ---------- one-shot keys ----------
  // A key with chops detected at its note plays them as-is (round robin); other keys play the
  // nearest chop repitched. One-shots ring out to the end of the chop.
  const keyVoices = {};
  let shotRR = 0;
  E.shotChops = (midi) => S.chops.map((c, i) => ({ c, i }))
    .filter((o) => (o.c.pitched || o.c.note != null) && Math.round(E.chopMidi(o.c)) === midi);
  E.playShot = function (midi) {
    E.init(); E.resume();
    if (!S.chops.length || !S.src) return -1;
    const t = E.ctx.currentTime + 0.003;
    E.choke(keyVoices[midi], t);
    const exact = E.shotChops(midi);
    let chop, m = null;
    if (exact.length) chop = exact[shotRR++ % exact.length].i;
    else { chop = E.nearestChop(midi); m = midi; }
    if (chop < 0) return -1;
    keyVoices[midi] = E.playEvent(E.ctx, E.chain.keys, { layer: 'shot', chop, midi: m, dur: 1e4, vel: 0.9, clean: true }, t, E.stepDur());
    return chop;
  };

  // ---------- offline render ----------
  // Renders `loops` passes of the loop; with EVOLVE on each pass gets fresh glitches.
  E.render = async function (loops) {
    const sr = S.src.sampleRate, stepDur = E.stepDur();
    const loop = S.loop, P = pools(), passes = [];
    for (let k = 0; k < loops; k++) {
      if (!k || !S.evolve) { passes.push({ total: loop.total, buckets: loop.buckets }); continue; }
      const outs = {};
      LAYERS.forEach((l) => { outs[l] = glitchLayer(loop, l, P, (S.gseed + k) >>> 0); });
      passes.push({ total: loop.total, buckets: compose(loop, outs).buckets });
    }
    const steps = passes.reduce((a, p) => a + p.total, 0);
    const off = new OfflineAudioContext(2, Math.ceil(steps * stepDur * sr), sr);
    const chain = E.buildChain(off, off.destination, false);
    E.applyChain(chain);
    const state = { last: {} };
    let base = 0;
    passes.forEach((p) => {
      for (let i = 0; i < p.total; i++) E.scheduleStep(off, chain, p.buckets[i], E.stepTime(i, base + i * stepDur, stepDur), stepDur, state);
      base += p.total * stepDur;
    });
    return off.startRendering();
  };

  // MIDI of the current loop: chord and bass tracks at the target pitches.
  E.midi = function () {
    const loop = S.loop;
    const tracks = [['Chords', 'chords', 0], ['Bass', 'bass', 1]].map(([name, l, ch]) => ({
      name, channel: ch,
      events: loop.events.filter((e) => e.layer === l).map((e) => ({ step: e.step, len: Math.max(0.25, e.dur), note: e.midi, vel: e.vel })),
    }));
    return CC.encodeMidi(tracks, S.bpm, loop.total);
  };
})(window.CC);
