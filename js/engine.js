// Audio engine: shared state, loading + chopping, the remix generator (progression -> layer
// events -> glitch pass), FX chain, chop voices, step scheduler and offline render.
window.CC = window.CC || {};

(function (CC) {
  'use strict';

  const LAYERS = ['chords', 'lead', 'bass', 'perc'];
  CC.LAYERS = LAYERS;

  const S = (CC.S = {
    // source
    name: '', src: null, proc: null, procRev: null, tr: null, x: null,
    chops: [], sel: 0, analyzing: false,
    chopMode: 'notes', sens: 0.5, grid: 16, minLen: 0.09,
    // harmony
    key: 9, mode: 'min', style: 'pop', progStr: '', sampleProg: '', register: 60, history: [], histPos: -1,
    pat: { chords: 0, lead: 0, bass: 0, perc: 0 },
    cycle: 0, roam: false, evolve: false,
    // layers
    layers: {
      chords: { on: true, level: 0.7, oct: 0 },
      lead: { on: true, level: 0.75, oct: 0 },
      bass: { on: true, level: 0.8, oct: 0, src: 'chop' },
      perc: { on: false, level: 0.5, oct: 0 },
    },
    // glitch
    // non-essential processing defaults to off so chops sound like the original sample
    stutter: 0, reverse: 0, scatter: 0, gate: 1, tape: 0,
    pick: 'near', hold: false, bits: 16, rate: 0,
    // fx
    cutoff: 1, res: 0, delay: 0, verb: 0, drive: 0, volume: 0.8,
    bpm: 104, swing: 0,
    // generator; frozen = the loop has manual edits, so passive changes don't regenerate it
    seed: 1, gseed: 1, loopCount: 0, loop: null, frozen: false,
    playing: false, exportLoops: 1,
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
    E.rebuildProcessed();
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

  // Voice chords / lead around the sample's own pitch so chops are repitched as little as possible.
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

  E.rebuildProcessed = function () {
    if (!S.src) return;
    S.proc = S.rate || S.bits < 16 ? CC.degrade(E.ctx, S.src, { rate: S.rate, bits: S.bits }) : S.src;
    S.procRev = CC.reverseBuffer(E.ctx, S.proc);
  };

  // ---------- harmony ----------
  E.style = () => CC.styleById(S.style);
  E.pool = () => { const st = E.style(); return st[S.mode].length ? st[S.mode] : st[S.mode === 'maj' ? 'min' : 'maj']; };

  E.setProg = function (str, record) {
    S.progStr = str;
    if (record !== false) {
      S.history = S.history.slice(0, S.histPos + 1);
      S.history.push({ style: S.style, mode: S.mode, prog: str });
      if (S.history.length > 40) S.history.shift();
      S.histPos = S.history.length - 1;
    }
    E.regen();
  };
  E.newProg = function () {
    const pool = E.pool();
    let p = pool[Math.floor(Math.random() * pool.length)];
    for (let i = 0; i < 6 && pool.length > 1 && p === S.progStr; i++) p = pool[Math.floor(Math.random() * pool.length)];
    E.setProg(p);
  };
  E.histStep = function (dir) {
    const h = S.history[S.histPos + dir];
    if (!h) return false;
    S.histPos += dir;
    S.style = h.style; S.mode = h.mode;
    E.setProg(h.prog, false);
    return true;
  };

  // A style is a preset: tempo, swing, pattern set and progressions. Glitch amounts stay where the
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
  E.glitchIt = function () {
    const r = Math.random;
    S.stutter = Math.round(r() * 60) / 100;
    S.reverse = Math.round(r() * 50) / 100;
    S.scatter = Math.round(r() * 50) / 100;
    S.gate = Math.round((0.35 + r() * 0.65) * 100) / 100;
    S.tape = Math.round(r() * 40) / 100;
    S.gseed = (r() * 1e9) >>> 0;
    E.regen();
  };

  // ---------- generator ----------
  function pools() {
    const on = S.chops.map((c, i) => ({ c, i })).filter((o) => o.c.on);
    let pitched = on.filter((o) => o.c.pitched || o.c.note != null);
    if (!pitched.length) pitched = on;
    let perc = on.filter((o) => !o.c.pitched && o.c.note == null);
    if (perc.length < 2) perc = on;
    perc = perc.slice().sort((a, b) => a.c.bright - b.c.bright);
    return { pitched, perc };
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
  const near = (pc, base) => { let d = (((pc - base) % 12) + 12) % 12; if (d > 6) d -= 12; return base + d; };

  E.regen = function () { S.frozen = false; return E.generate(true); };
  E.generate = function (force) {
    if (S.frozen && !force && S.loop) return S.loop;
    const st = E.style();
    const chords = CC.parseProg(S.progStr || E.pool()[0], S.key, S.mode, st.beats);
    let pos = 0;
    const timeline = chords.map((ch) => {
      const len = Math.max(1, Math.round(ch.beats * 4));
      const o = Object.assign({ start: pos, len }, ch);
      pos += len;
      return o;
    });
    const total = Math.max(16, Math.ceil(pos / 16) * 16);
    if (timeline.length) timeline[timeline.length - 1].len += total - pos;
    const loop = { total, chords: timeline, events: [], buckets: [] };
    for (let i = 0; i < total; i++) loop.buckets.push([]);
    S.loop = loop;
    const P = pools();
    if (!S.chops.length || !P.pitched.length || !timeline.length) return loop;

    const rng = CC.rng(S.seed * 31 + 7);
    const chordIdx = new Int16Array(total);
    timeline.forEach((c, k) => { for (let s = c.start; s < c.start + c.len && s < total; s++) chordIdx[s] = k; });
    const pat = (l) => st[l][S.pat[l] % st[l].length];
    let rr = 0;
    const pick = (target, avoid) => {
      const pool = P.pitched;
      if (S.pick === 'one' && S.chops[S.sel] && S.chops[S.sel].on) return S.sel;
      if (S.pick === 'random') return rng.pick(pool).i;
      if (S.pick === 'cycle') return pool[(rr++) % pool.length].i;
      const ranked = pool.filter((o) => !avoid || !avoid.includes(o.i))
        .map((o) => ({ i: o.i, d: Math.abs(target - E.chopMidi(o.c)) + rng() * 2 }))
        .sort((a, b) => a.d - b.d);
      if (!ranked.length) return pool[rng.int(pool.length)].i;
      return ranked[Math.min(ranked.length - 1, rng.int(3))].i;
    };
    // Walks a pattern: calls fn(step, char, dur) for each note start. Holds ('-') run until the
    // next non-hold char; a hold that crosses a chord change re-attacks on the new chord.
    const walk = (p, fn) => {
      let held = null; // char of the note being held, if any
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
    let grp = 0;
    const ev = [];
    const L = S.layers;

    // chords: voice-led stabs, one chop per voice
    const voicings = [];
    let prev = null;
    timeline.forEach((c) => { prev = CC.voice(c, S.register - 5 + 12 * L.chords.oct, prev); voicings.push(prev); });
    walk(pat('chords'), (s, c, d) => {
      const notes = voicings[chordIdx[s]], used = [], g = grp++;
      notes.forEach((m, k) => {
        const chop = pick(m, used);
        used.push(chop);
        ev.push({ layer: 'chords', step: s, dur: d, midi: m, chop, vel: (c === 'X' ? 1 : 0.8) * (0.62 - notes.length * 0.04),
          pan: notes.length > 1 ? (k / (notes.length - 1) - 0.5) * 0.7 : 0, grp: g });
      });
    });

    // lead: arp / melody over the chord-tone ladder
    const leadBase = S.register + 12 * L.lead.oct;
    walk(pat('lead'), (s, c, d, ch) => {
      const pcs = Array.from(new Set(ch.ints.map((i) => i % 12))).sort((a, b) => a - b);
      const idx = c === 'r' ? rng.int(6) : parseInt(c, 10);
      if (isNaN(idx)) return;
      const root = near(ch.root, leadBase);
      const m = root + pcs[idx % pcs.length] + 12 * Math.floor(idx / pcs.length);
      ev.push({ layer: 'lead', step: s, dur: d, midi: m, chop: pick(m), vel: 0.8, pan: (rng() - 0.5) * 0.3, grp: grp++ });
    });

    // bass
    const bassBase = 36 + 12 * L.bass.oct;
    walk(pat('bass'), (s, c, d, ch) => {
      const m = near(ch.root, bassBase) + bassInt(c, ch.ints);
      ev.push({ layer: 'bass', step: s, dur: d, midi: m, chop: pick(m), vel: 0.9, pan: 0, grp: grp++, synth: L.bass.src === 'sub' });
    });

    // perc: unpitched chops at their own pitch, sorted dark -> bright into k / s / h
    const pp = pat('perc'), pc = P.perc;
    for (let s = 0; s < total; s++) {
      const c = pp[s % pp.length], lc = c.toLowerCase();
      if (!'ksh'.includes(lc)) continue;
      const third = Math.max(1, Math.floor(pc.length / 3));
      const from = lc === 'k' ? 0 : lc === 's' ? Math.min(pc.length - 1, third) : Math.max(0, pc.length - third);
      const o = pc[Math.min(pc.length - 1, from + rng.int(third))];
      ev.push({ layer: 'perc', step: s, dur: lc === 'h' ? 1 : 2, midi: null, chop: o.i, vel: c === lc ? 0.7 : 1, pan: lc === 'h' ? (rng() - 0.5) * 0.5 : 0, grp: grp++ });
    }

    loop.events = glitch(ev, loop, P);
    loop.events.forEach((e) => { loop.buckets[Math.min(total - 1, Math.floor(e.step))].push(e); });
    return loop;
  };

  // Glitch pass. Decisions are made once per group (a chord hit's voices move together) from
  // their own seed, so EVOLVE can re-roll the glitches each loop without touching the notes.
  function glitch(events, loop, P) {
    const g = CC.rng(S.gseed * 7919 + S.seed);
    const decide = {};
    const out = [];
    const gate = 0.15 + 0.85 * S.gate;
    events.forEach((e0) => {
      const e = Object.assign({ rev: false, offs: 0, tape: false }, e0);
      const pitched = e.layer !== 'perc';
      let d = decide[e.grp];
      if (!d) {
        d = decide[e.grp] = {
          rev: g() < S.reverse * (e.layer === 'bass' ? 0.25 : e.layer === 'perc' ? 0.5 : 1),
          scatter: e.layer !== 'bass' && g() < S.scatter ? g.int(4) : -1,
          up: g() < 0.5, offs: 0.15 + g() * 0.5,
          stut: g() < S.stutter * (e.layer === 'bass' ? 0.3 : e.layer === 'perc' ? 0.5 : 1) ? g.pick([2, 3, 4, 4, 6, 8]) : 0,
          span: g.pick([1, 1, 2, 2, 4]), asc: g() < 0.25,
        };
      }
      if (pitched) e.dur = Math.max(0.25, e.dur * gate);
      e.rev = d.rev;
      if (d.scatter === 0 && pitched) e.midi += d.up ? 12 : -12;
      else if (d.scatter === 1) e.offs = d.offs;
      else if (d.scatter === 2 && pitched) e.chop = P.pitched[g.int(P.pitched.length)].i;
      else if (d.scatter === 3) { e.step += 0.5; e.dur = Math.max(0.25, e.dur - 0.5); }
      if (d.stut && !e.synth) {
        const span = Math.min(e.dur, d.span), n = d.stut, sub = span / n;
        for (let k = 0; k < n; k++) {
          const last = k === n - 1;
          out.push(Object.assign({}, e, {
            step: e.step + k * sub,
            dur: last ? e.dur - k * sub : sub * 0.8,
            midi: e.midi == null ? null : e.midi + (d.asc ? Math.round((k * 12) / n) : 0),
            vel: e.vel * (0.6 + (0.4 * (k + 1)) / n),
          }));
        }
      } else out.push(e);
    });
    if (g() < S.tape) {
      const from = loop.total - 4;
      out.forEach((e) => { if (e.step >= from && e.layer !== 'perc') { e.tape = true; e.dur = Math.max(e.dur, loop.total - e.step); } });
    }
    return out.filter((e) => e.step < loop.total).sort((a, b) => a.step - b.step);
  }

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

  // layer buses -> drive -> filter -> glue comp -> dry / ping-pong delay / reverb -> master -> limiter
  E.buildChain = function (ctx, out, withAnalyser) {
    const c = { bus: {} };
    c.input = ctx.createGain();
    LAYERS.forEach((l) => { c.bus[l] = ctx.createGain(); c.bus[l].connect(c.input); });
    c.preview = ctx.createGain(); c.preview.connect(c.input);
    c.keys = ctx.createGain(); c.keys.connect(c.input);
    c.shaper = ctx.createWaveShaper(); c.shaper.oversample = '2x';
    c.filter = ctx.createBiquadFilter(); c.filter.type = 'lowpass';
    c.comp = ctx.createDynamicsCompressor();
    c.comp.threshold.value = 0; c.comp.ratio.value = 1; // transparent unless DRIVE pushes it c.comp.attack.value = 0.005; c.comp.release.value = 0.15;
    c.dry = ctx.createGain();
    c.dSend = ctx.createGain();
    c.dl = ctx.createDelay(2); c.dr = ctx.createDelay(2);
    c.fb = ctx.createGain(); c.fb.gain.value = 0.42;
    c.fbTone = ctx.createBiquadFilter(); c.fbTone.type = 'lowpass'; c.fbTone.frequency.value = 3800;
    c.merge = ctx.createChannelMerger(2);
    c.vSend = ctx.createGain();
    c.verb = ctx.createConvolver(); c.verb.buffer = impulse(ctx, 2.4);
    c.master = ctx.createGain();
    c.limiter = ctx.createDynamicsCompressor();
    c.limiter.threshold.value = -1.5; c.limiter.knee.value = 0; c.limiter.ratio.value = 20;
    c.limiter.attack.value = 0.001; c.limiter.release.value = 0.08;
    c.input.connect(c.shaper); c.shaper.connect(c.filter); c.filter.connect(c.comp);
    c.comp.connect(c.dry); c.dry.connect(c.master);
    c.comp.connect(c.dSend); c.dSend.connect(c.dl); c.dl.connect(c.dr); c.dr.connect(c.fbTone); c.fbTone.connect(c.fb); c.fb.connect(c.dl);
    c.dl.connect(c.merge, 0, 0); c.dr.connect(c.merge, 0, 1); c.merge.connect(c.master);
    c.comp.connect(c.vSend); c.vSend.connect(c.verb); c.verb.connect(c.master);
    c.master.connect(c.limiter);
    if (withAnalyser) {
      c.analyser = ctx.createAnalyser(); c.analyser.fftSize = 1024;
      c.limiter.connect(c.analyser); c.analyser.connect(out);
    } else c.limiter.connect(out);
    return c;
  };

  E.applyChain = function (c) {
    const k = S.drive * 20;
    if (k < 0.01) c.shaper.curve = null;
    else {
      const n = 2048, curve = new Float32Array(n), norm = Math.tanh(1 + k);
      for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = Math.tanh(x * (1 + k)) / norm; }
      c.shaper.curve = curve;
    }
    c.filter.frequency.value = S.cutoff >= 0.999 ? 22000 : 40 * Math.pow(2, S.cutoff * 9);
    c.filter.Q.value = 0.5 + S.res * 14;
    const t = E.stepDur() * 3;
    c.dl.delayTime.value = t; c.dr.delayTime.value = t;
    c.dSend.gain.value = S.delay * 0.55;
    c.vSend.gain.value = S.verb * 0.7;
    c.master.gain.value = S.volume;
    LAYERS.forEach((l) => { c.bus[l].gain.value = S.layers[l].on ? S.layers[l].level : 0; });
  };
  E.updateChain = function () { if (E.chain) E.applyChain(E.chain); };

  // ---------- voices ----------
  // Plays one event at time t. The chop is repitched by playback rate (sampler style); with
  // HOLD on, a note longer than its chop loops the chop's body to fill the length.
  E.playEvent = function (ctx, dest, e, t, stepDur) {
    const chop = S.chops[e.chop];
    if (!chop || !S.proc) return null;
    const dur = e.dur * stepDur;
    if (e.synth) return playSub(ctx, dest, e, t, dur);
    const buf = e.rev ? S.procRev : S.proc, sr = buf.sampleRate;
    const len = (chop.end - chop.start) / sr;
    const rate = e.midi == null ? 1 : Math.min(8, Math.max(1 / 16, Math.pow(2, (e.midi - E.chopMidi(chop)) / 12)));
    const off0 = e.rev ? (buf.length - chop.end) / sr : chop.start / sr;
    const offset = off0 + e.offs * len;
    const avail = (len * (1 - e.offs)) / rate;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.setValueAtTime(rate, t);
    let play = Math.min(dur, avail);
    if (S.hold && e.layer !== 'perc' && dur > avail * 1.05 && len > 0.03) {
      src.loop = true;
      src.loopStart = off0 + len * Math.max(e.offs, 0.3);
      src.loopEnd = Math.max(src.loopStart + 0.01, off0 + len * 0.85);
      play = dur;
    }
    if (play < 0.004) return null;
    if (e.tape) src.playbackRate.exponentialRampToValueAtTime(rate * 0.06, t + play);
    const env = ctx.createGain(), choke = ctx.createGain(), pan = ctx.createStereoPanner();
    const atk = e.layer === 'chords' ? 0.006 : 0.002, rel = Math.min(0.06, play * 0.3);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(e.vel, t + atk);
    env.gain.setValueAtTime(e.vel, Math.max(t + atk + 0.001, t + play - rel));
    env.gain.linearRampToValueAtTime(0, t + play);
    pan.pan.value = e.pan || 0;
    src.connect(env); env.connect(choke); choke.connect(pan); pan.connect(dest);
    src.start(t, offset);
    src.stop(t + play + 0.02);
    return { src, choke, start: t, end: t + play, chop: e.chop, layer: e.layer };
  };

  // Sine + a little triangle sub for BASS = SUB.
  function playSub(ctx, dest, e, t, dur) {
    const f = 440 * Math.pow(2, (e.midi - 69) / 12);
    const o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), g = ctx.createGain(), choke = ctx.createGain(), mix = ctx.createGain();
    o1.type = 'sine'; o2.type = 'triangle';
    o1.frequency.value = f; o2.frequency.value = f;
    mix.gain.value = 0.18;
    const v = e.vel * 0.9, end = t + Math.max(0.05, dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(v, t + 0.005);
    g.gain.setValueAtTime(v, Math.max(t + 0.006, end - 0.03));
    g.gain.linearRampToValueAtTime(0, end);
    o1.connect(g); o2.connect(mix); mix.connect(g); g.connect(choke); choke.connect(dest);
    o1.start(t); o2.start(t); o1.stop(end + 0.02); o2.stop(end + 0.02);
    return { src: o1, src2: o2, choke, start: t, end, chop: -1, layer: e.layer };
  }

  E.choke = function (v, t) {
    if (!v || v.end <= t) return;
    try {
      v.choke.gain.setValueAtTime(1, t);
      v.choke.gain.linearRampToValueAtTime(0, t + 0.006);
      v.src.stop(t + 0.008);
      if (v.src2) v.src2.stop(t + 0.008);
    } catch (err) { /* already stopped */ }
  };

  // Lead and bass are mono and chords cut the previous chord: a new note in a layer chokes
  // that layer's voices from earlier steps.
  E.scheduleStep = function (ctx, chain, bucket, t, stepDur, state) {
    const voices = [];
    if (!bucket || !bucket.length) return voices;
    const fresh = {};
    bucket.forEach((e) => {
      const tt = t + (e.step - Math.floor(e.step)) * stepDur;
      if (e.layer !== 'perc' && !fresh[e.layer]) {
        fresh[e.layer] = [];
        (state.last[e.layer] || []).forEach((v) => E.choke(v, tt));
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
      E.generate();
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
    E.queue.forEach((q) => q.voices.forEach((v) => E.choke(v, t)));
    Object.values(live.last).forEach((vs) => vs.forEach((v) => E.choke(v, t)));
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
    const v = E.playEvent(E.ctx, E.chain.preview, { layer: 'perc', chop: i, midi: null, dur: dur / E.stepDur(), vel: 0.9, offs: 0 }, t, E.stepDur());
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
    const evs = loop.events.filter((e) => e.layer === 'chords' && e.step >= ch.start && e.step < ch.start + ch.len);
    const first = evs.length ? evs[0].grp : null;
    const notes = evs.filter((e) => e.grp === first);
    const dur = Math.min(8, ch.len) * 1.0;
    if (notes.length) {
      notes.forEach((e) => {
        const v = E.playEvent(E.ctx, E.chain.preview, Object.assign({}, e, { dur, rev: false, tape: false, offs: 0 }), t, E.stepDur());
        if (v) previewVoices.push(v);
      });
    } else {
      // chord layer silent on this chord: voice it fresh with the nearest chops
      const P = pools();
      if (!P.pitched.length) return;
      CC.voice(ch, S.register - 5, null).forEach((m) => {
        let best = P.pitched[0];
        P.pitched.forEach((o) => { if (Math.abs(m - E.chopMidi(o.c)) < Math.abs(m - E.chopMidi(best.c))) best = o; });
        const v = E.playEvent(E.ctx, E.chain.preview, { layer: 'chords', chop: best.i, midi: m, dur, vel: 0.45, offs: 0, pan: 0 }, t, E.stepDur());
        if (v) previewVoices.push(v);
      });
    }
  };

  // ---------- manual edits ----------
  // The roll edits S.loop.events directly; rebucket re-indexes them for the scheduler and
  // freezes the loop so slider / pattern changes don't throw the edits away.
  E.rebucket = function () {
    const L = S.loop;
    L.events.sort((a, b) => a.step - b.step);
    L.buckets = [];
    for (let i = 0; i < L.total; i++) L.buckets.push([]);
    L.events.forEach((e) => { L.buckets[Math.max(0, Math.min(L.total - 1, Math.floor(e.step)))].push(e); });
    S.frozen = true;
  };
  E.nearestChop = function (midi) {
    const pool = pools().pitched;
    if (!pool.length) return -1;
    let best = pool[0];
    pool.forEach((o) => { if (Math.abs(midi - E.chopMidi(o.c)) < Math.abs(midi - E.chopMidi(best.c))) best = o; });
    return best.i;
  };
  let editGrp = 1e6;
  E.newEvent = function (layer, step, midi, dur) {
    const P = pools();
    if (!P.pitched.length) return null;
    const perc = layer === 'perc';
    return {
      layer, step, dur, midi: perc ? null : midi,
      chop: perc ? P.perc[Math.floor(Math.random() * P.perc.length)].i : E.nearestChop(midi),
      vel: layer === 'chords' ? 0.5 : 0.8, pan: 0, grp: editGrp++, rev: false, offs: 0, tape: false,
      synth: layer === 'bass' && S.layers.bass.src === 'sub',
    };
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
    if (!S.chops.length || !S.proc) return -1;
    const t = E.ctx.currentTime + 0.003;
    E.choke(keyVoices[midi], t);
    const exact = E.shotChops(midi);
    let chop, m = null;
    if (exact.length) chop = exact[shotRR++ % exact.length].i;
    else { chop = E.nearestChop(midi); m = midi; }
    if (chop < 0) return -1;
    keyVoices[midi] = E.playEvent(E.ctx, E.chain.keys, { layer: 'perc', chop, midi: m, dur: 1e4, vel: 0.9, offs: 0 }, t, E.stepDur());
    return chop;
  };

  // ---------- offline render ----------
  // Renders `loops` passes of the loop; with EVOLVE on each pass gets fresh glitches.
  E.render = async function (loops) {
    const sr = S.src.sampleRate, stepDur = E.stepDur();
    const saved = { gseed: S.gseed, loop: S.loop };
    const passes = [];
    for (let k = 0; k < loops; k++) {
      if (k && S.evolve) { S.gseed = (S.gseed + 1) >>> 0; E.generate(); }
      passes.push(S.loop);
    }
    S.gseed = saved.gseed; S.loop = saved.loop;
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

  // MIDI of the current loop: chord / lead / bass tracks at the target pitches.
  E.midi = function () {
    const loop = S.loop;
    const tracks = [['Chords', 'chords', 0], ['Lead', 'lead', 1], ['Bass', 'bass', 2]].map(([name, l, ch]) => ({
      name, channel: ch,
      events: loop.events.filter((e) => e.layer === l && e.midi != null).map((e) => ({ step: e.step, len: Math.max(0.25, e.dur), note: e.midi, vel: e.vel })),
    }));
    return CC.encodeMidi(tracks, S.bpm, loop.total);
  };
})(window.CC);
