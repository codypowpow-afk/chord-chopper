// DSP + file helpers: pitch tracking, note / onset / grid chopping, key detection,
// sampler degradation, WAV / MIDI / ZIP encoders, seeded RNG.
window.CC = window.CC || {};

(function (CC) {
  'use strict';

  // ---------- RNG ----------
  CC.rng = function (seed) {
    let a = seed >>> 0;
    const r = function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    r.int = (n) => Math.floor(r() * n);
    r.pick = (arr) => arr[Math.floor(r() * arr.length)];
    r.chance = (p) => r() < p;
    return r;
  };

  CC.mono = function (buffer) {
    const n = buffer.length, out = new Float32Array(n);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const d = buffer.getChannelData(c);
      for (let i = 0; i < n; i++) out[i] += d[i];
    }
    const k = 1 / buffer.numberOfChannels;
    for (let i = 0; i < n; i++) out[i] *= k;
    return out;
  };

  const median = (arr) => {
    const s = arr.slice().sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };

  // ---------- pitch tracking (YIN) ----------
  // Runs on a ~22 kHz copy, 65 Hz - 1.4 kHz. The hop grows with file length so a full song
  // still tracks in a couple of seconds. Async so the UI can show progress.
  CC.track = async function (buffer, onProgress) {
    const x = CC.mono(buffer), sr = buffer.sampleRate;
    const D = Math.max(1, Math.round(sr / 22050));
    const n = Math.floor(x.length / D), y = new Float32Array(n);
    for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k < D; k++) s += x[i * D + k]; y[i] = s / D; }
    const srd = sr / D, W = 640;
    const tauMin = Math.max(2, Math.floor(srd / 1400)), tauMax = Math.ceil(srd / 65);
    const hop = Math.max(128, Math.ceil(n / 2400));
    const frames = Math.max(0, Math.floor((n - W - tauMax) / hop) + 1);
    const midi = new Float32Array(frames).fill(NaN), ap = new Float32Array(frames).fill(1), rms = new Float32Array(frames);
    let maxRms = 1e-9;
    for (let f = 0; f < frames; f++) {
      let s = 0;
      for (let j = 0, o = f * hop; j < W; j++) s += y[o + j] * y[o + j];
      rms[f] = Math.sqrt(s / W);
      if (rms[f] > maxRms) maxRms = rms[f];
    }
    const gate = maxRms * 0.025, d = new Float32Array(tauMax + 2);
    for (let f = 0; f < frames; f++) {
      if (onProgress && f % 300 === 0) { onProgress(f / frames); await new Promise((r) => setTimeout(r, 0)); }
      if (rms[f] < gate) continue;
      const o = f * hop;
      for (let tau = 1; tau <= tauMax + 1; tau++) {
        let s = 0;
        for (let j = 0; j < W; j++) { const v = y[o + j] - y[o + j + tau]; s += v * v; }
        d[tau] = s;
      }
      let run = 0;
      for (let tau = 1; tau <= tauMax + 1; tau++) { run += d[tau]; d[tau] = run > 0 ? (d[tau] * tau) / run : 1; }
      let best = -1;
      for (let tau = tauMin; tau <= tauMax; tau++) {
        if (d[tau] < 0.15) { while (tau < tauMax && d[tau + 1] < d[tau]) tau++; best = tau; break; }
      }
      if (best < 0) { best = tauMin; for (let tau = tauMin; tau <= tauMax; tau++) if (d[tau] < d[best]) best = tau; }
      let t = best;
      const s0 = d[best - 1], s1 = d[best], s2 = d[best + 1], den = s0 + s2 - 2 * s1;
      if (den > 0) t = best + (s0 - s2) / (2 * den);
      ap[f] = s1;
      if (s1 < 0.3) midi[f] = 69 + 12 * Math.log2(srd / t / 440);
    }
    if (onProgress) onProgress(1);
    // frame f covers samples [f*hop*D, f*hop*D + W*D) of the original
    return { hop: hop * D, win: W * D, frames, midi, ap, rms, maxRms };
  };

  const frameRange = (tr, start, end) => {
    const a = Math.max(0, Math.floor((start - tr.win * 0.25) / tr.hop));
    const b = Math.min(tr.frames, Math.max(a + 1, Math.ceil((end - tr.win * 0.75) / tr.hop)));
    return [a, b];
  };

  // Pitch, confidence and brightness of one chop from the shared track.
  CC.analyzeChop = function (buffer, tr, x, chop) {
    const sr = buffer.sampleRate;
    const [a, b] = frameRange(tr, chop.start + 0.012 * sr, chop.end);
    const voiced = [];
    let apSum = 0, counted = 0, loud = 0;
    for (let f = a; f < b; f++) {
      if (tr.rms[f] < tr.maxRms * 0.025) continue;
      counted++;
      loud = Math.max(loud, tr.rms[f]);
      if (!isNaN(tr.midi[f])) { voiced.push(tr.midi[f]); apSum += tr.ap[f]; }
    }
    let zc = 0, e = 0;
    for (let i = chop.start + 1; i < chop.end; i++) {
      if ((x[i] >= 0) !== (x[i - 1] >= 0)) zc++;
      e += x[i] * x[i];
    }
    const len = Math.max(1, chop.end - chop.start);
    chop.bright = (zc / len) * sr; // zero-crossing rate in Hz
    chop.rms = Math.sqrt(e / len);
    chop.conf = counted ? (voiced.length / counted) * (1 - apSum / Math.max(1, voiced.length)) : 0;
    chop.pitched = voiced.length >= 1 && chop.conf > 0.3;
    chop.midi = voiced.length ? median(voiced) : 60;
    return chop;
  };

  // ---------- onset detection ----------
  // Log-energy rise on full band + a high-frequency-emphasised band. Threshold is relative to a
  // typical strong onset in this file, so quiet and loud material slice alike.
  CC.detectOnsets = function (buffer, sensitivity, minGapSec) {
    const x = CC.mono(buffer);
    const sr = buffer.sampleRate;
    const hop = 256, win = 1024, L = 6;
    const frames = Math.floor((x.length - win) / hop);
    if (frames < L + 4) return [0];
    const eFull = new Float32Array(frames), eHi = new Float32Array(frames);
    let maxE = 0;
    for (let f = 0; f < frames; f++) {
      let s = 0, sh = 0, prev = x[f * hop];
      for (let i = 0; i < win; i += 2) {
        const v = x[f * hop + i];
        s += v * v;
        const dd = v - prev; prev = v;
        sh += dd * dd;
      }
      eFull[f] = s; eHi[f] = sh;
      maxE = Math.max(maxE, s);
    }
    const eps = 1e-5 * maxE + 1e-12;
    const odf = new Float32Array(frames);
    for (let f = L; f < frames; f++) {
      const rf = Math.log((eFull[f] + eps) / (eFull[f - L] + eps));
      const rh = Math.log((eHi[f] + eps) / (eHi[f - L] + eps));
      odf[f] = Math.max(0, 0.5 * rf + 0.5 * rh);
    }
    const minGapF = Math.max(2, Math.round((minGapSec * sr) / hop));
    const peaks = [];
    for (let f = L; f < frames - 3; f++) {
      const v = odf[f];
      if (v <= 0) continue;
      let isMax = true;
      for (let k = -3; k <= 3; k++) if (odf[f + k] > v) { isMax = false; break; }
      if (!isMax) continue;
      if (peaks.length && f - peaks[peaks.length - 1].f < minGapF) {
        if (v > peaks[peaks.length - 1].v) peaks[peaks.length - 1] = { f, v };
        continue;
      }
      peaks.push({ f, v });
    }
    if (!peaks.length) return [0];
    const sorted = peaks.map((p) => p.v).sort((a, b) => b - a);
    const ref = sorted[Math.min(sorted.length - 1, Math.round(sorted.length * 0.35))];
    const thresh = ref * (1.5 - sensitivity * 1.4);
    const pos = peaks.filter((p) => p.v >= thresh).map((p) => {
      // walk back from the loudest block in the frame onto the attack, then to a zero crossing
      const a = p.f * hop, b = Math.min(x.length, a + win + 256), B = 32;
      let pk = a, pv = 0;
      for (let i = a; i < b; i++) if (Math.abs(x[i]) > pv) { pv = Math.abs(x[i]); pk = i; }
      let s = pk;
      let env = pv;
      while (s > a - hop * L && s > B) {
        let m = 0;
        for (let k = s - B; k < s; k++) m = Math.max(m, Math.abs(x[k]));
        if (m < env * 0.2) break;
        s -= B;
      }
      for (let i = 0; i < 200 && s > 0; i++, s--) if ((x[s] >= 0) !== (x[s - 1] >= 0)) break;
      return Math.max(0, s);
    });
    return pos;
  };

  // ---------- chopping ----------
  // All modes return [{start, end}] in samples; silent stretches are dropped.
  const silentRun = (tr, start, end) => {
    const [a, b] = frameRange(tr, start, end);
    for (let f = a; f < b; f++) if (tr.rms[f] >= tr.maxRms * 0.03) return false;
    return true;
  };

  CC.chopGrid = function (buffer, tr, count) {
    const out = [], n = buffer.length;
    for (let i = 0; i < count; i++) out.push({ start: Math.round((i * n) / count), end: Math.round(((i + 1) * n) / count) });
    return out.filter((c) => !silentRun(tr, c.start, c.end));
  };

  CC.chopOnsets = function (buffer, tr, sens, minLen) {
    const sr = buffer.sampleRate;
    const pos = CC.detectOnsets(buffer, sens, minLen);
    if (!pos.length || pos[0] > 0.05 * sr) pos.unshift(0);
    const out = [];
    for (let i = 0; i < pos.length; i++) {
      const start = pos[i], end = i + 1 < pos.length ? pos[i + 1] : buffer.length;
      out.push({ start, end: trimTail(tr, start, end) });
    }
    return out.filter((c) => c.end - c.start > 0.02 * sr && !silentRun(tr, c.start, c.end));
  };

  // Ends a chop where it falls silent (so a note followed by a breath doesn't drag the breath along).
  function trimTail(tr, start, end) {
    const [a, b] = frameRange(tr, start, end);
    for (let f = b - 1; f > a; f--) {
      if (tr.rms[f] >= tr.maxRms * 0.03) return Math.min(end, f * tr.hop + tr.win);
    }
    return end;
  }

  // Splits on pitch changes (held for ~35 ms with hysteresis), voicing changes, silence and
  // re-articulations (onsets), then merges anything shorter than minLen into its neighbour.
  CC.chopNotes = function (buffer, tr, sens, minLen) {
    const sr = buffer.sampleRate, F = tr.frames;
    const sm = new Float32Array(F).fill(NaN);
    for (let f = 0; f < F; f++) {
      if (isNaN(tr.midi[f])) continue;
      const w = [];
      for (let k = -2; k <= 2; k++) if (f + k >= 0 && f + k < F && !isNaN(tr.midi[f + k])) w.push(tr.midi[f + k]);
      sm[f] = median(w);
    }
    const hold = Math.max(2, Math.round((0.035 * sr) / tr.hop));
    const silent = (f) => tr.rms[f] < tr.maxRms * 0.03;
    const segs = [];
    let cur = null, pendNote = null, pendStart = 0, pend = 0;
    const close = (f) => { if (cur) segs.push({ s: cur.s, e: f, note: cur.note }); cur = null; };
    for (let f = 0; f < F; f++) {
      if (silent(f)) { close(f); pend = 0; continue; }
      let note = isNaN(sm[f]) ? 'u' : Math.round(sm[f]);
      if (cur && cur.note !== 'u' && note !== 'u' && Math.abs(sm[f] - cur.note) < 0.7) note = cur.note;
      if (!cur) { cur = { s: f, note }; pend = 0; continue; }
      if (note === cur.note) { pend = 0; continue; }
      if (pendNote !== note || !pend) { pendNote = note; pendStart = f; pend = 1; } else pend++;
      if (pend >= hold) { close(pendStart); cur = { s: pendStart, note }; pend = 0; }
    }
    close(F);
    const fs = (f) => Math.max(0, Math.round(f * tr.hop + tr.win / 2 - tr.hop / 2));
    let chops = segs.map((g) => ({ start: fs(g.s), end: Math.min(buffer.length, fs(g.e) + tr.hop), note: g.note }));
    // re-articulated notes (same pitch sung twice) only show up as onsets
    const onsets = CC.detectOnsets(buffer, sens * 0.85, minLen);
    const snap = 0.03 * sr;
    chops.forEach((c) => {
      const near = onsets.find((o) => Math.abs(o - c.start) < snap);
      if (near != null) c.start = near;
    });
    const split = [];
    chops.forEach((c) => {
      let s = c.start;
      onsets.forEach((o) => {
        if (o - s > minLen * sr && c.end - o > minLen * sr) { split.push({ start: s, end: o, note: c.note }); s = o; }
      });
      split.push({ start: s, end: c.end, note: c.note });
    });
    chops = split;
    // merge short bits into the previous chop when touching, else into the next, else drop
    const min = minLen * sr;
    for (let pass = 0; pass < 2; pass++) {
      const out = [];
      chops.forEach((c) => {
        const prev = out[out.length - 1];
        if (c.end - c.start >= min) { out.push(c); return; }
        if (prev && c.start - prev.end < 0.01 * sr) prev.end = c.end;
        else out.push(c);
      });
      chops = out.filter((c, i) => {
        if (c.end - c.start >= min) return true;
        const next = out[i + 1];
        if (next && next.start - c.end < 0.01 * sr) { next.start = c.start; return false; }
        return c.end - c.start >= min * 0.5;
      });
    }
    // keep the chop count usable on long files: merge the shortest neighbours
    while (chops.length > 128) {
      let k = 0;
      for (let i = 1; i < chops.length - 1; i++) if (chops[i].end - chops[i].start < chops[k].end - chops[k].start) k = i;
      const t = chops[k], m = chops[k + 1] || chops[k - 1];
      m.start = Math.min(m.start, t.start); m.end = Math.max(m.end, t.end);
      chops.splice(k, 1);
    }
    return chops.map((c) => ({ start: c.start, end: c.end }));
  };

  // ---------- key detection ----------
  // Krumhansl-Kessler profiles against a histogram of chop pitch classes weighted by length * confidence.
  const KK_MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const KK_MIN = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  CC.detectKey = function (chops) {
    const h = new Array(12).fill(0);
    chops.forEach((c) => {
      if (!c.pitched) return;
      h[((Math.round(c.note != null ? c.note : c.midi) % 12) + 12) % 12] += (c.end - c.start) * (0.3 + c.conf);
    });
    if (h.every((v) => !v)) return null;
    const corr = (prof, k) => {
      const mx = h.reduce((a, b) => a + b) / 12, mp = prof.reduce((a, b) => a + b) / 12;
      let num = 0, dx = 0, dp = 0;
      for (let i = 0; i < 12; i++) {
        const a = h[(i + k) % 12] - mx, b = prof[i] - mp;
        num += a * b; dx += a * a; dp += b * b;
      }
      return num / Math.sqrt(dx * dp + 1e-12);
    };
    let best = { key: 0, mode: 'maj', r: -2 };
    for (let k = 0; k < 12; k++) {
      const a = corr(KK_MAJ, k), b = corr(KK_MIN, k);
      if (a > best.r) best = { key: k, mode: 'maj', r: a };
      if (b > best.r) best = { key: k, mode: 'min', r: b };
    }
    return best;
  };

  // ---------- sampler degradation ----------
  CC.degrade = function (ctx, src, opts) {
    const out = ctx.createBuffer(src.numberOfChannels, src.length, src.sampleRate);
    const hold = opts.rate ? src.sampleRate / opts.rate : 1;
    const levels = opts.bits < 16 ? Math.pow(2, opts.bits - 1) : 0;
    for (let c = 0; c < src.numberOfChannels; c++) {
      const s = src.getChannelData(c), o = out.getChannelData(c);
      let phase = hold, held = 0;
      for (let i = 0; i < src.length; i++) {
        phase += 1;
        if (phase >= hold) { phase -= hold; held = s[i]; }
        o[i] = levels ? Math.round(held * levels) / levels : held;
      }
    }
    return out;
  };

  CC.reverseBuffer = function (ctx, src) {
    const out = ctx.createBuffer(src.numberOfChannels, src.length, src.sampleRate);
    for (let c = 0; c < src.numberOfChannels; c++) {
      const s = src.getChannelData(c), o = out.getChannelData(c), n = s.length;
      for (let i = 0; i < n; i++) o[i] = s[n - 1 - i];
    }
    return out;
  };

  // ---------- encoders ----------
  CC.encodeWav = function (channels, sampleRate) {
    const n = channels[0].length, chs = channels.length;
    const buf = new ArrayBuffer(44 + n * chs * 2);
    const dv = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); dv.setUint32(4, 36 + n * chs * 2, true); w(8, 'WAVE');
    w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, chs, true);
    dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * chs * 2, true);
    dv.setUint16(32, chs * 2, true); dv.setUint16(34, 16, true);
    w(36, 'data'); dv.setUint32(40, n * chs * 2, true);
    let o = 44;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < chs; c++) {
        const v = Math.max(-1, Math.min(1, channels[c][i]));
        dv.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true); o += 2;
      }
    }
    return new Uint8Array(buf);
  };

  CC.regionToWav = function (buffer, start, end) {
    const chs = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const seg = buffer.getChannelData(c).slice(start, end);
      const fade = Math.min(128, seg.length);
      for (let i = 0; i < fade; i++) seg[seg.length - 1 - i] *= i / fade;
      chs.push(seg);
    }
    return CC.encodeWav(chs, buffer.sampleRate);
  };

  // Format-1 MIDI. tracks: [{name, channel, events: [{step (16ths), len, note, vel 0..1}]}]
  CC.encodeMidi = function (tracks, bpm, totalSteps) {
    const PPQ = 96, TPS = PPQ / 4;
    const chunk = (type, bytes) => {
      const out = [];
      for (let i = 0; i < 4; i++) out.push(type.charCodeAt(i));
      out.push((bytes.length >>> 24) & 255, (bytes.length >>> 16) & 255, (bytes.length >>> 8) & 255, bytes.length & 255);
      return out.concat(bytes);
    };
    const vlq = (bytes, v) => {
      const st = [v & 0x7f];
      while ((v >>= 7)) st.unshift((v & 0x7f) | 0x80);
      bytes.push(...st);
    };
    const enc = new TextEncoder();
    const out = chunk('MThd', [0, 1, 0, tracks.length + 1, (PPQ >> 8) & 255, PPQ & 255]);
    const tempo = Math.round(60000000 / bpm);
    const meta = [];
    vlq(meta, 0); meta.push(0xff, 0x51, 0x03, (tempo >> 16) & 255, (tempo >> 8) & 255, tempo & 255);
    vlq(meta, 0); meta.push(0xff, 0x58, 0x04, 4, 2, 24, 8);
    vlq(meta, totalSteps * TPS); meta.push(0xff, 0x2f, 0x00);
    out.push(...chunk('MTrk', meta));
    tracks.forEach((tk) => {
      const msgs = [];
      tk.events.forEach((e) => {
        const on = Math.round(e.step * TPS), off = Math.max(on + 1, Math.round((e.step + e.len) * TPS) - 1);
        const vel = Math.max(1, Math.min(127, Math.round(e.vel * 127)));
        const note = Math.max(0, Math.min(127, Math.round(e.note)));
        msgs.push({ t: on, d: [0x90 | tk.channel, note, vel] });
        msgs.push({ t: off, d: [0x80 | tk.channel, note, 0] });
      });
      msgs.sort((a, b) => a.t - b.t || ((a.d[0] & 0xf0) === 0x80 ? -1 : 1));
      const bytes = [];
      const name = Array.from(enc.encode(tk.name));
      vlq(bytes, 0); bytes.push(0xff, 0x03); vlq(bytes, name.length); bytes.push(...name);
      let last = 0;
      msgs.forEach((m) => { vlq(bytes, m.t - last); last = m.t; bytes.push(...m.d); });
      vlq(bytes, Math.max(0, totalSteps * TPS - last)); bytes.push(0xff, 0x2f, 0x00);
      out.push(...chunk('MTrk', bytes));
    });
    return new Uint8Array(out);
  };

  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (d) => {
    let c = 0xffffffff;
    for (let i = 0; i < d.length; i++) c = crcTable[(c ^ d[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  // Uncompressed ZIP. files: [{name, data: Uint8Array}]
  CC.zip = function (files) {
    const enc = new TextEncoder();
    const parts = [], central = [];
    let offset = 0;
    files.forEach((f) => {
      const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint32(14, crc, true);
      lh.setUint32(18, size, true); lh.setUint32(22, size, true); lh.setUint16(26, name.length, true);
      parts.push(new Uint8Array(lh.buffer), name, f.data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
      ch.setUint32(16, crc, true); ch.setUint32(20, size, true); ch.setUint32(24, size, true);
      ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + size;
    });
    const cSize = central.reduce((s, p) => s + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cSize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
  };

  CC.download = function (blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };

  // ---------- demo sample ----------
  // A sung-sounding phrase (saw + pulse through vowel formants, with vibrato) and a few
  // breathy consonant hits, so the app is playable before any file is loaded.
  CC.makeDemo = async function (sampleRate) {
    const notes = [57, 60, 64, 62, 60, 67, 65, 64, 62, 59, 60, 64, 69, 67, 64, 62];
    const vowels = [[800, 1150, 2900], [400, 1700, 2600], [350, 600, 2700], [600, 1000, 2550], [300, 2300, 3000]];
    const dur = 0.42, gap = 0.08, len = notes.length * (dur + gap) + 0.5;
    const off = new OfflineAudioContext(1, Math.ceil(len * sampleRate), sampleRate);
    const out = off.createGain(); out.gain.value = 0.5; out.connect(off.destination);
    const noise = off.createBuffer(1, sampleRate, sampleRate);
    const nd = noise.getChannelData(0), r = CC.rng(7);
    for (let i = 0; i < nd.length; i++) nd[i] = r() * 2 - 1;
    notes.forEach((m, i) => {
      const t = 0.12 + i * (dur + gap), f = 440 * Math.pow(2, (m - 69) / 12);
      const env = off.createGain();
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(1, t + 0.03);
      env.gain.setValueAtTime(0.85, t + dur - 0.06);
      env.gain.linearRampToValueAtTime(0, t + dur);
      const vib = off.createOscillator(), vg = off.createGain();
      vib.frequency.value = 5.2; vg.gain.value = f * 0.012;
      vib.connect(vg);
      const v = vowels[i % vowels.length];
      [['sawtooth', 1], ['square', 0.35]].forEach(([type, lvl]) => {
        const o = off.createOscillator(), g = off.createGain();
        o.type = type; o.frequency.value = f; vg.connect(o.frequency);
        g.gain.value = lvl * 0.3;
        o.connect(g);
        v.forEach((fq, k) => {
          const bp = off.createBiquadFilter();
          bp.type = 'bandpass'; bp.frequency.value = fq; bp.Q.value = 6 + k * 3;
          const bg = off.createGain(); bg.gain.value = [1.4, 0.8, 0.35][k] * 3;
          g.connect(bp); bp.connect(bg); bg.connect(env);
        });
        o.start(t); o.stop(t + dur + 0.02);
      });
      vib.start(t); vib.stop(t + dur + 0.02);
      env.connect(out);
      if (i % 4 === 0 || i % 7 === 3) { // "t" / "s" consonant before the note
        const ns = off.createBufferSource(), hp = off.createBiquadFilter(), ng = off.createGain();
        ns.buffer = noise; hp.type = 'highpass'; hp.frequency.value = i % 7 === 3 ? 6500 : 3000;
        ng.gain.setValueAtTime(0.5, t - 0.075); ng.gain.exponentialRampToValueAtTime(0.001, t - 0.005);
        ns.connect(hp); hp.connect(ng); ng.connect(out);
        ns.start(t - 0.075); ns.stop(t);
      }
    });
    const buf = await off.startRendering();
    const d = buf.getChannelData(0);
    let pk = 1e-6;
    for (let i = 0; i < d.length; i++) pk = Math.max(pk, Math.abs(d[i]));
    for (let i = 0; i < d.length; i++) d[i] *= 0.9 / pk;
    return buf;
  };
})(window.CC);
