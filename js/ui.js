// UI: controls, waveform + chop pads, key / style / progression, layer mixer, remix roll,
// animation (playhead, pad flashes, scope), file loading and exports.
(function (CC) {
  'use strict';
  const S = CC.S, E = CC.engine;
  const $ = (id) => document.getElementById(id);
  let lastChip = -1; // chip lit by the playhead
  const KEY_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const pcColor = (pc, a) => `hsla(${(((pc % 12) + 12) % 12) * 30 + 200}, 85%, 62%, ${a == null ? 1 : a})`;
  const status = (msg) => { $('status').textContent = msg; };
  const flats = () => CC.useFlats(S.key, S.mode);

  // ---------- generic controls ----------
  function fmt(key, v) {
    if (key === 'minLen') return Math.round(v * 1000) + 'ms';
    if (key === 'cutoff') return v >= 0.999 ? 'OPEN' : Math.round(40 * Math.pow(2, v * 9)) + 'Hz';
    if (key === 'attack' || key === 'release') return Math.round(E.envTime(v) * 1000) + 'ms';
    return Math.round(v * 100) + '%';
  }
  function syncControls() {
    document.querySelectorAll('.seg[data-key]').forEach((seg) => {
      seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', String(S[seg.dataset.key]) === b.dataset.v));
    });
    document.querySelectorAll('input[type=range][data-key]').forEach((el) => { el.value = S[el.dataset.key]; });
    document.querySelectorAll('[data-out]').forEach((el) => { el.textContent = fmt(el.dataset.out, S[el.dataset.out]); });
    $('bpm').value = Math.round(S.bpm);
    $('swing').value = S.swing;
    $('roamBtn').classList.toggle('on', S.roam);
    $('evolveBtn').classList.toggle('on', S.evolve);
    $('gridGroup').style.display = S.chopMode === 'grid' ? '' : 'none';
    renderKeys(); renderStyles(); renderLayers(); syncLayerControls();
  }

  // Chop pool / note changes rebuild the layers that have no manual edits.
  function softRegen() { E.generate(); drawRoll(); }

  let rechopTimer = null;
  function rechopSoon() {
    clearTimeout(rechopTimer);
    rechopTimer = setTimeout(() => {
      if (!S.src) return;
      E.rechop(); E.regen();
      renderChops(); drawWave(); renderPiano(); renderProg(); drawRoll(); syncEdit();
      status(`${S.chops.length} chops (${S.chops.filter((c) => c.pitched).length} pitched)`);
    }, 120);
  }

  function onKeyChange(key) {
    if (key === 'drawLayer' || key === 'snap' || key === 'color') return;
    if (key === 'voicing') {
      if (!E.rebuildLayer('chords')) status('CHORDS has manual edits: RESET EDITS to apply the voicing to it.');
      drawRoll();
      return;
    }
    if (['chopMode', 'grid', 'sens', 'minLen'].includes(key)) { rechopSoon(); return; }
    if (key === 'mode') { E.newProg(); refreshHarmony(); return; }
    if (key === 'cycle') return;
    E.updateChain();
  }

  document.querySelectorAll('.seg[data-key]').forEach((seg) => {
    seg.addEventListener('click', (ev) => {
      const b = ev.target.closest('button');
      if (!b) return;
      const key = seg.dataset.key;
      S[key] = seg.hasAttribute('data-num') ? parseFloat(b.dataset.v) : b.dataset.v;
      if (key === 'chopMode') S.autoOnsets = false;
      syncControls();
      onKeyChange(key);
    });
  });
  document.querySelectorAll('input[type=range][data-key]').forEach((el) => {
    el.addEventListener('input', () => {
      const key = el.dataset.key;
      S[key] = parseFloat(el.value);
      const out = document.querySelector(`[data-out="${key}"]`);
      if (out) out.textContent = fmt(key, S[key]);
      onKeyChange(key);
    });
  });
  $('bpm').addEventListener('change', () => {
    S.bpm = Math.max(50, Math.min(220, parseFloat($('bpm').value) || S.bpm));
    $('bpm').value = Math.round(S.bpm);
    E.updateChain();
  });
  $('swing').addEventListener('input', () => { S.swing = parseFloat($('swing').value); });
  $('roamBtn').onclick = () => { S.roam = !S.roam; syncControls(); };
  $('evolveBtn').onclick = () => { S.evolve = !S.evolve; syncControls(); };

  // ---------- per-layer glitch / fx ----------
  const LNAME = { all: 'BOTH', chords: 'CHORDS', bass: 'BASS' };
  const parseSeg = (seg, v) => (seg.hasAttribute('data-num') ? parseFloat(v) : seg.hasAttribute('data-bool') ? v === 'true' : v);
  // Panels show the targeted layer's values; with ALL selected, a setting that differs between
  // layers shows the first layer's value marked MIX (moving it sets every layer).
  function syncLayerControls() {
    const ts = E.targets();
    const vals = (g, k) => ts.map((l) => S.layers[l][g][k]);
    const mixed = (arr) => arr.some((v) => v !== arr[0]);
    document.querySelectorAll('input[type=range][data-lkey]').forEach((el) => {
      const v = vals(el.dataset.group, el.dataset.lkey);
      el.value = v[0];
      const out = document.querySelector(`[data-lout="${el.dataset.lkey}"]`);
      if (out) out.textContent = fmt(el.dataset.lkey, v[0]) + (mixed(v) ? ' MIX' : '');
    });
    document.querySelectorAll('.seg[data-lkey]').forEach((seg) => {
      const v = vals(seg.dataset.group, seg.dataset.lkey), mix = mixed(v);
      seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', !mix && parseSeg(seg, b.dataset.v) === v[0]));
    });
    $('targetSeg').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === S.target));
    $('glitchFor').textContent = $('fxFor').textContent = '→ ' + LNAME[S.target];
    document.querySelectorAll('.layer').forEach((row) => row.classList.toggle('target', S.target !== 'all' && row.dataset.l === S.target));
  }
  function setTarget(t) {
    S.target = t;
    if (t !== 'all') S.drawLayer = t; // draw on the layer being edited
    syncLayerControls(); syncSeg('drawLayer'); drawRoll();
  }
  $('targetSeg').onclick = (ev) => { const b = ev.target.closest('button'); if (b) setTarget(b.dataset.v); };
  document.querySelectorAll('input[type=range][data-lkey]').forEach((el) => {
    el.addEventListener('input', () => {
      E.setLayerParam(el.dataset.group, el.dataset.lkey, parseFloat(el.value));
      syncLayerControls(); markMods();
      if (el.dataset.group === 'g') drawRoll();
    });
  });
  document.querySelectorAll('.seg[data-lkey]').forEach((seg) => {
    seg.addEventListener('click', (ev) => {
      const b = ev.target.closest('button'); if (!b) return;
      let v = parseSeg(seg, b.dataset.v);
      // a single toggle button (HOLD) flips
      if (seg.hasAttribute('data-bool')) v = !E.targets().every((l) => S.layers[l].g[seg.dataset.lkey]);
      E.init();
      E.setLayerParam(seg.dataset.group, seg.dataset.lkey, v);
      syncLayerControls(); markMods(); drawRoll();
    });
  });
  function glitchTargets() { E.glitchIt(); syncLayerControls(); markMods(); drawRoll(); status(`Random glitch on ${LNAME[S.target].toLowerCase()}.`); }
  $('glitchLayerBtn').onclick = glitchTargets;
  $('clearLayerBtn').onclick = () => {
    E.targets().forEach((l) => { Object.assign(S.layers[l].g, CC.defG()); Object.assign(S.layers[l].fx, CC.defFx(l)); });
    E.reglitch(E.targets()); E.updateChain();
    syncLayerControls(); markMods(); drawRoll();
  };
  // Small GLITCH / FX tags on layer rows whose settings are off their defaults.
  function markMods() {
    const dg = CC.defG();
    document.querySelectorAll('.layer').forEach((row) => {
      const L = S.layers[row.dataset.l], df = CC.defFx(row.dataset.l);
      const g = Object.keys(dg).some((k) => L.g[k] !== dg[k]), f = Object.keys(df).some((k) => L.fx[k] !== df[k]);
      row.querySelector('.mods').textContent = [g ? 'GLITCH' : '', f ? 'FX' : ''].filter(Boolean).join(' · ');
    });
  }

  // ---------- key / style / progression ----------
  function renderKeys() {
    const seg = $('keySeg');
    if (!seg.children.length) {
      KEY_NAMES.forEach((n, k) => {
        const b = document.createElement('button');
        b.textContent = n;
        b.onclick = () => { S.key = k; E.regen(); refreshHarmony(); };
        seg.appendChild(b);
      });
    }
    Array.from(seg.children).forEach((b, k) => b.classList.toggle('on', k === S.key));
  }
  function renderStyles() {
    const box = $('styles');
    if (!box.children.length) {
      CC.STYLES.forEach((st) => {
        const b = document.createElement('button');
        b.className = 'btn';
        b.dataset.id = st.id;
        b.innerHTML = `${st.name}<small>${st.bpm} BPM · ${st.maj.length + st.min.length} progressions</small>`;
        b.onclick = () => {
          E.setStyle(st.id);
          E.newProg();
          syncControls(); refreshHarmony();
          status(`${st.name}: ${st.bpm} BPM, swing ${Math.round(st.swing * 100)}%`);
        };
        box.appendChild(b);
      });
    }
    Array.from(box.children).forEach((b) => b.classList.toggle('on', b.dataset.id === S.style));
  }
  function renderProg() {
    const box = $('prog');
    box.innerHTML = '';
    const chords = S.loop.chords;
    S.selChord = Math.max(0, Math.min(chords.length - 1, S.selChord || 0));
    lastChip = -1;
    chords.forEach((c, k) => {
      const d = document.createElement('div');
      d.className = 'chip' + (k === S.selChord ? ' sel' : '');
      d.style.flexGrow = c.len / 16;
      d.innerHTML = `<span class="nm">${c.name}</span><span class="rm">${c.roman}</span>`;
      d.title = 'Hear this chord and change it below';
      d.onclick = () => { S.selChord = k; renderProg(); if (!S.playing) E.previewChord(k); };
      box.appendChild(d);
    });
    $('sampleProgBtn').classList.toggle('on', !!S.sampleProg && S.progStr === S.sampleProg);
    $('prevBtn').disabled = S.histPos <= 0;
    $('nextBtn').disabled = S.histPos >= S.history.length - 1;
    renderChordEdit();
  }

  // ---------- change one chord ----------
  const BASS_NOTES = [[0, 'ROOT'], [3, '3RD'], [5, '5TH'], [7, '7TH']];
  const LENGTHS = [[2, '2 BEATS'], [4, '1 BAR'], [8, '2 BARS'], [16, '4 BARS']];
  function afterChordEdit(msg) {
    renderProg(); drawRoll(); syncEdit();
    if (!S.playing) E.previewChord(S.selChord);
    if (msg) status(msg);
  }
  function renderChordEdit() {
    const box = $('chordEdit'), i = S.selChord, c = S.loop.chords[i];
    if (!c) { box.innerHTML = ''; return; }
    const parts = CC.splitToken(c.token), rel = ((c.root - S.key) % 12 + 12) % 12, type = CC.typeOf(parts), fl = flats();
    const on = (cond) => (cond ? ' class="on"' : '');
    const sugg = E.chordOptions(i).slice(0, 10);
    box.innerHTML = `<div class="ce-head"><span class="glabel">CHORD ${i + 1} OF ${S.loop.chords.length}</span><span class="ce-title">${c.name}</span>
        <button class="btn hot small" data-act="reroll" title="A different chord that fits between its neighbours. The other chords stay exactly as they are.">TRY ANOTHER</button>
        <button class="btn small" data-act="add" title="Copy this chord after itself">ADD AFTER</button>
        <button class="btn small" data-act="remove"${S.loop.chords.length < 2 ? ' disabled' : ''}>REMOVE</button></div>
      <div class="ce-row"><span class="glabel">FITS HERE</span><div class="seg ce-sugg">${sugg.map((o) => `<button data-tok="${o.tok}">${CC.parseChord(o.tok, S.key, S.mode, 4).name}</button>`).join('')}</div></div>
      <div class="ce-row"><span class="glabel">ROOT</span><div class="seg" data-part="root">${Array.from({ length: 12 }, (_, r) => `<button data-v="${r}"${on(r === rel)}>${CC.pcName(S.key + r, fl)}</button>`).join('')}</div></div>
      <div class="ce-row"><span class="glabel">TYPE</span><div class="seg" data-part="type">${CC.TYPES.map((ty, t) => `<button data-v="${t}"${on(t === type)}>${ty[0]}</button>`).join('')}</div></div>
      <div class="ce-row"><span class="glabel">BASS NOTE</span><div class="seg" data-part="bass">${BASS_NOTES.map(([d, n]) => `<button data-v="${d}"${on(d === c.deg)}>${n}</button>`).join('')}</div>
        <span class="glabel">LENGTH</span><div class="seg" data-part="len">${LENGTHS.map(([b, n]) => `<button data-v="${b}"${on(b === c.beats)}>${n}</button>`).join('')}</div></div>`;
  }
  $('chordEdit').addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b || !S.loop) return;
    const i = S.selChord, c = S.loop.chords[i];
    if (b.dataset.act === 'reroll') { E.rerollChord(i); afterChordEdit(`Chord ${i + 1} is now ${S.loop.chords[i].name}. The others didn't change.`); return; }
    if (b.dataset.act === 'add') { E.addChordAfter(i); S.selChord = i + 1; afterChordEdit(); return; }
    if (b.dataset.act === 'remove') { if (E.removeChord(i)) afterChordEdit(); return; }
    if (b.dataset.tok) { E.setChord(i, CC.splitToken(b.dataset.tok)); afterChordEdit(); return; }
    const seg = b.closest('[data-part]');
    if (!seg) return;
    const v = parseInt(b.dataset.v, 10), parts = CC.splitToken(c.token);
    const rel = ((c.root - S.key) % 12 + 12) % 12;
    if (seg.dataset.part === 'len') { E.setChordBeats(i, v); afterChordEdit(); return; }
    let next = parts;
    if (seg.dataset.part === 'bass') next.deg = v;
    else {
      const type = seg.dataset.part === 'type' ? v : Math.max(0, CC.typeOf(parts));
      next = CC.partsFor(seg.dataset.part === 'root' ? v : rel, type);
      next.deg = parts.deg;
    }
    E.setChord(i, next);
    afterChordEdit();
  });
  function refreshHarmony() { renderKeys(); renderStyles(); renderLayers(); renderProg(); drawRoll(); syncSeg('mode'); syncEdit(); }
  function syncSeg(key) {
    const seg = document.querySelector(`.seg[data-key="${key}"]`);
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', String(S[key]) === b.dataset.v));
  }

  $('newProgBtn').onclick = () => { E.newProg(); refreshHarmony(); };
  $('grooveBtn').onclick = () => { E.newGroove(); renderLayers(); drawRoll(); syncEdit(); };
  $('glitchBtn').onclick = glitchTargets;
  $('prevBtn').onclick = () => { if (E.histStep(-1)) { syncControls(); refreshHarmony(); } };
  $('nextBtn').onclick = () => { if (E.histStep(1)) { syncControls(); refreshHarmony(); } };
  $('detectBtn').onclick = () => {
    if (!S.src) return;
    const k = E.fromSample();
    refreshHarmony();
    status(k ? `Detected ${keyText()}: ${S.sampleProg}` : 'No pitched chops to detect a key from.');
  };
  $('sampleProgBtn').onclick = () => {
    if (!S.sampleProg) { status(S.src ? 'No progression found in this sample.' : 'Load a sample first.'); return; }
    E.setProg(S.sampleProg); refreshHarmony();
    status(`Progression from the sample: ${S.sampleProg}`);
  };
  const keyText = () => `${KEY_NAMES[S.key]} ${S.mode === 'maj' ? 'major' : 'minor'}`;

  E.onChange = (changed) => {
    if (changed) { renderStyles(); renderLayers(); renderProg(); syncEdit(); }
    drawRoll();
  };

  // ---------- layers ----------
  const LAYER_LABEL = { chords: 'CHORDS', bass: 'BASS' };
  function renderLayers() {
    const box = $('layers');
    const st = E.style();
    box.innerHTML = '';
    CC.LAYERS.forEach((l) => {
      const L = S.layers[l];
      const row = document.createElement('div');
      row.className = 'layer';
      row.dataset.l = l;
      const pats = st[l].map((_, i) => `<button data-p="${i}" class="${S.pat[l] === i ? 'on' : ''}">${i + 1}</button>`).join('');
      const octs = `<span class="mini">OCT</span><div class="seg oct">${[-1, 0, 1].map((o) => `<button data-o="${o}" class="${L.oct === o ? 'on' : ''}">${o > 0 ? '+' + o : o}</button>`).join('')}</div>`;
      const src = l === 'bass' ? `<div class="seg src">${[['chop', 'CHOP'], ['sub', 'SUB'], ['both', 'CHOP + SUB']].map(([v, n]) => `<button data-s="${v}" class="${L.src === v ? 'on' : ''}">${n}</button>`).join('')}</div>` : '';
      row.innerHTML = `<div class="lname" title="Edit this layer's glitch / fx"><i style="background:var(--${l})"></i><span>${LAYER_LABEL[l]}<br><span class="mods"></span></span></div>
        <div class="ctl"><button class="btn small onoff ${L.on ? 'on' : ''}">${L.on ? 'ON' : 'OFF'}</button>
        <input type="range" min="0" max="1" step="0.01" value="${L.level}" title="Level">
        <span class="mini">PATTERN</span><div class="seg pats">${pats}</div>${octs}${src}</div>`;
      row.querySelector('.lname').onclick = () => setTarget(S.target === l ? 'all' : l);
      row.querySelector('.onoff').onclick = () => { L.on = !L.on; E.updateChain(); renderLayers(); drawRoll(); };
      row.querySelector('input').oninput = (ev) => { L.level = parseFloat(ev.target.value); E.updateChain(); };
      row.querySelector('.pats').onclick = (ev) => {
        const b = ev.target.closest('button'); if (!b) return;
        S.pat[l] = +b.dataset.p; rebuild(l);
      };
      const oct = row.querySelector('.oct');
      if (oct) oct.onclick = (ev) => {
        const b = ev.target.closest('button'); if (!b) return;
        L.oct = +b.dataset.o; rebuild(l);
      };
      const sr = row.querySelector('.src');
      if (sr) sr.onclick = (ev) => {
        const b = ev.target.closest('button'); if (!b) return;
        L.src = b.dataset.s; renderLayers(); // read at play time
      };
      box.appendChild(row);
    });
    syncLayerControls(); markMods();
  }
  // Pattern / octave / source changes rebuild only that layer's notes.
  function rebuild(l) {
    if (!E.rebuildLayer(l)) status(`${LAYER_LABEL[l]} has manual edits: RESET EDITS to apply pattern changes to it.`);
    renderLayers(); drawRoll();
  }

  // ---------- chops ----------
  const noteSel = $('noteSel');
  (function () {
    const o = document.createElement('option'); o.value = ''; o.textContent = 'AUTO NOTE'; noteSel.appendChild(o);
    for (let m = 96; m >= 24; m--) {
      const op = document.createElement('option'); op.value = m; op.textContent = CC.midiName(m); noteSel.appendChild(op);
    }
  })();
  function chopLabel(c) {
    if (c.note != null) return CC.midiName(c.note, flats());
    return c.pitched ? CC.midiName(c.midi, flats()) : 'NOISE';
  }
  function renderChops() {
    const box = $('chops');
    box.innerHTML = '';
    S.chops.forEach((c, i) => {
      const d = document.createElement('div');
      const pitched = c.pitched || c.note != null;
      d.className = 'chop' + (i === S.sel ? ' sel' : '') + (c.on ? '' : ' off') + (pitched ? '' : ' noise');
      const m = E.chopMidi(c);
      const cents = c.note != null ? 'SET' : pitched ? `${m - Math.round(m) >= 0 ? '+' : ''}${Math.round((m - Math.round(m)) * 100)}c` : `${Math.round((c.end - c.start) / S.src.sampleRate * 1000)}ms`;
      d.innerHTML = `<span class="i">${i + 1}</span><span class="n">${chopLabel(c)}</span><span class="c">${cents}</span><span class="bar" style="width:${Math.round(Math.max(0.08, c.conf) * 100)}%"></span>`;
      if (pitched) d.style.setProperty('--pc', pcColor(Math.round(m)));
      d.title = 'Click: hear · Ctrl/Shift-click: toggle in pool';
      d.onclick = (ev) => {
        if (ev.ctrlKey || ev.shiftKey) { c.on = !c.on; softRegen(); }
        else E.previewChop(i);
        S.sel = i; renderChops(); drawWave(); renderChopInfo();
      };
      box.appendChild(d);
    });
    renderChopInfo();
  }
  function renderChopInfo() {
    const c = S.chops[S.sel];
    if (!c) { $('chopInfo').textContent = '—'; return; }
    const sr = S.src.sampleRate;
    $('chopInfo').textContent = `#${S.sel + 1} ${chopLabel(c)} · ${Math.round(c.conf * 100)}% sure · ${((c.end - c.start) / sr).toFixed(2)}s`;
    noteSel.value = c.note != null ? String(c.note) : '';
    $('poolBtn').classList.toggle('on', c.on);
  }
  noteSel.onchange = () => {
    const c = S.chops[S.sel]; if (!c) return;
    c.note = noteSel.value === '' ? null : parseInt(noteSel.value, 10);
    renderChops(); drawWave(); renderPiano(); softRegen();
  };
  $('poolBtn').onclick = () => {
    const c = S.chops[S.sel]; if (!c) return;
    c.on = !c.on; renderChops(); softRegen();
  };
  $('allInBtn').onclick = () => { S.chops.forEach((c) => { c.on = true; }); renderChops(); softRegen(); };
  $('pitchedBtn').onclick = () => { S.chops.forEach((c) => { c.on = c.pitched || c.note != null; }); renderChops(); softRegen(); };

  // ---------- waveform ----------
  const wave = $('wave');
  let peaks = null;
  function fitCanvas(cv) {
    const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    return { w, h, dpr };
  }
  function computePeaks(w) {
    const x = S.x, n = x.length, out = new Float32Array(w * 2);
    for (let i = 0; i < w; i++) {
      let lo = 0, hi = 0;
      const a = Math.floor((i * n) / w), b = Math.floor(((i + 1) * n) / w);
      for (let k = a; k < b; k++) { if (x[k] < lo) lo = x[k]; if (x[k] > hi) hi = x[k]; }
      out[i * 2] = lo; out[i * 2 + 1] = hi;
    }
    return out;
  }
  function drawWave(playing) {
    const { w, h, dpr } = fitCanvas(wave);
    const g = wave.getContext('2d');
    g.fillStyle = '#0c1014'; g.fillRect(0, 0, w, h);
    if (!S.src) return;
    if (!peaks || peaks.length !== w * 2) peaks = computePeaks(w);
    const n = S.src.length, X = (s) => (s / n) * w;
    S.chops.forEach((c, i) => {
      const x0 = X(c.start), x1 = Math.max(x0 + 1, X(c.end));
      const pitched = c.pitched || c.note != null;
      g.fillStyle = pitched ? pcColor(Math.round(E.chopMidi(c)), i === S.sel ? 0.34 : 0.15) : `rgba(165,155,189,${i === S.sel ? 0.3 : 0.1})`;
      if (!c.on) g.fillStyle = 'rgba(255,255,255,0.03)';
      g.fillRect(x0, 0, x1 - x0, h);
      if (playing && playing.has(i)) { g.fillStyle = 'rgba(255,255,255,0.22)'; g.fillRect(x0, 0, x1 - x0, h); }
      g.fillStyle = 'rgba(255,255,255,0.35)'; g.fillRect(x0, 0, Math.max(1, dpr), h);
      if (x1 - x0 > 26 * dpr) {
        g.fillStyle = pitched ? pcColor(Math.round(E.chopMidi(c))) : '#a59bbd';
        g.font = `700 ${10 * dpr}px Consolas, monospace`;
        g.fillText(chopLabel(c), x0 + 3 * dpr, 12 * dpr);
      }
    });
    g.fillStyle = '#7dffb0';
    let pk = 1e-6;
    for (let i = 0; i < peaks.length; i++) pk = Math.max(pk, Math.abs(peaks[i]));
    const mid = h / 2 + 7 * dpr, amp = (h / 2 - 12 * dpr) / pk;
    for (let i = 0; i < w; i++) {
      const lo = peaks[i * 2], hi = peaks[i * 2 + 1];
      g.fillRect(i, mid - hi * amp, 1, Math.max(1, (hi - lo) * amp));
    }
    const sel = S.chops[S.sel];
    if (sel) {
      g.strokeStyle = '#7dffb0'; g.lineWidth = dpr;
      g.strokeRect(X(sel.start) + 0.5, 0.5, Math.max(2, X(sel.end) - X(sel.start)) - 1, h - 1);
    }
  }
  const sampleAt = (ev) => {
    const r = wave.getBoundingClientRect();
    return Math.round(((ev.clientX - r.left) / r.width) * S.src.length);
  };
  const chopAt = (pos) => S.chops.findIndex((c) => pos >= c.start && pos < c.end);
  wave.addEventListener('click', (ev) => {
    if (!S.src) { $('fileInput').click(); return; }
    const pos = sampleAt(ev), i = chopAt(pos);
    if (ev.altKey) {
      if (i >= 0 && i + 1 < S.chops.length) { E.mergeNext(i); S.sel = i; afterEdit(); }
      return;
    }
    if (i >= 0) { S.sel = i; E.previewChop(i); renderChops(); drawWave(); }
  });
  wave.addEventListener('dblclick', (ev) => {
    if (!S.src) return;
    const i = E.splitAt(sampleAt(ev));
    if (i >= 0) { S.sel = i + 1; afterEdit(); }
  });
  function afterEdit() { E.regen(); renderChops(); drawWave(); renderPiano(); drawRoll(); syncEdit(); status(`${S.chops.length} chops`); }

  // ---------- one-shot keys ----------
  const PIANO_KEYS = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13, l: 14, p: 15 };
  let kbBase = null; // computer-keyboard root (a C)
  let piano = { lo: 48, hi: 72 };
  const isBlack = (m) => [1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12);
  function renderPiano() {
    const box = $('piano');
    const found = S.chops.filter((c) => c.pitched || c.note != null).map((c) => Math.round(E.chopMidi(c)));
    let lo = found.length ? Math.floor(Math.min(...found) / 12) * 12 : 48;
    let hi = found.length ? Math.ceil((Math.max(...found) + 1) / 12) * 12 : 72;
    if (hi - lo < 24) hi = lo + 24;
    if (hi - lo > 48) { const mid = Math.round((lo + hi) / 24) * 12; lo = mid - 24; hi = mid + 24; }
    piano = { lo, hi };
    if (kbBase == null) kbBase = lo;
    const whites = [];
    for (let m = lo; m <= hi; m++) if (!isBlack(m)) whites.push(m);
    const ww = 100 / whites.length;
    box.innerHTML = '';
    let wi = 0;
    for (let m = lo; m <= hi; m++) {
      const d = document.createElement('div');
      const n = E.chopMidi ? E.shotChops(m).length : 0;
      if (isBlack(m)) { d.className = 'bk'; d.style.left = `calc(${wi * ww}% - ${ww * 0.32}%)`; d.style.width = `${ww * 0.64}%`; }
      else { d.className = 'wk'; d.style.left = `${wi * ww}%`; d.style.width = `${ww}%`; wi++; }
      if (n) { d.classList.add('has'); d.style.setProperty('--kc', pcColor(m)); }
      d.dataset.m = m;
      const label = m % 12 === 0 || n ? CC.midiName(m, flats()) : '';
      d.innerHTML = `${n > 1 ? `<span class="cnt">×${n}</span>` : ''}<span>${label}</span>`;
      d.title = n ? `${CC.midiName(m, flats())}: ${n} chop${n > 1 ? 's' : ''} from the sample` : `${CC.midiName(m, flats())}: nearest chop repitched`;
      box.appendChild(d);
    }
    $('kbOct').textContent = `KEYS ${CC.midiName(kbBase)}–${CC.midiName(kbBase + 15)}`;
  }
  function pressKey(m) {
    if (!S.src) { status('Load a sample first.'); return; }
    const chop = E.playShot(m);
    const el = $('piano').querySelector(`[data-m="${m}"]`);
    if (el) { el.classList.add('down'); setTimeout(() => el.classList.remove('down'), 140); }
    const pad = $('chops').children[chop];
    if (pad) { pad.classList.add('flash'); setTimeout(() => pad.classList.remove('flash'), 140); }
  }
  let pianoDown = false;
  $('piano').addEventListener('pointerdown', (ev) => {
    const k = ev.target.closest('[data-m]'); if (!k) return;
    pianoDown = true; pressKey(+k.dataset.m);
    ev.preventDefault();
  });
  $('piano').addEventListener('pointerover', (ev) => {
    if (!pianoDown || !(ev.buttons & 1)) return;
    const k = ev.target.closest('[data-m]'); if (k) pressKey(+k.dataset.m);
  });
  window.addEventListener('pointerup', () => { pianoDown = false; });

  // ---------- remix roll (editable) ----------
  const roll = $('roll');
  const LAYER_COL = { chords: '#3de0ff', bass: '#ffc94a' };
  let rollCache = null, rollDirty = true, lastStep = null;
  function syncEdit() {
    const ed = E.anyEdited();
    $('editBadge').hidden = !ed;
    $('editBadge').textContent = ed ? 'EDITED: ' + CC.LAYERS.filter((l) => S.loop.edited[l]).map((l) => LAYER_LABEL[l]).join(' · ') : '';
    $('resetEditsBtn').hidden = !ed;
  }
  $('resetEditsBtn').onclick = () => { E.resetEdits(); rollDirty = true; drawRoll(); syncEdit(); status('Edits cleared, layers rebuilt from their patterns.'); };

  // Shared by painting and hit-testing. The pitch range is fixed per loop so it doesn't jump while editing.
  function geom(loop, w, h, dpr) {
    const top = 18 * dpr, bottom = h - 4 * dpr;
    if (!loop.view) {
      const ms = loop.events.map((e) => e.midi)
        .concat(S.chops.filter((c) => c.pitched).map((c) => Math.round(E.chopMidi(c))));
      let lo = ms.length ? Math.min(...ms) - 3 : 36, hi = ms.length ? Math.max(...ms) + 3 : 84;
      if (hi - lo < 24) { const mid = (lo + hi) / 2; lo = Math.floor(mid - 12); hi = lo + 24; }
      loop.view = { lo, hi };
    }
    const { lo, hi } = loop.view;
    const sx = w / loop.total, sy = (bottom - top) / (hi - lo);
    return { top, bottom, sx, sy, lo, hi, Y: (m) => bottom - (m - lo) * sy, M: (y) => lo + (bottom - y) / sy };
  }
  function noteRect(e, g, dpr) {
    return { x: e.step * g.sx, y: g.Y(e.midi) - g.sy, w: Math.max(3 * dpr, e.dur * g.sx - dpr), h: Math.max(2 * dpr, g.sy - dpr) };
  }

  function drawRoll(step) {
    const { w, h, dpr } = fitCanvas(roll);
    const g = roll.getContext('2d');
    const loop = S.loop;
    if (step === undefined) rollDirty = true;
    if (rollDirty || !rollCache || rollCache.w !== w || rollCache.h !== h || rollCache.loop !== loop) {
      const off = document.createElement('canvas');
      off.width = w; off.height = h;
      const o = off.getContext('2d');
      o.fillStyle = '#0c1014'; o.fillRect(0, 0, w, h);
      if (loop && S.chops.length) paintRoll(o, loop, w, h, dpr);
      else {
        o.fillStyle = '#4f8a69'; o.font = `700 ${13 * dpr}px Consolas, monospace`; o.textAlign = 'center';
        o.fillText(S.src ? 'No usable chops in the pool' : 'Load a sample to hear it remixed onto chords', w / 2, h / 2);
      }
      rollCache = { w, h, loop, img: off };
      rollDirty = false;
    }
    g.drawImage(rollCache.img, 0, 0);
    if (step != null) lastStep = step;
    if (S.playing && lastStep != null && loop) {
      g.fillStyle = 'rgba(255,255,255,0.85)'; g.fillRect((lastStep / loop.total) * w, 0, Math.max(1, dpr), h);
    }
  }
  function paintRoll(o, loop, w, h, dpr) {
    const G = geom(loop, w, h, dpr);
    loop.chords.forEach((c, k) => {
      o.fillStyle = k % 2 ? 'rgba(255,255,255,0.025)' : 'rgba(255,255,255,0.05)';
      o.fillRect(c.start * G.sx, 0, c.len * G.sx, h);
      o.fillStyle = '#7dffb0'; o.font = `700 ${11 * dpr}px Consolas, monospace`;
      o.fillText(c.name, c.start * G.sx + 4 * dpr, 13 * dpr);
    });
    for (let m = Math.ceil(G.lo); m < G.hi; m++) {
      if (m % 12 === S.key) { o.fillStyle = 'rgba(125,255,176,0.08)'; o.fillRect(0, G.Y(m) - G.sy, w, G.sy); }
      else if (isBlack(m)) { o.fillStyle = 'rgba(0,0,0,0.25)'; o.fillRect(0, G.Y(m) - G.sy, w, G.sy); }
    }
    for (let s = 0; s <= loop.total; s++) {
      o.fillStyle = s % 16 === 0 ? 'rgba(255,255,255,0.18)' : s % 4 === 0 ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.025)';
      o.fillRect(s * G.sx, G.top - 4 * dpr, Math.max(1, dpr * (s % 16 ? 0.5 : 1)), h);
    }
    // Filled blocks are what plays (the layer's glitched output); outlines are the layer's notes,
    // which are what you edit. With no glitch they coincide. Muted layers stay visible but dim;
    // layers other than the one being edited fade a little.
    const fade = (l) => (S.layers[l].on ? 1 : 0.22) * (S.target === 'all' || S.target === l ? 1 : 0.55);
    ['bass', 'chords'].forEach((l) => {
      (loop.out[l] || []).forEach((e) => {
        const r = noteRect(e, G, dpr);
        o.globalAlpha = (0.4 + e.vel * 0.55) * fade(l);
        o.fillStyle = LAYER_COL[l];
        o.fillRect(r.x, r.y, r.w, r.h);
        if (e.rev) { o.fillStyle = 'rgba(12,16,20,0.55)'; for (let k = 0; k < r.w; k += 4 * dpr) o.fillRect(r.x + k, r.y, 2 * dpr, r.h); }
        if (e.tape) { o.fillStyle = 'rgba(255,255,255,0.6)'; o.fillRect(r.x, r.y + r.h - dpr, r.w, dpr); }
      });
      o.lineWidth = dpr;
      (loop.base[l] || []).forEach((e) => {
        const r = noteRect(e, G, dpr);
        o.globalAlpha = e === drag.e ? 1 : 0.7 * fade(l);
        o.strokeStyle = e === drag.e ? '#fff' : LAYER_COL[l];
        o.strokeRect(r.x + 0.5, r.y + 0.5, Math.max(1, r.w - 1), Math.max(1, r.h - 1));
      });
    });
    o.globalAlpha = 1;
  }

  // ---- editing ----
  const drag = { e: null };
  const rollPos = (ev) => {
    const r = roll.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    return { x: (ev.clientX - r.left) * dpr, y: (ev.clientY - r.top) * dpr, dpr, G: geom(S.loop, roll.width, roll.height, dpr) };
  };
  // Hits a layer's notes (not the glitched output). The layer being edited wins over the others.
  function hitTest(p) {
    const order = S.target === 'bass' ? ['bass', 'chords'] : ['chords', 'bass'];
    for (const l of order) {
      const ev = S.loop.base[l] || [];
      for (let i = ev.length - 1; i >= 0; i--) {
        const e = ev[i];
        const r = noteRect(e, p.G, p.dpr);
        // notes hit by row (same math as placing a note) so boundaries never disagree
        if (p.x >= r.x && p.x <= r.x + r.w && e.midi === Math.floor(p.G.M(p.y))) {
          return { e, l, edge: r.w > 10 * p.dpr && p.x > r.x + r.w - 7 * p.dpr };
        }
      }
    }
    return null;
  }
  const snapTo = (v, free) => (free || !S.snap ? Math.round(v * 4) / 4 : Math.round(v / S.snap) * S.snap);
  function removeEvent(e) {
    const arr = S.loop.base[e.layer], i = arr.indexOf(e);
    if (i >= 0) arr.splice(i, 1);
    E.editedLayer(e.layer); rollDirty = true; drawRoll(lastStep); syncEdit();
  }
  roll.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    if (!S.loop || !S.chops.length) return;
    const hit = hitTest(rollPos(ev));
    if (hit) removeEvent(hit.e);
  });
  roll.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || !S.loop || !S.chops.length) return;
    const p = rollPos(ev), hit = hitTest(p);
    if (hit && ev.altKey) { removeEvent(hit.e); return; }
    let e, mode;
    if (hit) { e = hit.e; mode = hit.edge ? 'resize' : 'move'; }
    else {
      const unit = S.snap || 0.25;
      const step = Math.max(0, Math.min(S.loop.total - unit, Math.floor(p.x / p.G.sx / unit) * unit));
      const layer = S.drawLayer;
      e = E.newEvent(layer, step, Math.floor(p.G.M(p.y)), 4);
      if (!e) { status('No chops in the pool to draw with.'); return; }
      S.loop.base[layer].push(e);
      mode = 'resize';
    }
    if (!hit) E.editedLayer(e.layer);
    drag.e = e; drag.mode = mode; drag.x0 = p.x; drag.y0 = p.y; drag.created = !hit;
    drag.step0 = e.step; drag.midi0 = e.midi; drag.dur0 = e.dur; drag.moved = false;
    roll.setPointerCapture(ev.pointerId);
    E.previewEvent(e);
    rollDirty = true; drawRoll(lastStep);
  });
  roll.addEventListener('pointermove', (ev) => {
    if (!S.loop || !S.chops.length) return;
    const p = rollPos(ev);
    if (!drag.e) {
      const hit = hitTest(p);
      roll.style.cursor = hit ? (hit.edge ? 'ew-resize' : 'grab') : 'crosshair';
      return;
    }
    const e = drag.e, total = S.loop.total, dx = (p.x - drag.x0) / p.G.sx;
    if (Math.abs(p.x - drag.x0) + Math.abs(p.y - drag.y0) > 3) drag.moved = true;
    if (drag.mode === 'move') {
      e.step = Math.max(0, Math.min(total - 0.25, snapTo(drag.step0 + dx, ev.shiftKey)));
      const m = drag.midi0 + Math.round((drag.y0 - p.y) / p.G.sy);
      if (m !== e.midi) { e.midi = m; E.previewEvent(e); }
    } else {
      const min = ev.shiftKey || !S.snap ? 0.25 : S.snap;
      e.dur = Math.max(min, Math.min(total - e.step, snapTo(drag.dur0 + dx, ev.shiftKey)));
    }
    if (drag.moved) E.editedLayer(e.layer); // re-glitch just this layer so it plays the edit right away
    rollDirty = true; drawRoll(lastStep);
  });
  const endDrag = () => {
    if (!drag.e) return;
    const l = drag.e.layer, changed = drag.moved || drag.created;
    drag.e = null;
    if (changed) E.editedLayer(l); rollDirty = true; drawRoll(lastStep); syncEdit();
  };
  roll.addEventListener('pointerup', endDrag);
  roll.addEventListener('pointercancel', endDrag);

  // ---------- animation ----------
  const scope = $('scope');
  let scopeBuf = null;
  function frame() {
    requestAnimationFrame(frame);
    if (!E.ctx) return;
    const now = E.ctx.currentTime;
    let cur = null;
    while (E.queue.length && E.queue[0].time <= now) cur = E.queue.shift();
    if (S.playing && cur) {
      drawRoll(cur.step);
      const ci = S.loop.chords.findIndex((c) => cur.step >= c.start && cur.step < c.start + c.len);
      if (ci !== lastChip) {
        lastChip = ci;
        Array.from($('prog').children).forEach((d, k) => d.classList.toggle('now', k === ci));
      }
      const hits = new Set(cur.voices.map((v) => v.chop).filter((c) => c >= 0));
      if (hits.size) {
        const pads = $('chops').children;
        hits.forEach((i) => {
          const p = pads[i]; if (!p) return;
          p.classList.add('flash');
          setTimeout(() => p.classList.remove('flash'), 90);
        });
        drawWave(hits);
      }
    } else if (!S.playing && lastChip !== -1) {
      lastChip = -1;
      Array.from($('prog').children).forEach((d) => d.classList.remove('now'));
      drawRoll();
    }
    const an = E.chain.analyser;
    if (!scopeBuf) scopeBuf = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(scopeBuf);
    const { w, h } = fitCanvas(scope);
    const g = scope.getContext('2d');
    g.fillStyle = '#0c1014'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#ff3d8b'; g.lineWidth = 1.5; g.beginPath();
    for (let i = 0; i < scopeBuf.length; i++) {
      const x = (i / (scopeBuf.length - 1)) * w, y = h / 2 - scopeBuf[i] * h * 0.45;
      if (i) g.lineTo(x, y); else g.moveTo(x, y);
    }
    g.stroke();
  }
  requestAnimationFrame(frame);

  // ---------- transport ----------
  function togglePlay() {
    if (S.playing) E.stop();
    else {
      if (!S.loop || !S.chops.length) { status('Load a sample (or DEMO VOX) first.'); return; }
      E.start();
    }
    $('playBtn').textContent = S.playing ? 'STOP' : 'PLAY';
  }
  $('playBtn').onclick = togglePlay;
  document.addEventListener('keydown', (ev) => {
    if (ev.target.matches && ev.target.matches('input[type=number], select')) return;
    if (ev.code === 'Space') { ev.preventDefault(); togglePlay(); }
    else if (ev.ctrlKey || ev.altKey || ev.metaKey) return;
    else if (ev.key === 'G') glitchTargets();
    else if (PIANO_KEYS[ev.key] != null) { if (!ev.repeat) pressKey(kbBase + PIANO_KEYS[ev.key]); }
    else if (ev.key === 'z' || ev.key === 'x') { kbBase = Math.max(12, Math.min(96, kbBase + (ev.key === 'x' ? 12 : -12))); renderPiano(); }
    else if (ev.key === 'n' || ev.key === 'N') { E.newProg(); refreshHarmony(); }
    else if (ev.key === 'r' || ev.key === 'R') { E.newGroove(); renderLayers(); drawRoll(); syncEdit(); }
    else if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
      if (!S.chops.length) return;
      S.sel = Math.max(0, Math.min(S.chops.length - 1, S.sel + (ev.key === 'ArrowRight' ? 1 : -1)));
      E.previewChop(S.sel); renderChops(); drawWave();
    }
  });

  // ---------- loading ----------
  async function loadBuffer(buf, name) {
    const wasPlaying = S.playing;
    if (wasPlaying) E.stop();
    $('busy').hidden = false;
    $('dropHint').hidden = true;
    $('sampleName').textContent = name;
    try {
      await E.load(buf, name, (p) => { $('busyText').textContent = `FINDING NOTES ${Math.round(p * 100)}%`; });
    } catch (err) {
      status('Could not analyze: ' + err.message);
      throw err;
    } finally { $('busy').hidden = true; }
    peaks = null;
    kbBase = null;
    syncControls(); renderChops(); drawWave(); renderPiano(); refreshHarmony();
    status(`${name}: ${S.chops.length} chops (${S.chops.filter((c) => c.pitched).length} pitched) · key ${keyText()} · progression ${S.sampleProg || '(none found)'}`);
    $('playBtn').textContent = 'PLAY';
    if (wasPlaying) togglePlay();
  }
  async function loadFile(file) {
    E.init(); E.resume();
    status(`Decoding ${file.name}...`);
    try {
      const buf = await E.ctx.decodeAudioData(await file.arrayBuffer());
      await loadBuffer(buf, file.name.replace(/\.[^.]+$/, ''));
    } catch (err) { status(`Could not open ${file.name}: ${err.message || err}`); }
  }
  $('loadBtn').onclick = () => $('fileInput').click();
  $('fileInput').onchange = (ev) => { if (ev.target.files[0]) loadFile(ev.target.files[0]); ev.target.value = ''; };
  $('demoBtn').onclick = async () => {
    E.init(); E.resume();
    status('Synthesizing demo vocal...');
    loadBuffer(await CC.makeDemo(E.ctx.sampleRate), 'demo vox');
  };
  const ww = $('waveWrap');
  ['dragenter', 'dragover'].forEach((t) => ww.addEventListener(t, (ev) => { ev.preventDefault(); ww.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((t) => ww.addEventListener(t, () => ww.classList.remove('drag')));
  ww.addEventListener('drop', (ev) => { ev.preventDefault(); const f = ev.dataTransfer.files[0]; if (f) loadFile(f); });
  document.addEventListener('dragover', (ev) => ev.preventDefault());
  document.addEventListener('drop', (ev) => { ev.preventDefault(); const f = ev.dataTransfer.files[0]; if (f && !ww.contains(ev.target)) loadFile(f); });

  // ---------- exports ----------
  const baseName = () => `${S.name || 'chops'}_${E.style().id}_${KEY_NAMES[S.key]}${S.mode === 'min' ? 'm' : ''}_${Math.round(S.bpm)}bpm`;
  $('wavBtn').onclick = async () => {
    if (!S.loop || !S.chops.length) return;
    const loops = parseInt($('loopsSel').value, 10);
    status('Rendering...');
    const out = await E.render(loops);
    const chs = [];
    for (let c = 0; c < out.numberOfChannels; c++) chs.push(out.getChannelData(c));
    CC.download(new Blob([CC.encodeWav(chs, out.sampleRate)], { type: 'audio/wav' }), baseName() + '.wav');
    status(`Exported ${loops} loop${loops > 1 ? 's' : ''} (${out.duration.toFixed(1)}s).`);
  };
  $('midiBtn').onclick = () => {
    if (!S.loop || !S.loop.events.length) return;
    CC.download(new Blob([E.midi()], { type: 'audio/midi' }), baseName() + '.mid');
    status('Exported MIDI: Chords (ch 1), Bass (ch 2).');
  };
  $('chopsBtn').onclick = () => {
    if (!S.chops.length) return;
    const files = S.chops.map((c, i) => ({
      name: `${String(i + 1).padStart(3, '0')}_${chopLabel(c).replace('#', 's')}.wav`,
      data: CC.regionToWav(S.src, c.start, c.end),
    }));
    CC.download(CC.zip(files), `${S.name || 'chops'}_chops.zip`);
    status(`Exported ${files.length} chops.`);
  };

  window.addEventListener('resize', () => { peaks = null; drawWave(); drawRoll(); });

  // ---------- boot ----------
  S.drawLayer = 'chords'; S.snap = 1;
  E.setProg(CC.colorizeProg(E.pool()[0], S.mode, S.color));
  syncControls();
  renderProg(); drawWave(); drawRoll(); renderPiano();
})(window.CC);
