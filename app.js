// app.js - interfaccia del lievitatore
import { openDb } from './db.js';
import { MP, TLIM, SHAPE, calibrate, predictHours, predictCurve, usableRuns, fitCurve, curveV, advise, health, coverage, nextTests, T_BANDS, REF_1_1 } from './model.js?v=m4';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
let cfg = null, OWNER = '';
try { const m = await import('./firebase-config.js'); cfg = m.firebaseConfig; OWNER = m.OWNER_EMAIL || ''; } catch (e) { cfg = null; }
const DEMO = params.has('demo') || !cfg || String(cfg.apiKey || '').startsWith('INCOLLA');

const S = { live: null, runs: [], runSeries: [], idleSeries: [], growRunId: null, stopRun: null, cmpCache: new Map(), cmpSel: new Set() };
let db = null;

// ------------------------------------------------------------------ utilita'
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (x) => typeof x === 'number' && Number.isFinite(x);
const fmt = (x, d = 1) => (num(x) ? x.toFixed(d).replace('.', ',') : '—');
const pad = (n) => String(n).padStart(2, '0');
const fmtDur = (h) => { if (!num(h)) return '—'; const m = Math.round(h * 60); return m >= 60 ? `${Math.floor(m / 60)} h ${pad(m % 60)} min` : `${m} min`; };
const fmtClock = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtDay = (ms) => new Date(ms).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });
const fmtDT = (ms) => `${fmtDay(ms)} ${fmtClock(ms)}`;
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const rgba = (hex, a) => { const h = hex.replace('#', ''); const n = parseInt(h.length === 3 ? h.replace(/./g, '$&$&') : h, 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };
function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => { t.hidden = true; }, 4200); }
function confirmDlg(title, bodyHtml, ok = 'Conferma') {
  return new Promise((res) => {
    $('cfTitle').textContent = title; $('cfBody').innerHTML = bodyHtml; $('cfOk').textContent = ok;
    const d = $('dlgConf'); d.returnValue = 'no'; d.showModal();
    d.addEventListener('close', () => res(d.returnValue === 'si'), { once: true });
  });
}
async function cmd(action, p, okMsg) {
  const r = await db.sendCmd(action, p);
  toast(r.ok ? (okMsg || 'Fatto') : `Non eseguito: ${r.msg}`);
  return r;
}
const FASE_TXT = { FERMO: 'nessun ciclo attivo', LATENZA: 'il lievito si sta svegliando', ESPONENZIALE: 'crescita in accelerazione',
  DECELERAZIONE: 'la crescita rallenta', PRONTO: 'pronto per l\'uso', 'OLTRE APICE': 'oltre il picco: usalo o rinfresca', DECADIMENTO: 'in calo: rinfresca' };
const OUT_TXT = { ok: 'pronto al punto giusto', troppo_avanti: 'troppo avanti', poco_sviluppato: 'poco sviluppato', acidita: 'troppo acido', problema_tecnico: 'problema tecnico', annullata: 'annullata' };
const PH_COL = [null, '#8a8a8a', '#2c8a57', '#e0a31a', '#c98a2b', '#d9731a', '#d03b3b'];

// ------------------------------------------------------------------ grafici
let chTemp, chGrow, chCmp, chCmpT, chAdv;
const themeSync = () => { Chart.defaults.color = css('--muted'); Chart.defaults.borderColor = css('--line'); Chart.defaults.font.family = 'system-ui, sans-serif'; };
const baseOpts = (xTitle) => ({ parsing: false, animation: false, responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
  elements: { point: { radius: 0 }, line: { borderWidth: 2, tension: 0.15 } }, plugins: { legend: { labels: { boxWidth: 12 } } },
  scales: { x: { type: 'linear', title: { display: !!xTitle, text: xTitle || '' } } } });
const phaseBands = { id: 'phaseBands', beforeDatasetsDraw(c) {
  const rows = c.$phases; if (!rows || rows.length < 2) return; const { ctx, chartArea: a, scales: { x } } = c;
  ctx.save();
  for (let i = 0; i < rows.length - 1; i++) {
    const f = rows[i].f; if (!PH_COL[f]) continue;
    const x0 = Math.max(a.left, x.getPixelForValue(rows[i].t)), x1 = Math.min(a.right, x.getPixelForValue(rows[i + 1].t));
    if (x1 > x0) { ctx.fillStyle = rgba(PH_COL[f], 0.16); ctx.fillRect(x0, a.top, x1 - x0, a.bottom - a.top); }
  }
  ctx.restore();
} };

