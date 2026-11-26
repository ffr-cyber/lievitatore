// model.js - stesso modello del firmware (logic.h) e motore dei consigli.
export const MP = { tminR: 3, tmaxR: 38, cR: 0.3, tRef: 28, mu: 0.3529, lam: 0.0868, tsetMin: 22, tsetMax: 29 };

export function kT(T) {
  const sq = (t) => (t <= MP.tminR || t >= MP.tmaxR ? 0 : (t - MP.tminR) * (1 - Math.exp(MP.cR * (t - MP.tmaxR))));
  const r = sq(T) / sq(MP.tRef);
  return r * r;
}
export function TdiK(k) {
  let a = MP.tminR + 0.1, b = 33;
  if (kT(b) <= k) return b;
  for (let i = 0; i < 40; i++) { const m = (a + b) / 2; if (kT(m) < k) a = m; else b = m; }
  return (a + b) / 2;
}
// ore al pronto a 28 C costanti per rapporto 1:R (lievito:farina) e acqua % sulla farina
export function t28di(R, idr) {
  const x = 1 / (1 + R * (1 + idr / 100));
  return MP.lam + Math.log2(1 / x) / MP.mu;
}
export const VdiP = (P) => Math.exp(1.16315 * Math.exp(-Math.exp((1.487 * 2.71828 / 1.16315) * (0.30 - P) + 1)));

// ---------------------------------------------------------------- consigli
const median = (a) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN; };

// Un ciclo utile ha: ore al pronto misurate, temperatura media, rapporto e acqua.
// tempo al pronto (90% della crescita) di un ciclo: dalla curva adattata se c'e', altrimenti la fase misurata dalla scheda
export const readyOf = (r) => (r.fit && r.fit.readyH > 0.5 ? r.fit.readyH : r.readyH);
export function usableRuns(runs) {
  return runs.filter((r) => r.status === 'done' && readyOf(r) > 0.5 && r.tMean > 5 && r.ratio > 0 &&
    !['problema_tecnico', 'annullata'].includes(r.outcome));
}

// Fattore di calibrazione c: ore_misurate = c * t28(R, idr) / kT(Tmedia). c = 1 e' il modello a priori.
export function calibrate(runs) {
  const u = usableRuns(runs);
  const cs = u.map((r) => readyOf(r) * kT(r.tMean) / t28di(r.ratio, r.idr));
  if (cs.length === 0) return { c: 1, spread: 0.25, n: 0, perRatio: {}, kRel: SHAPE.kRel, A: {} };
  const c = median(cs);
  const dev = cs.map((x) => Math.abs(x - c) / c);
  const spread = Math.max(0.08, cs.length > 1 ? median(dev) * 1.4826 + 0.04 : 0.2);
  const perRatio = {};
  for (const r of u) {
    const key = String(r.ratio); const x = readyOf(r) * kT(r.tMean) / t28di(r.ratio, r.idr);
    (perRatio[key] ||= []).push(x);
  }
  for (const k of Object.keys(perRatio)) {
    const v = perRatio[k], m = median(v);
    perRatio[k] = { n: v.length, c: (m * v.length + c * 2) / (v.length + 2) };   // verso c con peso 2 (poche prove)
  }
  // forma della curva dai cicli adattati: k*pronto (larghezza relativa della salita) e ampiezza per rapporto
  const fits = u.filter((r) => r.fit && r.fit.k > 0 && r.fit.readyH > 0.5);
  const kRel = fits.length ? median(fits.map((r) => r.fit.k * r.fit.readyH)) : SHAPE.kRel;
  const A = {};
  for (const r of fits) if (r.fit.A > 0.1) (A[String(r.ratio)] ||= []).push(r.fit.A);
  for (const k of Object.keys(A)) A[k] = median(A[k]);
  return { c, spread, n: u.length, perRatio, kRel, A, nFit: fits.length };
}

// Ore previste al pronto a temperatura T
export function predictHours(cal, R, idr, T) {
  const c = cal.perRatio[String(R)]?.c ?? cal.c;
  const k = kT(T);
  return k > 0 ? c * t28di(R, idr) / k : Infinity;
}

