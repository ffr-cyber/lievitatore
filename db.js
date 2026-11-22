// db.js - accesso ai dati: Firebase (reale) oppure DEMO (dati simulati, solo nel browser).
import { kT, t28di, VdiP } from './model.js';

const FB_VER = '10.14.1';
const toRows = (obj) => Object.entries(obj || {}).map(([k, v]) => ({ t: Number(k) * 1000, ...v })).sort((a, b) => a.t - b.t);

// ===================================================================== FIREBASE
async function firebaseDb(cfg) {
  const base = `https://www.gstatic.com/firebasejs/${FB_VER}`;
  const [{ initializeApp }, A, D] = await Promise.all([
    import(`${base}/firebase-app.js`), import(`${base}/firebase-auth.js`), import(`${base}/firebase-database.js`)]);
  const app = initializeApp(cfg);
  const auth = A.getAuth(app);
  const rtdb = D.getDatabase(app);
  const R = (p) => D.ref(rtdb, p);

  const api = {
    mode: 'firebase',
    onAuth: (cb) => A.onAuthStateChanged(auth, (u) => cb(u ? { email: u.email } : null)),
    signIn: (e, p) => A.signInWithEmailAndPassword(auth, e, p),
    signOut: () => A.signOut(auth),
    onLive(cb) { return D.onValue(R('live'), (s) => cb(s.val())); },
    onRuns(cb) { return D.onValue(R('runs'), (s) => cb(Object.values(s.val() || {}))); },
    async series(id, last = 3000) {
      const s = await D.get(D.query(R('series/' + id), D.orderByKey(), D.limitToLast(last)));
      return toRows(s.val());
    },
    watchSeries(id, last, cb) {
      let stop = false;
      const tick = async () => { if (stop) return; try { cb(await api.series(id, last)); } catch (e) { /* offline */ } };
      tick(); const h = setInterval(tick, 60000);
      return () => { stop = true; clearInterval(h); };
    },
    async sendCmd(action, params = {}, timeoutMs = 45000) {
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      await D.set(R('cmd'), { id, action, params, ts: Math.floor(Date.now() / 1000) });
      return new Promise((resolve) => {
        let done = false;
        const off = D.onValue(R('ack'), (s) => {
          const a = s.val(); if (done || !a || a.id !== id) return;
          done = true; off(); resolve({ ok: !!a.ok, msg: a.msg || '' });
        });
        setTimeout(() => { if (!done) { done = true; off(); resolve({ ok: false, msg: 'La scheda non ha risposto (spenta, offline o in attesa): riprova.' }); } }, timeoutMs);
      });
    },
    saveRun: (id, data) => D.set(R('runs/' + id), data),
    updateRun: (id, patch) => D.update(R('runs/' + id), patch),
    deleteRun: async (id) => { await D.remove(R('runs/' + id)); await D.remove(R('series/' + id)); },
    async cleanIdle(days) {          // elimina le misure "a riposo" piu' vecchie di N giorni
      const s = await D.get(D.query(R('series/_idle'), D.orderByKey(), D.endAt(String(Math.floor(Date.now() / 1000 - days * 86400)))));
      const o = s.val() || {}; const up = {}; Object.keys(o).forEach((k) => { up[k] = null; });
      if (Object.keys(up).length) await D.update(R('series/_idle'), up);
      return Object.keys(up).length;
    },
  };
  return api;
}

// ===================================================================== DEMO
function genRun({ start, end, R, idr, tset, vol0, step = 300000, seed = 1 }) {
  let x = seed; const rnd = () => { x = (x * 16807) % 2147483647; return x / 2147483647 - 0.5; };
  const t28 = t28di(R, idr), rows = []; let P = 0, prev = [];
  for (let t = start; t <= end; t += step) {
    const T = tset + rnd() * 0.5, Te = 20.5;
    P += kT(T) / t28 * (step / 3600000);
    const V = VdiP(P) * (1 + rnd() * 0.01);
    prev.push([t, V]); if (prev.length > 7) prev.shift();
    const s = prev.length > 3 ? (V - prev[0][1]) / ((t - prev[0][0]) / 3600000) : 0;
    const f = V < 1.1 ? 1 : V < 1.5 ? 2 : V < 2.5 ? 3 : V < 3.0 ? 4 : 5;
    const e = tset - T;
    rows.push({ t, d: Math.round(120 - 30 * (V - 1)), vol: vol0 * V, v: V, vf: V, s, ti: T, te: Te, sp: tset,
                st: e > 0.4 ? 1 : e < -0.6 ? -1 : 0, f, P });
  }
  return rows;
}
const hrs = (h) => h * 3600000;