function makeCharts() {
  themeSync();
  const o = baseOpts(); o.scales.x.ticks = { callback: (v) => fmtClock(v), maxTicksLimit: 6 };
  o.scales.y = { title: { display: true, text: '°C' } };
  o.scales.y2 = { position: 'right', min: -1.6, max: 1.6, grid: { drawOnChartArea: false },
    ticks: { stepSize: 1, callback: (v) => (v === 1 ? 'Caldo' : v === 0 ? 'off' : v === -1 ? 'Freddo' : '') } };
  o.plugins.tooltip = { callbacks: { title: (it) => fmtDT(it[0].parsed.x) } };
  chTemp = new Chart($('chTemp'), { type: 'line', options: o, data: { datasets: [
    { label: 'DHT11', data: [], yAxisID: 'y', spanGaps: 2700000 }, { label: 'Esterna', data: [], yAxisID: 'y', borderDash: [4, 4], spanGaps: 2700000 },
    { label: 'Setpoint', data: [], yAxisID: 'y', borderDash: [8, 3], stepped: 'before', spanGaps: 2700000 },
    { label: 'Stato', data: [], yAxisID: 'y2', stepped: 'before', spanGaps: 2700000, borderWidth: 2,
      segment: { borderColor: (c) => (c.p0.parsed.y > 0 ? css('--heat') : c.p0.parsed.y < 0 ? css('--cool') : css('--muted')) } },
    { label: 'Govee', data: [], yAxisID: 'y', spanGaps: 2700000 }] } });

  const g = baseOpts(); g.scales.x.ticks = { callback: (v) => fmtClock(v), maxTicksLimit: 6 };
  g.scales.y = { title: { display: true, text: 'ml' } };
  g.scales.y2 = { position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: 'dV/dt (1/h)' } };
  g.plugins.tooltip = { callbacks: { title: (it) => fmtDT(it[0].parsed.x) } };
  chGrow = new Chart($('chGrow'), { type: 'line', plugins: [phaseBands], options: g, data: { datasets: [
    { label: 'Volume (ml)', data: [], yAxisID: 'y' }, { label: 'dV/dt', data: [], yAxisID: 'y2', borderWidth: 1.5 }] } });

  const c1 = baseOpts('ore dall\'avvio'); c1.scales.y = { title: { display: true, text: 'V / V₀' } };
  chCmp = new Chart($('chCmp'), { type: 'line', options: c1, data: { datasets: [] } });
  const c2 = baseOpts('ore dall\'avvio'); c2.scales.y = { title: { display: true, text: '°C' } };
  chCmpT = new Chart($('chCmpT'), { type: 'line', options: c2, data: { datasets: [] } });
  const c3 = baseOpts('ore dal rinfresco'); c3.scales.y = { title: { display: true, text: 'V / V₀' } };
  chAdv = new Chart($('chAdv'), { type: 'line', options: c3, data: { datasets: [
    { label: 'Previsto', data: [], borderColor: css('--accent'), backgroundColor: css('--accent') },
    { label: 'Pronto', data: [], showLine: false, pointRadius: 6, borderColor: css('--ok'), backgroundColor: css('--ok') }] } });
}
function paintCharts() {
  themeSync();
  const heat = css('--heat'), cool = css('--cool'), acc = css('--accent'), mut = css('--muted');
  Object.assign(chTemp.data.datasets[0], { borderColor: acc, backgroundColor: acc });
  Object.assign(chTemp.data.datasets[1], { borderColor: mut, backgroundColor: mut });
  Object.assign(chTemp.data.datasets[2], { borderColor: cool, backgroundColor: cool, borderWidth: 1.5 });
  Object.assign(chTemp.data.datasets[3], { borderColor: mut, backgroundColor: mut });
  Object.assign(chTemp.data.datasets[4], { borderColor: css('--ok'), backgroundColor: css('--ok') });
  Object.assign(chGrow.data.datasets[0], { borderColor: acc, backgroundColor: acc });
  Object.assign(chGrow.data.datasets[1], { borderColor: cool, backgroundColor: cool });
  chTemp.update('none'); chGrow.update('none'); chCmp.update('none'); chCmpT.update('none');
}

function updateTempChart() {
  const H = +$('tempRange').value, now = Date.now();
  const run = S.runs.find((r) => r.id === S.live?.run);
  const lo = H ? now - H * 3600e3 : (run ? run.start : now - 24 * 3600e3);
  const rows = [...S.idleSeries, ...S.runSeries].filter((r) => r.t >= lo).sort((a, b) => a.t - b.t);
  const pt = (k) => rows.filter((r) => num(r[k])).map((r) => ({ x: r.t, y: r[k] }));
  chTemp.data.datasets[0].data = pt('ti'); chTemp.data.datasets[1].data = pt('te');
  chTemp.data.datasets[2].data = pt('sp'); chTemp.data.datasets[3].data = pt('st'); chTemp.data.datasets[4].data = pt('tg');
  chTemp.options.scales.x.min = lo; chTemp.options.scales.x.max = now;
  chTemp.update('none');
}
function updateGrowChart() {
  const rows = S.runSeries.filter((r) => num(r.vol));
  chGrow.data.datasets[0].data = rows.map((r) => ({ x: r.t, y: r.vol }));
  chGrow.data.datasets[1].data = rows.filter((r) => num(r.s)).map((r) => ({ x: r.t, y: r.s }));
  chGrow.$phases = rows.map((r) => ({ t: r.t, f: r.f }));
  chGrow.update('none');
}

// ------------------------------------------------------------------ dati live
function subscribeSeries() {
  const live = S.live, last = [...S.runs].sort((a, b) => b.start - a.start)[0];
  const want = live?.run || last?.id || null;
  if (want === S.growRunId) return;
  S.growRunId = want; S.runSeries = [];
  if (S.stopRun) S.stopRun();
  S.stopRun = want ? db.watchSeries(want, 3000, (rows) => { S.runSeries = rows; updateGrowChart(); updateTempChart(); }) : null;
  updateGrowChart();
}