// ---------------------------------------------------------------- curva di crescita
// Volume relativo V/V0 = 1 + A*(sigma(k(t-tm)) - sigma(-k tm)) / (1 - sigma(-k tm)); tm = istante di massima velocita'
// (poi la derivata cala), "pronto" = quota f della crescita complessiva (f=0,5: la derivata inizia a calare).
export const SHAPE = { kRel: 9.3, frac: 0.9 };             // k * (ore al 90%): larghezza della salita
export const TLIM = { min: 12, max: 29 };                  // temperature che la cella sa tenere (freddo fino a ~12 C)
const sig = (z) => 1 / (1 + Math.exp(-z));
const logit = (f) => Math.log(f / (1 - f));
export function curveV(p, t) {
  const s0 = sig(-p.k * p.tm);
  return 1 + p.A * (sig(p.k * (t - p.tm)) - s0) / (1 - s0);
}
export const readyAt = (p, f = SHAPE.frac) => p.tm + logit(f) / p.k;
// ampiezza a priori (volume finale / iniziale - 1): x2,4 con 1:1, x3 con 1:2 e oltre
export const Aprior = (R) => (R <= 1 ? 1.4 : R >= 2 ? 2.0 : 1.4 + 0.6 * (R - 1));

// Nelder-Mead minimale
function nelder(f, x0, step, iters = 400) {
  const n = x0.length; let P = [x0.slice()];
  for (let i = 0; i < n; i++) { const x = x0.slice(); x[i] += step[i]; P.push(x); }
  let F = P.map(f);
  for (let it = 0; it < iters; it++) {
    const o = F.map((v, i) => i).sort((a, b) => F[a] - F[b]); P = o.map((i) => P[i]); F = o.map((i) => F[i]);
    const c = P[0].map((_, j) => P.slice(0, n).reduce((a, p) => a + p[j], 0) / n);
    const at = (t) => c.map((v, j) => v + t * (P[n][j] - v));
    const xr = at(-1), fr = f(xr);
    if (fr < F[0]) { const xe = at(-2), fe = f(xe); if (fe < fr) { P[n] = xe; F[n] = fe; } else { P[n] = xr; F[n] = fr; } }
    else if (fr < F[n - 1]) { P[n] = xr; F[n] = fr; }
    else { const xc = at(fr < F[n] ? -0.5 : 0.5), fc = f(xc);
      if (fc < Math.min(fr, F[n])) { P[n] = xc; F[n] = fc; }
      else for (let i = 1; i <= n; i++) { P[i] = P[i].map((v, j) => P[0][j] + 0.5 * (v - P[0][j])); F[i] = f(P[i]); } }
  }
  const b = F.indexOf(Math.min(...F)); return { x: P[b], f: F[b] };
}

// pts: [{h (ore dall'avvio), v (V/V0)}]. Restituisce {A,k,tm,readyH,rmse,peakH,peakV,n} oppure null se non c'e' una crescita leggibile.
export function fitCurve(pts, frac = SHAPE.frac) {
  const d = pts.filter((p) => Number.isFinite(p.h) && Number.isFinite(p.v) && p.v > 0).sort((a, b) => a.h - b.h);
  if (d.length < 20) return null;
  // mediana mobile su 5 punti contro il rumore del laser
  const sm = d.map((p, i) => { const w = d.slice(Math.max(0, i - 2), i + 3).map((q) => q.v).sort((a, b) => a - b); return { h: p.h, v: w[(w.length - 1) >> 1] }; });
  let ip = 0; sm.forEach((p, i) => { if (p.v > sm[ip].v) ip = i; });
  const peakV = sm[ip].v, peakH = sm[ip].h;
  if (peakV < 1.15) return null;                              // niente crescita: non si adatta nulla
  const cut = sm.filter((p) => p.h <= peakH + 0.15 * Math.max(1, peakH));   // fino al picco (piu' un po')
  const v0 = cut.slice(0, 3).reduce((a, p) => a + p.v, 0) / Math.min(3, cut.length);
  const dat = cut.map((p) => ({ h: p.h - cut[0].h, v: p.v / v0 }));
  const H = dat[dat.length - 1].h;
  const err = (x) => { const [A, k, tm] = x; if (A < 0.05 || A > 8 || k < 0.1 || k > 60 || tm < 0 || tm > 3 * H) return 1e9;
    let e = 0; for (const p of dat) e += (curveV({ A, k, tm }, p.h) - p.v) ** 2; return e / dat.length; };
  // partenza: tm = dove la salita e' piu' ripida
  let best = null;
  for (const t0 of [0.4, 0.6, 0.8].map((q) => q * peakH)) for (const k0 of [0.5, 1.2, 3]) {
    const r = nelder(err, [peakV / v0 - 1, k0, t0], [0.2, k0 * 0.4, Math.max(0.3, t0 * 0.2)]);
    if (!best || r.f < best.f) best = r;
  }
  const [A, k, tm] = best.x, rmse = Math.sqrt(best.f);
  const p = { A, k, tm };
  return { A, k, tm, readyH: readyAt(p, frac), rmse, peakH: peakH - cut[0].h, peakV: peakV / v0, n: dat.length, frac };
}

