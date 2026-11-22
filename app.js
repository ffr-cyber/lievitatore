// app.js - interfaccia del lievitatore
import { openDb } from './db.js';
import { MP, calibrate, predictHours, usableRuns } from './model.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
let cfg = null;
try { cfg = (await import('./firebase-config.js')).firebaseConfig; } catch (e) { cfg = null; }
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
let chTemp, chGrow, chCmp, chCmpT;
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
    { label: 'Interna', data: [], yAxisID: 'y', spanGaps: 2700000 }, { label: 'Esterna', data: [], yAxisID: 'y', borderDash: [4, 4], spanGaps: 2700000 },
    { label: 'Setpoint', data: [], yAxisID: 'y', borderDash: [8, 3], stepped: 'before', spanGaps: 2700000 },
    { label: 'Stato', data: [], yAxisID: 'y2', stepped: 'before', spanGaps: 2700000, borderWidth: 2,
      segment: { borderColor: (c) => (c.p0.parsed.y > 0 ? css('--heat') : c.p0.parsed.y < 0 ? css('--cool') : css('--muted')) } }] } });

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
}
function paintCharts() {
  themeSync();
  const heat = css('--heat'), cool = css('--cool'), acc = css('--accent'), mut = css('--muted');
  Object.assign(chTemp.data.datasets[0], { borderColor: acc, backgroundColor: acc });
  Object.assign(chTemp.data.datasets[1], { borderColor: mut, backgroundColor: mut });
  Object.assign(chTemp.data.datasets[2], { borderColor: cool, backgroundColor: cool, borderWidth: 1.5 });
  Object.assign(chTemp.data.datasets[3], { borderColor: mut, backgroundColor: mut });
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
  chTemp.data.datasets[2].data = pt('sp'); chTemp.data.datasets[3].data = pt('st');
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
  if (L && L.laserOk === false) a.push(['bad', 'Laser non trovato', 'La scheda non vede il VL53L0X: controlla i collegamenti SDA/SCL/VIN/GND.']);
  if (L?.coda > 5) a.push(['info', 'Dati in arrivo', `La scheda ha ${L.coda} misure in attesa di invio (rete lenta o assente da poco).`]);
  if (L?.fase === 'PRONTO') a.push(['ok', 'Pronto', 'Il lievito ha raggiunto il punto di maturazione: usalo o rinfresca.']);
  if (L?.fase === 'DECADIMENTO') a.push(['bad', 'Decadimento', 'Il volume sta calando: rinfresca presto.']);
  return a;
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
  $('mVol').textContent = num(L.vol) ? `${fmt(L.vol, 0)} ml` : '—'; $('mV').textContent = num(L.V) ? `V/V₀ ${fmt(L.V, 2)}` : '';
  $('mS').textContent = num(L.S) ? fmt(L.S, 2) : '—';
  $('mTin').textContent = num(L.tin) ? `${fmt(L.tin)} °C` : '—'; $('mHin').textContent = num(L.hin) ? `UR ${fmt(L.hin, 0)}%` : '';
  $('mText').textContent = num(L.text) ? `${fmt(L.text)} °C` : '—';
  $('mTextAge').textContent = L.textFixed ? 'valore impostato' : (L.extAgeMin >= 0 ? `aggiornata ${L.extAgeMin} min fa` : 'non ancora letta');
  if (document.activeElement !== $('sText') && num(L.text) && !$('sText').value) $('sText').value = L.text;
  $('mTset').textContent = num(L.tset) ? `${fmt(L.tset)} °C` : 'nessuno';
  $('mTreq').textContent = num(L.treq) && Math.abs(L.treq - L.tset) > 0.3 ? `richiesti ${fmt(L.treq)} °C` : '';
  $('mP').textContent = num(L.P) ? `${fmt(L.P * 100, 0)} %` : '—';
  $('mForza').textContent = num(L.forza) ? (L.forza > 1.05 ? `${fmt((L.forza - 1) * 100, 0)}% più veloce del modello` : L.forza < 0.95 ? `${fmt((1 - L.forza) * 100, 0)}% più lento del modello` : 'come da modello') : '';
  $('modeOsserva').classList.toggle('on', L.mode !== 'controllo'); $('modeControllo').classList.toggle('on', L.mode === 'controllo');
  $('pillHeat').className = 'pill heat' + (L.heat ? ' on' : ''); $('pillCool').className = 'pill cool' + (L.cool ? ' on' : '');
  $('pillOk').className = 'pill okp' + (L.inRange && !L.fault ? ' on' : '');
  const w = L.mode === 'controllo' ? '' : ' (richiesta, non comandata)';
  $('pillHeat').textContent = 'Caldo' + (L.heat ? w : ''); $('pillCool').textContent = 'Freddo' + (L.cool ? w : '');
  $('regolaTxt').textContent = L.extRule
    ? `Regola ambiente: caldo ${L.allowHeat ? 'consentito' : 'bloccato'}, freddo ${L.allowCool ? 'consentito' : 'bloccato'} (setpoint ${fmt(L.tset)} °C, esterna ${fmt(L.text)} °C).`
    : 'Temperatura esterna non disponibile: la regola ambiente non è applicata.';
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
    const r = await db.sendCmd('stop', {});
    if (!r.ok) { msg.textContent = `Non riesco a fermare la scheda: ${r.msg}`; $('eOk').disabled = false; return; }
    await db.updateRun(run.id, { status: out === 'annullata' ? 'cancelled' : 'done', end: Date.now(), volFinal: vf, outcome: out,
      rating: $('eRate').value ? +$('eRate').value : null, endNotes: $('eNotes').value.trim(),
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
function renderAdvice() {
  const cal = calibrate(S.runs), n = cal.n;
  $('calInfo').textContent = n ? `Calibrato su ${n} ciclo${n > 1 ? 'i' : ''} concluso${n > 1 ? 'i' : ''} (fattore ${fmt(cal.c, 2)}, incertezza ±${fmt(cal.spread * 100, 0)}%).` : 'Nessun ciclo concluso: uso il modello di partenza, incertezza ±25%.';
  const target = new Date($('cTarget').value).getTime(), from = new Date($('cFrom').value).getTime(), idr = +$('cIdr').value || 45, noNight = $('cNight').checked;
  if (!Number.isFinite(target) || !Number.isFinite(from)) return;
  const rows = [];
  for (const R of [1, 1.5, 2, 3]) for (const T of [23, 25, 27, 29]) {
    const h = predictHours(cal, R, idr, T), start = target - h * 3600e3, hr = new Date(start).getHours();
    const night = hr >= 23 || hr < 6, late = start < from, nR = cal.perRatio[String(R)]?.n || 0;
    rows.push({ R, T, h, start, night, late, nR, ok: !late && !(noNight && night), score: Math.abs(T - 26) - 0.5 * nR });
  }
  rows.sort((a, b) => (b.ok - a.ok) || (a.score - b.score));
  const best = rows[0], sp = cal.spread;
  $('advBest').innerHTML = best.ok
    ? `<div class="alert ok"><b>Consiglio: rapporto 1 : ${best.R} a ${best.T} °C</b>Rinfresca alle ${fmtDT(best.start)} (${best.start > Date.now() ? 'tra ' + fmtDur((best.start - Date.now()) / 3600e3) : 'ora'}). Pronto dopo circa ${fmtDur(best.h)} (tra ${fmtDur(best.h * (1 - sp))} e ${fmtDur(best.h * (1 + sp))}).</div>`
    : `<div class="alert warn"><b>Nessuna combinazione rispetta i vincoli</b>Prova a spostare l'orario o a togliere il vincolo notturno. In ogni caso, rinfrescando a ${fmtDT(from)} con 1 : 1 a 29 °C sarà pronto verso le ${fmtClock(from + predictHours(cal, 1, idr, 29) * 3600e3)}.</div>`;
  $('advTable').innerHTML = '<tr><th>Rapporto</th><th>Temp.</th><th>Rinfresca alle</th><th>Pronto dopo</th><th>Note</th></tr>' +
    rows.slice(0, 10).map((r, i) => `<tr class="${i === 0 && r.ok ? 'best' : r.ok ? '' : 'dim'}"><td>1 : ${r.R}</td><td>${r.T} °C</td><td>${fmtDT(r.start)}</td><td>${fmtDur(r.h)} ±${fmt(sp * 100, 0)}%</td>
      <td>${[r.late ? 'troppo tardi' : '', r.night ? 'di notte' : '', r.nR ? `già provato ${r.nR}×` : 'mai provato'].filter(Boolean).join(' · ')}</td></tr>`).join('');
}

// ------------------------------------------------------------------ schede e avvio
function showTab(name) {
  document.querySelectorAll('.tab').forEach((s) => { s.hidden = s.id !== 'tab-' + name; });
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  window.scrollTo(0, 0);
  if (name === 'ora') { requestAnimationFrame(() => { chTemp.resize(); chGrow.resize(); }); camTick(); }
  if (name === 'storico') { renderRuns(); renderCompare(); requestAnimationFrame(() => { chCmp.resize(); chCmpT.resize(); }); }
  if (name === 'consigli') { if (!$('cTarget').value) { $('cTarget').value = dtLocal(Date.now() + 10 * 3600e3); $('cFrom').value = dtLocal(Date.now()); } renderAdvice(); }
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
  ['cTarget', 'cFrom', 'cIdr', 'cNight'].forEach((i) => $(i).addEventListener('input', renderAdvice));
  $('btnArea').addEventListener('click', () => cmd('area', { area: +$('sArea').value }, 'Sezione aggiornata'));
  $('btnHold').addEventListener('click', () => cmd('hold', { tset: +$('sHold').value }, 'Temperatura a riposo impostata'));
  $('btnHoldOff').addEventListener('click', () => cmd('hold', { tset: null }, 'Nessuna regolazione a riposo'));
  $('sCam').value = localStorage.getItem('camUrl') || '';
  $('btnText').addEventListener('click', () => cmd('text', { t: +$('sText').value }, 'Temperatura esterna aggiornata'));
  $('btnCam').addEventListener('click', () => { localStorage.setItem('camUrl', $('sCam').value.trim()); camTick(); toast('Indirizzo salvato'); });
  $('btnClean').addEventListener('click', async () => { const n = await db.cleanIdle(7); $('cleanMsg').textContent = `Eliminati ${n} campioni.`; });
  $('btnLogout').addEventListener('click', () => db.signOut());
  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault(); $('liErr').textContent = '';
    try { await db.signIn($('liEmail').value.trim(), $('liPass').value); } catch (er) { $('liErr').textContent = 'Email o password non corretti.'; }
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', paintCharts);
}

async function main() {
  db = await openDb(cfg, DEMO);
  $('demoBadge').hidden = !DEMO;
  makeCharts(); wire(); paintCharts();
  let started = false;
  db.onAuth((u) => {
    $('login').hidden = !!u; $('app').hidden = !u;
    if (!u || started) return;
    started = true;
    db.onLive((l) => { S.live = l; renderLive(); });
    db.onRuns((r) => { S.runs = r; renderLive(); renderRuns(); });
    db.watchSeries('_idle', 900, (rows) => { S.idleSeries = rows; updateTempChart(); });
    setInterval(renderLive, 10000); setInterval(camTick, 3000);
  });
}
main();