function alerts(L) {
  const a = [], age = L ? Date.now() / 1000 - L.ts : Infinity;
  if (!L) a.push(['info', 'In attesa dei dati', 'La scheda non ha ancora pubblicato nulla.']);
  else if (age > 180) a.push(['bad', 'La scheda non risponde', `Ultimo dato ${fmtDur(age / 3600)} fa. Controlla alimentazione e WiFi. La regolazione sulla scheda continua se è accesa; se perde i dati interni spegne tutto.`]);
  if (L?.fault) a.push(['bad', 'Guasto: regolazione ferma', `${esc(L.faultMsg)}. Caldo e freddo sono spenti.`]);
  if (L && L.mode === 'osserva') a.push(['info', 'Prova a secco', 'La scheda calcola cosa farebbe (LED e indicatori) ma non commuta nessuna presa.']);
  if (L?.mode === 'controllo' && L.tuya && L.tuya !== 'ok') a.push(['warn', 'Ciabatta non raggiungibile', L.tuya === 'non configurata' ? 'La ciabatta non è ancora configurata nella scheda (config.h): nessuna presa viene comandata.' : 'L\'ultimo comando alla ciabatta non è andato a buon fine. Si spegne comunque con il timer interno e l\'Inkbird a 30 °C.']);
  if (L?.run && num(L.treq) && (L.treq < MP.tsetMin || L.treq > MP.tsetMax)) {
    a.push(['warn', 'Obiettivo di orario fuori portata', L.treq < MP.tsetMin
      ? `Per essere pronto all'ora voluta servirebbero ${fmt(L.treq)} °C (sotto ${MP.tsetMin}). Sarà pronto in anticipo: al prossimo rinfresco usa un rapporto più diluito.`
      : `Per essere pronto all'ora voluta servirebbero ${fmt(L.treq)} °C (sopra ${MP.tsetMax}). Sarà pronto in ritardo: al prossimo rinfresco usa più lievito.`]);
  }
  if (L && !L.textFixed && num(L.extAgeMin) && L.extAgeMin > 60) a.push(['warn', 'Temperatura esterna non aggiornata', `Il Govee non invia dati da ${L.extAgeMin} min: la regola ambiente può non essere applicata.`]);
  if (L && L.fonte === 'govee' && !(L.gAgeS >= 0 && L.gAgeS < 120)) a.push(['warn', 'Govee non ricevuto', 'La regolazione è impostata sul Govee ma il dato non è recente (il cloud Govee si aggiorna ogni ~10 min): la scheda sta usando il DHT11.']);
  if (L?.run && S.runSeries.length > 120) {      // laser che non vede variazioni per ore: bersaglio fermo o fascio altrove
    const rs = S.runSeries.filter((r) => num(r.d)), h = rs.length ? (rs[rs.length - 1].t - rs[0].t) / 3600e3 : 0;
    if (h >= 4) { const ds = rs.map((r) => r.d), spread = Math.max(...ds) - Math.min(...ds);
      if (spread <= 2) a.push(['warn', 'Il laser non vede variazioni', `Da ${fmtDur(h)} la distanza resta a ${fmt(ds[ds.length - 1], 0)} mm (±${fmt(spread / 2, 0)}): se l'impasto sta salendo, il bersaglio non lo segue o il fascio non arriva alla superficie.`]); }
  }
  if (L && L.laserOk === false) a.push(['bad', 'Laser non trovato', 'La scheda non vede il VL53L0X: controlla i collegamenti SDA/SCL/VIN/GND.']);
  if (L?.coda > 5) a.push(['info', 'Dati in arrivo', `La scheda ha ${L.coda} misure in attesa di invio (rete lenta o assente da poco).`]);
  if (L?.fase === 'PRONTO') a.push(['ok', 'Pronto', 'Il lievito ha raggiunto il punto di maturazione: usalo o rinfresca.']);
  if (L?.fase === 'DECADIMENTO') a.push(['bad', 'Decadimento', 'Il volume sta calando: rinfresca presto.']);
  return a;
}

// previsione dell'ora in cui sara' pronto: curva misurata (se c'e' abbastanza crescita), altrimenti modello e temperatura attuale
function renderEta(L) {
  const run = S.runs.find((r) => r.id === L.run);
  if (!L.run || !run) { $('mEta').textContent = '—'; $('mEtaSub').textContent = ''; return; }
  if (L.fase === 'PRONTO' || L.fase === 'OLTRE APICE' || L.fase === 'DECADIMENTO') { $('mEta').textContent = 'ora'; $('mEtaSub').textContent = 'fase ' + L.fase.toLowerCase(); return; }
  let readyH = NaN, src = '';
  const pts = (S.runSeries || []).filter((x) => num(x.vf)).map((x) => ({ h: (x.t - run.start) / 3600e3, v: x.vf }));
  const fit = pts.length > 60 ? fitCurve(pts) : null;
  if (fit && fit.rmse < 0.12 && fit.peakV > 1.3) { readyH = fit.readyH; src = 'dalla curva misurata'; }
  else {
    const key = S.runs.length + ':' + S.runs.map((r) => r.fit ? 1 : 0).join('');
    if (S.calKey !== key) { S.cal = calibrate(S.runs); S.calKey = key; }
    const T = num(L.tset) ? L.tset : (num(L.tin) ? L.tin : 22);
    const pc = predictCurve(S.cal, run.ratio, run.idr, T);
    if (Number.isFinite(pc.readyH)) { readyH = pc.readyH; src = `dal modello a ${fmt(T, 0)} °C`; }
  }
  if (!Number.isFinite(readyH)) { $('mEta').textContent = '—'; $('mEtaSub').textContent = 'dati insufficienti'; return; }
  const when = run.start + readyH * 3600e3, d = new Date(when);
  const hm = d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  const day = d.toDateString() === new Date().toDateString() ? '' : d.toLocaleDateString('it-IT', { weekday: 'short' }) + ' ';
  $('mEta').textContent = day + hm;
  const tg = L.oreTarget > 0 ? run.start + L.oreTarget * 3600e3 : null;
  const dd = tg ? (when - tg) / 60000 : null;
  $('mEtaSub').textContent = src + (dd != null ? (Math.abs(dd) < 20 ? ' · in orario' : dd < 0 ? ` · ${fmtDur(-dd / 60)} prima dell'obiettivo` : ` · ${fmtDur(dd / 60)} dopo l'obiettivo`) : '');
}