// Ore previste al pronto (frac della crescita) con tutte le correzioni
export function predictCurve(cal, R, idr, T, frac = SHAPE.frac) {
  const kRel = cal.kRel || SHAPE.kRel, r90 = predictHours(cal, R, idr, T);
  const k = kRel / r90, tm = r90 - logit(0.9) / k;
  const A = cal.A?.[String(R)] ?? Aprior(R);
  const p = { A, k, tm };
  return { ...p, readyH: readyAt(p, frac), ready90: r90 };
}

// Temperatura necessaria per essere pronti (frac) tra 'ore' ore, per ciascun rapporto
export function advise(cal, ore, idr, ratios = [1, 1.5, 2, 3], frac = SHAPE.frac) {
  const kRel = cal.kRel || SHAPE.kRel, rho = 1 + (logit(frac) - logit(0.9)) / kRel;   // pronto(frac) = rho * pronto(90%)
  return ratios.map((R) => {
    const c = cal.perRatio[String(R)]?.c ?? cal.c;
    const Treq = TdiK(c * t28di(R, idr) * rho / ore);
    const feasible = Treq >= TLIM.min && Treq <= TLIM.max;
    const T = Math.min(TLIM.max, Math.max(TLIM.min, Treq));
    const cur = predictCurve(cal, R, idr, T, frac);
    const n = cal.perRatio[String(R)]?.n ?? 0;
    return { R, Treq, T, feasible, hours: cur.readyH, lo: cur.readyH * (1 - cal.spread), hi: cur.readyH * (1 + cal.spread), n, cur,
             early: !feasible && Treq < TLIM.min, late: !feasible && Treq > TLIM.max };
  });
}

// ---------------------------------------------------------------- salute e prove da fare
export const T_BANDS = [[12, 18], [18, 23], [23, 26], [26, 29.5]];
export const REF_1_1 = 3.25;                                // ore al pronto di un 1:1 a 27 C in un lievito in forma (valore di riferimento)
export function health(cal) {
  if (!cal.n) return null;
  const cRef = REF_1_1 * kT(27) / t28di(1, 45);
  const c1 = cal.perRatio['1']?.c ?? cal.c;
  const speed = cRef / c1;                                  // 1 = come il riferimento, <1 = piu' lento
  const a1 = cal.A?.['1'];
  const amp = a1 ? a1 / Aprior(1) : null;
  return { speed, amp, hasRatio1: !!cal.perRatio['1'] };
}
export function coverage(runs) {
  const u = usableRuns(runs), ratios = [1, 1.5, 2, 3];
  return ratios.map((R) => ({ R, cells: T_BANDS.map(([a, b]) => u.filter((r) => r.ratio === R && r.tMean >= a && r.tMean < b).length) }));
}
export function nextTests(runs) {
  const cov = coverage(runs), out = [];
  const need = [[1, 3], [1, 0], [2, 0], [1, 1], [2, 1], [1.5, 2], [3, 1]];   // priorita': 1:1 caldo, 1:1 e 1:2 freddo, poi il resto
  for (const [R, b] of need) { const row = cov.find((c) => c.R === R); if (row && row.cells[b] === 0) out.push({ R, band: b }); }
  return out;
}
export function bestOption(opts) {
  const ok = opts.filter((o) => o.feasible);
  const pool = ok.length ? ok : opts;
  return [...pool].sort((a, b) => (Math.abs(a.T - 26) - Math.abs(b.T - 26)) - 0.4 * (b.n - a.n))[0];
}
