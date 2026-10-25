// UI: controls, waveform + chop pads, key / style / progression, layer mixer, remix roll,
// animation (playhead, pad flashes, scope), file loading and exports.
(function (CC) {
  'use strict';
  const S = CC.S, E = CC.engine;
  const $ = (id) => document.getElementById(id);
  const KEY_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const pcColor = (pc, a) => `hsla(${(((pc % 12) + 12) % 12) * 30 + 200}, 85%, 62%, ${a == null ? 1 : a})`;
  const status = (msg) => { $('status').textContent = msg; };
  const flats = () => CC.useFlats(S.key, S.mode);

  // ---------- generic controls ----------
  function fmt(key, v) {
    if (key === 'minLen') return Math.round(v * 1000) + 'ms';
    if (key === 'cutoff') return v >= 0.999 ? 'OPEN' : Math.round(40 * Math.pow(2, v * 9)) + 'Hz';
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
    $('holdBtn').classList.toggle('on', S.hold);
    $('gridGroup').style.display = S.chopMode === 'grid' ? '' : 'none';
    renderKeys(); renderStyles(); renderLayers();
  }

  let rechopTimer = null;
  function rechopSoon() {
    clearTimeout(rechopTimer);
    rechopTimer = setTimeout(() => {
      if (!S.src) return;
      E.rechop(); E.generate();
      renderChops(); drawWave(); renderProg(); drawRoll();
      status(`${S.chops.length} chops (${S.chops.filter((c) => c.pitched).length} pitched)`);
    }, 120);
  }

  function onKeyChange(key) {
    if (['chopMode', 'grid', 'sens', 'minLen'].includes(key)) { rechopSoon(); return; }
    if (key === 'mode') { E.newProg(); refreshHarmony(); return; }
    if (key === 'bits' || key === 'rate') { E.init(); E.rebuildProcessed(); return; }
    if (key === 'pick' || key === 'cycle') { if (key === 'pick') { E.generate(); drawRoll(); } return; }
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
      if (el.hasAttribute('data-regen')) { E.generate(); drawRoll(); } else onKeyChange(key);
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
  $('holdBtn').onclick = () => { S.hold = !S.hold; syncControls(); };

  // ---------- key / style / progression ----------
  function renderKeys() {
    const seg = $('keySeg');
    if (!seg.children.length) {
      KEY_NAMES.forEach((n, k) => {
        const b = document.createElement('button');
        b.textContent = n;
        b.onclick = () => { S.key = k; E.generate(); refreshHarmony(); };
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
    const chords = S.loop ? S.loop.chords : CC.parseProg(S.progStr || E.pool()[0], S.key, S.mode, E.style().beats);
    chords.forEach((c, k) => {
      const d = document.createElement('div');
      d.className = 'chip';
      d.style.flexGrow = c.len ? c.len / 16 : c.beats / 4;
      d.innerHTML = `<span class="nm">${c.name}</span><span class="rm">${c.roman}</span>`;
      d.title = 'Hear this chord with your chops';
      d.onclick = () => E.previewChord(k);
      box.appendChild(d);
    });
    $('prevBtn').disabled = S.histPos <= 0;
    $('nextBtn').disabled = S.histPos >= S.history.length - 1;
  }
  function refreshHarmony() { renderKeys(); renderStyles(); renderLayers(); renderProg(); drawRoll(); syncSeg('mode'); }
  function syncSeg(key) {
    const seg = document.querySelector(`.seg[data-key="${key}"]`);
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', String(S[key]) === b.dataset.v));
  }

  $('newProgBtn').onclick = () => { E.newProg(); refreshHarmony(); };
  $('grooveBtn').onclick = () => { E.newGroove(); renderLayers(); drawRoll(); };
  $('glitchBtn').onclick = () => { E.glitchIt(); syncControls(); drawRoll(); };
  $('prevBtn').onclick = () => { if (E.histStep(-1)) { syncControls(); refreshHarmony(); } };
  $('nextBtn').onclick = () => { if (E.histStep(1)) { syncControls(); refreshHarmony(); } };
  $('detectBtn').onclick = () => {
    const k = CC.detectKey(S.chops);
    if (!k) { status('No pitched chops to detect a key from.'); return; }
    S.key = k.key; S.mode = k.mode;
    E.newProg(); refreshHarmony();
    status(`Detected key: ${KEY_NAMES[k.key]} ${k.mode === 'maj' ? 'major' : 'minor'}`);
  };

  E.onChange = (changed) => {
    if (changed) { renderStyles(); renderLayers(); renderProg(); }
    drawRoll();
  };

  // ---------- layers ----------
  const LAYER_LABEL = { chords: 'CHORDS', lead: 'LEAD', bass: 'BASS', perc: 'PERC' };
  function renderLayers() {
    const box = $('layers');
    const st = E.style();
    box.innerHTML = '';
    CC.LAYERS.forEach((l) => {
      const L = S.layers[l];
      const row = document.createElement('div');
      row.className = 'layer';
      const pats = st[l].map((_, i) => `<button data-p="${i}" class="${S.pat[l] === i ? 'on' : ''}">${i + 1}</button>`).join('');
      const octs = l === 'perc' ? '' : `<span class="mini">OCT</span><div class="seg oct">${[-1, 0, 1].map((o) => `<button data-o="${o}" class="${L.oct === o ? 'on' : ''}">${o > 0 ? '+' + o : o}</button>`).join('')}</div>`;
      const src = l === 'bass' ? `<div class="seg src"><button data-s="chop" class="${L.src === 'chop' ? 'on' : ''}">CHOP</button><button data-s="sub" class="${L.src === 'sub' ? 'on' : ''}">SUB</button></div>` : '';
      row.innerHTML = `<div class="lname"><i style="background:var(--${l})"></i>${LAYER_LABEL[l]}</div>
        <div class="ctl"><button class="btn small onoff ${L.on ? 'on' : ''}">${L.on ? 'ON' : 'OFF'}</button>
        <input type="range" min="0" max="1" step="0.01" value="${L.level}" title="Level">
        <span class="mini">PATTERN</span><div class="seg pats">${pats}</div>${octs}${src}</div>`;
      row.querySelector('.onoff').onclick = () => { L.on = !L.on; E.updateChain(); renderLayers(); };
      row.querySelector('input').oninput = (ev) => { L.level = parseFloat(ev.target.value); E.updateChain(); };
      row.querySelector('.pats').onclick = (ev) => {
        const b = ev.target.closest('button'); if (!b) return;
        S.pat[l] = +b.dataset.p; E.generate(); renderLayers(); drawRoll();
      };
      const oct = row.querySelector('.oct');
      if (oct) oct.onclick = (ev) => {
        const b = ev.target.closest('button'); if (!b) return;
        L.oct = +b.dataset.o; E.generate(); renderLayers(); drawRoll();
      };
      const sr = row.querySelector('.src');
      if (sr) sr.onclick = (ev) => {
        const b = ev.target.closest('button'); if (!b) return;
        L.src = b.dataset.s; E.generate(); renderLayers(); drawRoll();
      };
      box.appendChild(row);
    });
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
        if (ev.ctrlKey || ev.shiftKey) { c.on = !c.on; E.generate(); drawRoll(); }
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
    E.generate(); renderChops(); drawWave(); drawRoll();
  };
  $('poolBtn').onclick = () => {
    const c = S.chops[S.sel]; if (!c) return;
    c.on = !c.on; E.generate(); renderChops(); drawRoll();
  };
  $('allInBtn').onclick = () => { S.chops.forEach((c) => { c.on = true; }); E.generate(); renderChops(); drawRoll(); };
  $('pitchedBtn').onclick = () => { S.chops.forEach((c) => { c.on = c.pitched || c.note != null; }); E.generate(); renderChops(); drawRoll(); };

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
  function afterEdit() { E.generate(); renderChops(); drawWave(); drawRoll(); status(`${S.chops.length} chops`); }

  // ---------- remix roll ----------
  const roll = $('roll');
  const LAYER_COL = { chords: '#3de0ff', lead: '#ff3d8b', bass: '#ffc94a', perc: '#a59bbd' };
  let rollCache = null;
  function drawRoll(step) {
    const { w, h, dpr } = fitCanvas(roll);
    const g = roll.getContext('2d');
    const loop = S.loop;
    if (step == null || !rollCache || rollCache.w !== w || rollCache.h !== h || rollCache.loop !== loop) {
      const off = document.createElement('canvas');
      off.width = w; off.height = h;
      const o = off.getContext('2d');
      o.fillStyle = '#0c1014'; o.fillRect(0, 0, w, h);
      if (loop && loop.events.length) paintRoll(o, loop, w, h, dpr);
      else {
        o.fillStyle = '#4f8a69'; o.font = `700 ${13 * dpr}px Consolas, monospace`; o.textAlign = 'center';
        o.fillText(S.src ? 'No usable chops in the pool' : 'Load a sample to hear it remixed onto chords', w / 2, h / 2);
      }
      rollCache = { w, h, loop, img: off };
    }
    g.drawImage(rollCache.img, 0, 0);
    if (step != null && loop) {
      const x = (step / loop.total) * w;
      g.fillStyle = 'rgba(255,255,255,0.85)'; g.fillRect(x, 0, Math.max(1, dpr), h);
    }
  }
  function paintRoll(o, loop, w, h, dpr) {
    const top = 18 * dpr, percH = 16 * dpr, bottom = h - percH - 4 * dpr;
    const pitched = loop.events.filter((e) => e.midi != null);
    let lo = Math.min(...pitched.map((e) => e.midi)), hi = Math.max(...pitched.map((e) => e.midi));
    if (!isFinite(lo)) { lo = 36; hi = 84; }
    lo -= 2; hi += 2;
    const sx = w / loop.total, sy = (bottom - top) / Math.max(12, hi - lo);
    const Y = (m) => bottom - (m - lo) * sy;
    // chord regions + bar lines
    loop.chords.forEach((c, k) => {
      o.fillStyle = k % 2 ? 'rgba(255,255,255,0.025)' : 'rgba(255,255,255,0.05)';
      o.fillRect(c.start * sx, 0, c.len * sx, h);
      o.fillStyle = '#7dffb0'; o.font = `700 ${11 * dpr}px Consolas, monospace`;
      o.fillText(c.name, c.start * sx + 4 * dpr, 13 * dpr);
    });
    for (let s = 0; s <= loop.total; s += 4) {
      o.fillStyle = s % 16 ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.16)';
      o.fillRect(s * sx, top - 4 * dpr, Math.max(1, dpr * (s % 16 ? 0.5 : 1)), h);
    }
    for (let m = Math.ceil(lo); m <= hi; m++) {
      if (m % 12 === S.key) { o.fillStyle = 'rgba(125,255,176,0.07)'; o.fillRect(0, Y(m) - sy, w, sy); }
    }
    ['bass', 'chords', 'lead'].forEach((l) => {
      loop.events.filter((e) => e.layer === l).forEach((e) => {
        const x = e.step * sx, y = Y(e.midi) - sy, ww = Math.max(2 * dpr, e.dur * sx - dpr), hh = Math.max(2 * dpr, sy - dpr);
        o.globalAlpha = 0.45 + e.vel * 0.55;
        o.fillStyle = LAYER_COL[l];
        o.fillRect(x, y, ww, hh);
        if (e.rev) { o.fillStyle = 'rgba(12,16,20,0.55)'; for (let k = 0; k < ww; k += 4 * dpr) o.fillRect(x + k, y, 2 * dpr, hh); }
        if (e.tape) { o.fillStyle = 'rgba(255,255,255,0.6)'; o.fillRect(x, y + hh - dpr, ww, dpr); }
      });
    });
    o.globalAlpha = 1;
    loop.events.filter((e) => e.layer === 'perc').forEach((e) => {
      o.globalAlpha = 0.4 + e.vel * 0.6;
      o.fillStyle = LAYER_COL.perc;
      o.fillRect(e.step * sx, h - percH, Math.max(2 * dpr, sx * 0.7), percH - 2 * dpr);
    });
    o.globalAlpha = 1;
  }

  // ---------- animation ----------
  const scope = $('scope');
  let scopeBuf = null, lastChip = -1;
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
    if (ev.target.matches('input[type=number], select')) return;
    if (ev.code === 'Space') { ev.preventDefault(); togglePlay(); }
    else if (ev.key === 'n' || ev.key === 'N') { E.newProg(); refreshHarmony(); }
    else if (ev.key === 'g' || ev.key === 'G') { E.glitchIt(); syncControls(); drawRoll(); }
    else if (ev.key === 'r' || ev.key === 'R') { E.newGroove(); renderLayers(); drawRoll(); }
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
    syncControls(); renderChops(); drawWave(); refreshHarmony();
    status(`${name}: ${S.chops.length} chops (${S.chops.filter((c) => c.pitched).length} pitched) · key ${KEY_NAMES[S.key]} ${S.mode === 'maj' ? 'major' : 'minor'}`);
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
    status('Exported MIDI: Chords (ch 1), Lead (ch 2), Bass (ch 3).');
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
  E.setStyle(S.style);
  S.progStr = '';
  syncControls();
  renderProg(); drawWave(); drawRoll();
})(window.CC);