function renderLive() {
  const L = S.live, age = L ? Date.now() / 1000 - L.ts : Infinity;
  const c = $('conn'); c.className = 'chip ' + (age < 180 ? 'ok' : L ? 'bad' : '');
  c.textContent = !L ? 'in attesa' : age < 180 ? `aggiornato ${Math.max(0, Math.round(age))} s fa` : `offline da ${fmtDur(age / 3600)}`;
  $('alerts').innerHTML = alerts(L).map(([k, t, x]) => `<div class="alert ${k}"><b>${t}</b>${x}</div>`).join('');
  if (!L) return;
  $('faseNome').textContent = L.fase || '—'; $('faseSub').textContent = FASE_TXT[L.fase] || '';
  const tgt = L.oreTarget > 0 ? L.oreTarget : null;
  $('tempoCiclo').textContent = L.run ? `${fmtDur(L.ore)}${tgt ? ' su ' + fmtDur(tgt) : ''}` : '—';
  $('barTempo').style.width = L.run && tgt ? Math.min(100, (L.ore / tgt) * 100) + '%' : '0';
  $('mVol').textContent = num(L.vol) ? `${fmt(L.vol, 0)} ml` : '—'; $('mV').textContent = [num(L.V) ? `V/V₀ ${fmt(L.V, 2)}` : '', num(L.d) ? `laser ${fmt(L.d, 0)} mm` : ''].filter(Boolean).join(' · ');
  $('mS').textContent = num(L.S) ? fmt(L.S, 2) : '—';
  $('mTin').textContent = num(L.tin) ? `${fmt(L.tin)} °C` : '—'; $('mHin').textContent = num(L.hin) ? `UR ${fmt(L.hin, 0)}%` : '';
  $('mTg').textContent = num(L.tg) ? `${fmt(L.tg)} °C` : '—';
  $('mTgSub').textContent = num(L.tg) ? `UR ${fmt(L.hg, 0)}% · ${L.gAgeS >= 0 ? Math.round(L.gAgeS / 60) + ' min fa' : ''}${L.gbat >= 0 ? ' · batt. ' + L.gbat + '%' : ''}${num(L.tin) ? ' · Δ ' + fmt(L.tg - L.tin) + ' °C' : ''}` : 'non ricevuto (cloud Govee)';
  $('mPow').textContent = num(L.powerW) ? `${fmt(L.powerW, 1)} W` : '—';
  $('mVolt').textContent = num(L.volt) ? `${fmt(L.volt, 0)} V · ciabatta ${L.tuya || ''}` : (L.tuya ? `ciabatta ${L.tuya}` : '');
  $('srcDht').classList.toggle('on', L.fonte !== 'govee'); $('srcGov').classList.toggle('on', L.fonte === 'govee');
  $('mText').textContent = num(L.text) ? `${fmt(L.text)} °C` : '—';
  $('mTextAge').textContent = L.textFixed ? 'valore impostato' : (L.extAgeMin >= 0 ? `aggiornata ${L.extAgeMin} min fa` : 'non ancora letta');
  if (document.activeElement !== $('sText') && num(L.text) && !$('sText').value) $('sText').value = L.text;
  $('provaTxt').textContent = L.prova
    ? (L.provaFase === 1 ? `Prova ${L.prova}: uscita accesa da ${Math.round(L.provaS / 60)} min, target ${fmt(L.provaT)} °C.`
      : `Prova ${L.prova}: uscita spenta, registro il rilassamento da ${Math.round(L.provaS / 60)} min (picco ${fmt(L.provaPk)} °C).`)
    : 'Nessuna prova in corso.';
  $('mTset').textContent = num(L.tset) ? `${fmt(L.tset)} °C` : 'nessuno';
  $('mTreq').textContent = num(L.treq) && Math.abs(L.treq - L.tset) > 0.3 ? `richiesti ${fmt(L.treq)} °C` : '';
  renderEta(L);
  $('mP').textContent = num(L.P) ? `${fmt(L.P * 100, 0)} %` : '—';
  $('mForza').textContent = num(L.forza) ? (L.forza > 1.05 ? `${fmt((L.forza - 1) * 100, 0)}% più veloce del modello` : L.forza < 0.95 ? `${fmt((1 - L.forza) * 100, 0)}% più lento del modello` : 'come da modello') : '';
  $('modeOsserva').classList.toggle('on', L.mode !== 'controllo'); $('modeControllo').classList.toggle('on', L.mode === 'controllo');
  $('pillHeat').className = 'pill heat' + (L.heat ? ' on' : ''); $('pillCool').className = 'pill cool' + (L.cool ? ' on' : '');
  $('pillOk').className = 'pill okp' + (L.inRange && !L.fault ? ' on' : '');
  const w = L.mode === 'controllo' ? '' : ' (richiesta, non comandata)';
  $('pillHeat').textContent = 'Caldo' + (L.heat ? w : ''); $('pillCool').textContent = 'Freddo' + (L.cool ? w : '');
  $('regolaTxt').textContent = L.extRule
    ? `Regola ambiente: caldo ${L.allowHeat ? 'consentito' : 'bloccato'}, freddo ${L.allowCool ? 'consentito' : 'bloccato'} (setpoint ${fmt(L.tset)} °C, esterna ${fmt(L.text)} °C).`
    : (L.tset == null ? `Nessun setpoint: la scheda non regola (temperatura esterna ${fmt(L.text)} °C).`
      : 'Temperatura esterna non disponibile: la regola ambiente non è applicata.');
  $('endBox').hidden = !L.run;
  const run = S.runs.find((r) => r.id === L.run);
  $('endInfo').textContent = run ? `Avviato ${fmtDT(run.start)} · rapporto 1:${run.ratio} · acqua ${run.idr}%` : '';
  $('taraVal').textContent = num(L.dTara) ? `${fmt(L.dTara, 0)} mm` : 'non eseguita';
  if (document.activeElement !== $('sArea') && num(L.area) && !$('sArea').value) $('sArea').value = L.area;
  $('devInfo').textContent = `Firmware ${L.fw || '—'} · IP ${L.ip || '—'} · segnale ${L.rssi ?? '—'} dBm · modo ${L.mode}`;
  subscribeSeries();
}

// ------------------------------------------------------------------ camera
function camTick() {
  const url = localStorage.getItem('camUrl') || '';
  const on = !$('tab-ora').hidden && url;
  $('camImg').hidden = !on; $('camMsg').hidden = !!url;
  if (on) $('camImg').src = url + (url.includes('?') ? '&' : '?') + 't=' + Date.now();
}