function demoDb() {
  const now = Date.now();
  const runs = {}, series = {};
  const mk = (id, daysAgo, R, idr, tset, vol0, outcome, rating) => {
    const t28 = t28di(R, idr), ready = t28 * 1.05 / kT(tset) * 1.0;
    const start = now - daysAgo * 86400000, end = start + hrs(ready + 0.8);
    const rows = genRun({ start, end, R, idr, tset, vol0, seed: id.length + R * 7 });
    const firstReady = rows.find((r) => r.f >= 4);
    series[id] = rows;
    runs[id] = { id, status: 'done', created: start, start, end, ratio: R, idr, starterG: 100, flour: 'Manitoba', vol0, tInit: 22,
                 plan: 'durata', oreTarget: Math.round(ready), tset, tMean: tset, volFinal: vol0 * 2.6, readyH: (firstReady.t - start) / 3600000,
                 peakV: Math.max(...rows.map((r) => r.v)), outcome, rating, endNotes: '(dato dimostrativo)' };
  };
  mk('demo-r1', 6, 1, 45, 26, 100, 'ok', 4);
  mk('demo-r2', 4, 2, 45, 24, 100, 'ok', 5);
  mk('demo-r3', 2, 1, 42, 27.5, 110, 'troppo_avanti', 3);
  // ciclo in corso: avviato 3,4 ore fa, pronto tra ~2.6 h
  const cur = { id: 'demo-run', R: 1, idr: 45, tset: 25.5, vol0: 100, start: now - hrs(3.4) };
  series[cur.id] = genRun({ ...cur, end: now, seed: 5 });
  runs[cur.id] = { id: cur.id, status: 'running', created: cur.start, start: cur.start, ratio: 1, idr: 45, starterG: 100, flour: 'Manitoba',
                   vol0: 100, tInit: 22, plan: 'durata', oreTarget: 6, tset: 25.5, notes: '(ciclo dimostrativo)' };
  series._idle = genRun({ start: now - hrs(30), end: now - hrs(10), R: 1, idr: 45, tset: 16, vol0: 100, step: 600000, seed: 9 })
    .map((r) => ({ ...r, v: null, vf: null, s: null, vol: null, f: 0, sp: 16 }));
  const listeners = { live: [], runs: [] };
  let mode = 'osserva', hold = null, dTara = 148, area = 38.5;
  const last = () => series['demo-run'][series['demo-run'].length - 1];
  const live = () => {
    const l = last(), act = runs['demo-run'].status === 'running';
    const faseN = ['FERMO', 'LATENZA', 'ESPONENZIALE', 'DECELERAZIONE', 'PRONTO', 'OLTRE APICE', 'DECADIMENTO'];
    return { ts: Math.floor(Date.now() / 1000), mode, run: act ? 'demo-run' : '', fase: act ? faseN[l.f] : 'FERMO', faseIdx: act ? l.f : 0,
      d: l.d, h: dTara - l.d, vol: act ? l.vol : null, V: act ? l.vf : null, Vraw: act ? l.v : null, S: act ? l.s : null, Smax: 0.55, P: act ? l.P : null,
      forza: 1.02, treq: 25.1, ore: act ? (Date.now() - cur.start) / 3600000 : null, oreTarget: 6, tin: l.ti, hin: 52, text: 20.5, hext: null,
      extAgeMin: 0, textFixed: true, laserOk: true, coda: 0, tuya: 'ok', tset: act ? 25.5 : hold, heat: l.st > 0, cool: l.st < 0, state: l.st, tuyaOk: true, inRange: l.st === 0,
      fault: false, faultMsg: '', extRule: true, allowHeat: true, allowCool: false, dTara, area, vol0: 100, rssi: -58, fw: '2.0 (demo)', ip: 'demo' };
  };
  const emit = () => listeners.live.forEach((cb) => cb(live()));
  const emitRuns = () => listeners.runs.forEach((cb) => cb(Object.values(runs)));
  setInterval(() => {                     // aggiunge un punto ogni 20 s (accelerato) per vedere i grafici muoversi
    if (runs['demo-run'].status !== 'running') return;
    const rows = series['demo-run']; const l = rows[rows.length - 1];
    const T = l.ti + (Math.random() - 0.5) * 0.3, V = l.v * (1 + 0.0009), t = Date.now();
    rows.push({ ...l, t, ti: T, v: V, vf: V, vol: l.vol * 1.0009, d: l.d - 0.05, st: T < 25.1 ? 1 : T > 26.2 ? -1 : 0 }); emit();
  }, 20000);

  return {
    mode: 'demo',
    onAuth: (cb) => { setTimeout(() => cb({ email: 'demo@esempio.it' }), 50); return () => {}; },
    signIn: async () => {}, signOut: async () => { location.reload(); },
    onLive(cb) { listeners.live.push(cb); setTimeout(emit, 30); const h = setInterval(emit, 5000); return () => clearInterval(h); },
    onRuns(cb) { listeners.runs.push(cb); setTimeout(emitRuns, 30); return () => {}; },
    async series(id, last = 3000) { return (series[id] || []).slice(-last); },
    watchSeries(id, last, cb) { const f = () => cb((series[id] || []).slice(-last)); f(); const h = setInterval(f, 20000); return () => clearInterval(h); },
    async sendCmd(action, p = {}) {
      await new Promise((r) => setTimeout(r, 600));
      if (action === 'mode') mode = p.mode;
      if (action === 'hold') hold = p.tset ?? null;
      if (action === 'tara') { dTara = 148; return { ok: true, msg: 'tara 148 mm (demo)' }; }
      if (action === 'area') area = p.area;
      if (action === 'text') return { ok: true, msg: 'ok (demo)' };
      if (action === 'stop') { runs['demo-run'].status = 'done'; emitRuns(); }
      if (action === 'start') return { ok: false, msg: 'In modalità DEMO non si possono avviare cicli.' };
      emit(); return { ok: true, msg: 'ok (demo)' };
    },
    async saveRun(id, d) { runs[id] = d; emitRuns(); },
    async updateRun(id, patch) { Object.assign(runs[id], patch); emitRuns(); },
    async deleteRun(id) { delete runs[id]; delete series[id]; emitRuns(); },
    async cleanIdle() { return 0; },
  };
}

export async function openDb(cfg, demo) {
  if (demo) return demoDb();
  return firebaseDb(cfg);
}