// ------------------------------------------------------------------ nuovo rinfresco
async function startRun(ev) {
  ev.preventDefault();
  const msg = $('nuovoMsg'); msg.textContent = '';
  const R = +$('fR').value, idr = +$('fIdr').value, vol0 = +$('fVol0').value, starter = +$('fStarter').value;
  const plan = document.querySelector('input[name=plan]:checked').value, ore = +$('fOre').value, tset = +$('fTset').value;
  if (S.live?.run) return (msg.textContent = 'C\'è già un ciclo in corso: terminalo prima.');
  if (!num(S.live?.dTara)) return (msg.textContent = 'Esegui prima la tara a contenitore vuoto.');
  if (!(vol0 >= 20 && vol0 <= 2000)) return (msg.textContent = 'Inserisci il volume iniziale in ml (20–2000).');
  if (plan === 'durata' && !(ore >= 2 && ore <= 48)) return (msg.textContent = 'La durata deve essere tra 2 e 48 ore.');
  if (plan === 'fissa' && !(tset >= 4 && tset <= MP.tsetMax)) return (msg.textContent = `La temperatura deve essere tra 4 e ${MP.tsetMax} °C.`);
  const btn = $('btnAvvia'); btn.disabled = true; btn.textContent = 'Invio alla scheda…';
  const id = 'r' + new Date().toISOString().replace(/\D/g, '').slice(0, 12);
  const meta = { id, status: 'running', created: Date.now(), start: Date.now(), ratio: R, idr, starterG: starter || null, flour: $('fFlour').value.trim(),
    vol0, tInit: $('fTinit').value ? +$('fTinit').value : null, plan, oreTarget: plan === 'durata' ? ore : null, tset: plan === 'fissa' ? tset : null, notes: $('fNotes').value.trim() };
  try {
    await db.saveRun(id, meta);
    const r = await db.sendCmd('start', { runId: id, R, idr, vol0, plan, ore: plan === 'durata' ? ore : 0, tset });
    if (!r.ok) { await db.deleteRun(id); msg.textContent = `La scheda ha rifiutato l'avvio: ${r.msg}`; }
    else { toast('Lievitazione avviata'); showTab('ora'); }
  } catch (e) { msg.textContent = 'Errore di comunicazione con il database.'; }
  btn.disabled = false; btn.textContent = 'Avvia lievitazione';
}

async function finishRun() {
  const L = S.live, run = S.runs.find((r) => r.id === L?.run);
  if (!run) return;
  const vf = +$('eVol').value, out = $('eOut').value, msg = $('eMsg'); msg.textContent = '';
  if (!(vf >= 20 && vf <= 3000)) return (msg.textContent = 'Inserisci il volume finale in ml.');
  $('eOk').disabled = true;
  try {
    const rows = await db.series(run.id, 5000);
    const ti = rows.map((r) => r.ti).filter(num), fr = rows.find((r) => r.f >= 4);
    const dh = num(L.h) && num(L.h0) ? L.h - L.h0 : NaN;
    const fit = fitCurve(rows.filter((x) => num(x.vf)).map((x) => ({ h: (x.t - run.start) / 3600e3, v: x.vf })));
    const r = await db.sendCmd('stop', {});
    if (!r.ok) { msg.textContent = `Non riesco a fermare la scheda: ${r.msg}`; $('eOk').disabled = false; return; }
    await db.updateRun(run.id, { status: out === 'annullata' ? 'cancelled' : 'done', end: Date.now(), volFinal: vf, outcome: out,
      rating: $('eRate').value ? +$('eRate').value : null, endNotes: $('eNotes').value.trim(),
      fit: fit && fit.rmse < 0.12 ? { A: +fit.A.toFixed(3), k: +fit.k.toFixed(3), tm: +fit.tm.toFixed(3), readyH: +fit.readyH.toFixed(3), rmse: +fit.rmse.toFixed(4), peakH: +fit.peakH.toFixed(2), peakV: +fit.peakV.toFixed(3) } : null,
      readyH: fr ? (fr.t - run.start) / 3600e3 : null, peakV: Math.max(...rows.map((x) => x.vf || 0), 0) || null,
      tMean: ti.length ? ti.reduce((a, b) => a + b, 0) / ti.length : null, areaUsed: L.area });
    if ($('eCal').checked && num(dh) && dh > 8) {
      const a = (vf - run.vol0) / (dh / 10);
      if (a > 5 && a < 300 && Math.abs(a / L.area - 1) < 0.5) { await db.sendCmd('area', { area: +a.toFixed(1) }); toast(`Sezione ricalibrata a ${fmt(a)} cm²`); }
    }
    $('dlgFine').close(); toast('Lievitazione terminata e salvata');
  } catch (e) { msg.textContent = 'Errore durante il salvataggio.'; }
  $('eOk').disabled = false;
}

// ------------------------------------------------------------------ storico
const runTitle = (r) => `${fmtDT(r.start)} · 1 : ${r.ratio} · acqua ${r.idr}%`;
function renderRuns() {
  const list = [...S.runs].filter((r) => r.status !== 'cancelled').sort((a, b) => b.start - a.start);
  $('stNone').hidden = list.length > 0;
  $('runList').innerHTML = list.map((r) => `<div class="run" data-id="${esc(r.id)}">
    <div class="row"><b>${esc(runTitle(r))}</b>${r.status === 'running' ? '<span class="chip warn">in corso</span>' : ''}</div>
    <div class="muted small">${r.tMean ? `T media ${fmt(r.tMean)} °C · ` : ''}${r.readyH ? `pronto dopo ${fmtDur(r.readyH)}` : 'pronto: —'}${r.volFinal ? ` · volume ${fmt(r.vol0, 0)}→${fmt(r.volFinal, 0)} ml` : ''}${r.outcome ? ` · ${esc(OUT_TXT[r.outcome] || r.outcome)}` : ''}${r.rating ? ` · ${'★'.repeat(r.rating)}` : ''}${r.flour ? ` · ${esc(r.flour)}` : ''}</div>
    <div class="row"><label class="inline small"><input type="checkbox" data-cmp="${esc(r.id)}" ${S.cmpSel.has(r.id) ? 'checked' : ''}> confronta</label>
      <span class="acts"><button class="btn" data-csv="${esc(r.id)}">CSV</button><button class="btn" data-del="${esc(r.id)}" ${r.status === 'running' ? 'disabled' : ''}>Elimina</button></span></div>
  </div>`).join('');
}
async function seriesOf(id) {
  if (!S.cmpCache.has(id)) S.cmpCache.set(id, await db.series(id, 5000));
  return S.cmpCache.get(id);
}
async function renderCompare() {
  $('cmpCard').hidden = S.cmpSel.size === 0;
  const pal = ['#a4601a', '#2b66d6', '#2c8a57', '#8e44ad', '#d03b3b', '#0d8a9a'];
  const g = [], t = []; let i = 0;
  for (const id of S.cmpSel) {
    const run = S.runs.find((r) => r.id === id); if (!run) continue;
    const rows = await seriesOf(id), col = pal[i++ % pal.length], name = `${fmtDay(run.start)} 1:${run.ratio}`;
    g.push({ label: name, data: rows.filter((r) => num(r.vf)).map((r) => ({ x: (r.t - run.start) / 3600e3, y: r.vf })), borderColor: col, backgroundColor: col });
    t.push({ label: name, data: rows.filter((r) => num(r.ti)).map((r) => ({ x: (r.t - run.start) / 3600e3, y: r.ti })), borderColor: col, backgroundColor: col, borderWidth: 1.5 });
  }
  chCmp.data.datasets = g; chCmpT.data.datasets = t; chCmp.update('none'); chCmpT.update('none');
}
async function exportCsv(id) {
  const run = S.runs.find((r) => r.id === id), rows = await seriesOf(id);
  const head = 'istante;ore;distanza_mm;volume_ml;V_V0;V_filtrato;dVdt;T_interna;T_esterna;setpoint;stato;fase\n';
  const f = (x) => (num(x) ? String(x).replace('.', ',') : '');
  const body = rows.map((r) => [new Date(r.t).toISOString(), f((r.t - run.start) / 3600e3), f(r.d), f(r.vol), f(r.v), f(r.vf), f(r.s), f(r.ti), f(r.te), f(r.sp), r.st ?? '', r.f ?? ''].join(';')).join('\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + head + body], { type: 'text/csv' })); a.download = `lievitazione-${id}.csv`; a.click();
}

// ------------------------------------------------------------------ consigli
const dtLocal = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
let advState = null;
function renderAdvice() {
  const cal = calibrate(S.runs), n = cal.n;
  $('calInfo').textContent = n ? `Calibrato su ${n} ciclo${n > 1 ? 'i' : ''} concluso${n > 1 ? 'i' : ''}${cal.nFit ? ` (${cal.nFit} con curva adattata)` : ''} · fattore ${fmt(cal.c, 2)}, incertezza ±${fmt(cal.spread * 100, 0)}%.` : 'Nessun ciclo concluso: uso il modello di partenza, incertezza ±25%.';
  renderHealth(cal); renderCoverage(); renderStrategy(cal);
  const target = new Date($('cTarget').value).getTime(), from = new Date($('cFrom').value).getTime(), idr = +$('cIdr').value || 45, noNight = $('cNight').checked;
  const R = +$('cRatio').value, frac = +$('cFrac').value;
  if (!Number.isFinite(target) || !Number.isFinite(from)) return;
  const ore = (target - from) / 3600e3;
  if (ore < 1.5) { $('advBest').innerHTML = '<div class="alert warn"><b>Tempo troppo breve</b>Servono almeno un paio d\'ore tra il rinfresco e l\'orario voluto.</div>'; return; }
  const opts = advise(cal, ore, idr, [1, 1.5, 2, 3], frac), me = opts.find((o) => o.R === R);
  const hr = new Date(from).getHours(), night = hr >= 23 || hr < 6;
  let msg;
  if (me.feasible) {
    msg = `<div class="alert ok"><b>1 : ${R} a ${fmt(me.Treq, 1)} °C</b>Rinfresca alle ${fmtDT(from)} e tieni la cella a ${fmt(me.Treq, 1)} °C: sarà pronto ${fmtDT(target)} (tra ${fmtDur(me.lo)} e ${fmtDur(me.hi)}).${night && noNight ? ' <br>Attenzione: è un orario di notte.' : ''}${me.Treq < MP.tsetMin ? '<br>Sotto ' + MP.tsetMin + ' °C usa la <b>temperatura fissa</b> nel nuovo rinfresco.' : ''}</div>`;
  } else if (me.early) {
    msg = `<div class="alert warn"><b>Troppo tempo per 1 : ${R}</b>Servirebbe ${fmt(me.Treq, 1)} °C, sotto il minimo di ${TLIM.min} °C. A ${TLIM.min} °C sarà pronto dopo circa ${fmtDur(me.hours)}: usa un rapporto più diluito o rinfresca più tardi.</div>`;
  } else {
    msg = `<div class="alert warn"><b>Poco tempo per 1 : ${R}</b>Servirebbe ${fmt(me.Treq, 1)} °C, sopra il massimo di ${TLIM.max} °C. A ${TLIM.max} °C sarà pronto dopo circa ${fmtDur(me.hours)}: usa più lievito (rapporto 1 : 1) o rinfresca prima.</div>`;
  }
  $('advBest').innerHTML = msg;
  advState = { R, idr, T: +me.T.toFixed(1) };
  const cur = me.cur, tEnd = Math.max(me.hours * 1.35, 4), pts = [];
  for (let h = 0; h <= tEnd; h += tEnd / 120) pts.push({ x: h, y: curveV(cur, h) });
  chAdv.data.datasets[0].data = pts; chAdv.data.datasets[1].data = [{ x: me.hours, y: curveV(cur, me.hours) }];
  chAdv.options.scales.x.min = 0; chAdv.options.scales.x.max = tEnd; chAdv.update('none');
  $('advTable').innerHTML = '<tr><th>Rapporto</th><th>Temp. necessaria</th><th>Pronto dopo</th><th>Note</th></tr>' +
    opts.map((o) => `<tr class="${o.R === R ? 'best' : o.feasible ? '' : 'dim'}"><td>1 : ${o.R}</td><td>${fmt(o.Treq, 1)} °C${o.feasible ? '' : ' ✗'}</td><td>${fmtDur(o.hours)} ±${fmt(cal.spread * 100, 0)}%</td>
      <td>${[o.early ? 'troppo lento anche a ' + TLIM.min + ' °C' : '', o.late ? 'troppo rapido da raggiungere' : '', o.n ? `già provato ${o.n}×` : 'mai provato'].filter(Boolean).join(' · ')}</td></tr>`).join('');
}
function renderHealth(cal) {
  const h = health(cal);
  if (!h) { $('healthBox').innerHTML = `<p class="muted">Ancora nessun ciclo concluso: non posso dire come sta. Il primo test utile è un <b>1 : 1 a 27 °C</b>: in un lievito in forma è pronto in circa ${fmtDur(REF_1_1)}.</p>`; return; }
  const sp = Math.round(h.speed * 100), cls = sp >= 90 ? 'ok' : sp >= 70 ? 'info' : 'warn';
  const lab = sp >= 90 ? 'in forma' : sp >= 70 ? 'un po\' lento' : 'debole';
  $('healthBox').innerHTML = `<div class="alert ${cls}"><b>Vigore: ${sp}% — ${lab}</b>Velocità rispetto a un 1 : 1 in forma (pronto in ${fmtDur(REF_1_1)} a 27 °C).${h.hasRatio1 ? '' : ' Valore indicativo: non hai ancora un ciclo 1 : 1.'}${h.amp ? `<br>Crescita: ${Math.round(h.amp * 100)}% di quella attesa (×${fmt(1 + (cal.A['1'] || 0), 1)} contro ×2,4).` : ''}</div>`;
}
function renderCoverage() {
  const cov = coverage(S.runs), nt = nextTests(S.runs);
  $('covTable').innerHTML = '<tr><th>Rapporto</th>' + T_BANDS.map(([a, b]) => `<th>${a}–${Math.round(b)} °C</th>`).join('') + '</tr>' +
    cov.map((r) => `<tr><td>1 : ${r.R}</td>${r.cells.map((c, i) => `<td class="${c ? '' : nt.some((t) => t.R === r.R && t.band === i) ? 'best' : 'dim'}">${c || '·'}</td>`).join('')}</tr>`).join('');
  const t = nt[0];
  $('covNote').textContent = t ? `Prossima prova utile: 1 : ${t.R} tra ${T_BANDS[t.band][0]} e ${Math.round(T_BANDS[t.band][1])} °C (le celle evidenziate sono quelle prioritarie).` : 'Le prove principali sono coperte: ripeti quelle che ti servono di più per stringere l\'incertezza.';
}
function renderStrategy(cal) {
  const h = health(cal), weak = !h || h.speed < 0.9;
  $('strategy').innerHTML = weak ? `<ol>
    <li><b>Rimettilo in moto (3–5 giorni):</b> solo rinfreschi di <b>produzione 1 : 1 a 26–28 °C</b>, a ogni picco (circa ${fmtDur(REF_1_1)}–4 h se è sano), tenendo l'idratazione fissa (${$('cIdr').value || 45}%). Niente freddo finché non raddoppia con regolarità.</li>
    <li><b>Nutrimento:</b> in questa fase sostituisci il 10–20% della farina con integrale o con un po' di segale; farina forte e acqua non troppo fredda, ma senza cloro (lasciala riposare qualche ora).</li>
    <li><b>Pulizia:</b> a ogni rinfresco butta quasi tutto e lascia l'inoculo minimo (circa un quarto del peso totale), in un contenitore pulito: così l'acidità accumulata viene diluita.</li>
    <li><b>Controllo:</b> a ogni ciclo concluso la pagina adatta la curva e aggiorna il vigore qui sopra. Si considera ripreso con vigore ≥ 90% e crescita ≥ ×2,3 per due cicli di fila.</li>
    <li><b>Poi alterna:</b> 1 : 2 al freddo (15–18 °C, 20–24 h) per tenerlo, e almeno 2 rinfreschi di produzione a settimana, anche senza panificare.</li></ol>
    <p class="muted small">Sono indicazioni generali di buona pratica, non una diagnosi: se vedi muffa (peluria colorata), odore sgradevole o liquido rosato, butta il lievito e riparti da una porzione sana.</p>` :
  `<ol><li>Il lievito è in forma: alterna <b>1 : 2 al freddo</b> (15–18 °C, 20–24 h) per il mantenimento e <b>1 : 1 a 26–28 °C</b> per produrre, con almeno 2 rinfreschi di produzione a settimana.</li>
    <li>Per i lievitati scegli l'orario in cui ti serve e il rapporto: la pagina ti dice a che temperatura tenerlo.</li>
    <li>Se il vigore scende sotto il 90%, torna alla fase di recupero: 1 : 1 caldo a ogni picco per qualche giorno.</li></ol>`;
}

// ------------------------------------------------------------------ schede e avvio
function showTab(name) {
  document.querySelectorAll('.tab').forEach((s) => { s.hidden = s.id !== 'tab-' + name; });
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  window.scrollTo(0, 0);
  if (name === 'ora') { requestAnimationFrame(() => { chTemp.resize(); chGrow.resize(); }); camTick(); }
  if (name === 'storico') { renderRuns(); renderCompare(); requestAnimationFrame(() => { chCmp.resize(); chCmpT.resize(); }); }
  if (name === 'consigli') { if (!$('cTarget').value) { $('cTarget').value = dtLocal(Date.now() + 10 * 3600e3); $('cFrom').value = dtLocal(Date.now()); } renderAdvice(); requestAnimationFrame(() => chAdv.resize()); }
}

function wire() {
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  $('tempRange').addEventListener('change', updateTempChart);
  $('modeOsserva').addEventListener('click', () => cmd('mode', { mode: 'osserva' }, 'Prova a secco attiva: nessuna presa verrà comandata'));
  $('modeControllo').addEventListener('click', async () => {
    if (S.live?.mode === 'controllo') return;
    const ok = await confirmDlg('Attivare il controllo?', `<p>La scheda comanderà davvero resistenza e cantinetta tramite la ciabatta.</p>
      <ul><li>Presa caldo e presa freddo verificate con un carico di prova</li><li>Inkbird a 30 °C in serie alla resistenza</li><li>Cantinetta sul punto più caldo del suo termostato</li><li>Resistenza lontana da plastica e impasto</li></ul>`, 'Attiva il controllo');
    if (ok) cmd('mode', { mode: 'controllo' }, 'Controllo attivo');
  });
  $('btnTara').addEventListener('click', async () => {
    if (!await confirmDlg('Tara del contenitore', '<p>Il contenitore è <b>vuoto</b>, il disco è in fondo e il laser è montato?</p>')) return;
    cmd('tara', {}, 'Tara eseguita');
  });
  $('formNuovo').addEventListener('submit', startRun);
  $('btnFine').addEventListener('click', () => { $('eMsg').textContent = ''; $('dlgFine').showModal(); });
  $('eOk').addEventListener('click', (e) => { e.preventDefault(); finishRun(); });
  $('runList').addEventListener('click', async (e) => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.dataset.csv) exportCsv(t.dataset.csv);
    if (t.dataset.del) {
      const r = S.runs.find((x) => x.id === t.dataset.del);
      if (await confirmDlg('Eliminare il ciclo?', `<p>${esc(runTitle(r))}</p><p><b>L'eliminazione è definitiva</b>: si perdono anche le misure del ciclo.</p>`, 'Elimina')) { S.cmpSel.delete(r.id); await db.deleteRun(r.id); }
    }
  });
  $('runList').addEventListener('change', (e) => { const id = e.target.dataset.cmp; if (!id) return; e.target.checked ? S.cmpSel.add(id) : S.cmpSel.delete(id); renderCompare(); });
  ['cTarget', 'cFrom', 'cIdr', 'cNight', 'cRatio', 'cFrac'].forEach((i) => $(i).addEventListener('input', renderAdvice));
  $('btnUseAdv').addEventListener('click', () => {
    if (!advState) return;
    $('fR').value = String(advState.R); if ([...$('fIdr').options].some((o) => +o.value === advState.idr)) $('fIdr').value = String(advState.idr);
    document.querySelector('input[name=plan][value=fissa]').checked = true; $('fTset').value = advState.T;
    showTab('nuovo'); toast(`Precompilato: 1 : ${advState.R}, ${fmt(advState.T, 1)} °C fissi`);
  });
  $('btnArea').addEventListener('click', () => cmd('area', { area: +$('sArea').value }, 'Sezione aggiornata'));
  $('btnHold').addEventListener('click', () => cmd('hold', { tset: +$('sHold').value }, 'Temperatura a riposo impostata'));
  $('btnHoldOff').addEventListener('click', () => cmd('hold', { tset: null }, 'Nessuna regolazione a riposo'));
  $('sCam').value = localStorage.getItem('camUrl') || '';
  $('srcDht').addEventListener('click', () => cmd('fonte', { src: 'dht' }, 'Regolazione sul DHT11'));
  $('srcGov').addEventListener('click', () => cmd('fonte', { src: 'govee' }, 'Regolazione sul Govee'));
  $('btnProva').addEventListener('click', async () => {
    const tipo = $('pTipo').value, t = +$('sPt').value;
    if (!await confirmDlg('Avviare la prova?', `<p>La scheda comanderà davvero la ciabatta: <b>${tipo === 'caldo' ? 'resistenza accesa' : 'cantinetta accesa'}</b> in continuo fino a ${fmt(t)} °C, poi spenta.</p><p>Controlla che il termostato della cantinetta sia sul punto giusto e che la cella sia sorvegliata.</p>`, 'Avvia')) return;
    await cmd('prova', { tipo, t }, 'Prova avviata');
  });
  $('btnProvaOff').addEventListener('click', () => cmd('prova', { tipo: 'off' }, 'Prova fermata'));
  $('btnText').addEventListener('click', () => cmd('text', { t: +$('sText').value }, 'Temperatura esterna aggiornata'));
  $('btnCam').addEventListener('click', () => { localStorage.setItem('camUrl', $('sCam').value.trim()); camTick(); toast('Indirizzo salvato'); });
  $('btnClean').addEventListener('click', async () => { const n = await db.cleanIdle(7); $('cleanMsg').textContent = `Eliminati ${n} campioni.`; });
  $('btnLogout').addEventListener('click', () => db.signOut());
  $('btnGoogle').addEventListener('click', async () => {
    $('liErr').textContent = '';
    try { await db.signInGoogle(); } catch (er) { $('liErr').textContent = er.code === 'auth/popup-closed-by-user' ? 'Accesso annullato.' : `Accesso non riuscito (${er.code || er.message}).`; }
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', paintCharts);
}

async function main() {
  db = await openDb(cfg, DEMO);
  $('demoBadge').hidden = !DEMO;
  makeCharts(); wire(); paintCharts();
  let started = false;
  db.onAuth((u) => {
    if (u && !DEMO && OWNER && (u.email || '').toLowerCase() !== OWNER) {      // account Google diverso: fuori
      $('liErr').textContent = `L'account ${u.email} non è autorizzato. Usa ${OWNER}.`;
      db.signOut(); return;
    }
    $('login').hidden = !!u; $('app').hidden = !u;
    if (!u || started) return;
    started = true;
    const denied = (e) => { $('alerts').innerHTML = `<div class="alert bad"><b>Accesso ai dati negato</b>${esc(e?.message || '')}</div>`; };
    db.onLive((l) => { S.live = l; renderLive(); }, denied);
    db.onRuns((r) => { S.runs = r; renderLive(); renderRuns(); }, denied);
    db.watchSeries('_idle', 3000, (rows) => { const st = Math.ceil(rows.length / 1200); S.idleSeries = st > 1 ? rows.filter((_, i) => i % st === 0 || i === rows.length - 1) : rows; updateTempChart(); });
    setInterval(renderLive, 10000); setInterval(camTick, 3000);
  });
}
main();
