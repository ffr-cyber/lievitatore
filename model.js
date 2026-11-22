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
export function usableRuns(runs) {
  return runs.filter((r) => r.status === 'done' && r.readyH > 0.5 && r.tMean > 5 && r.ratio > 0 &&
    !['problema_tecnico', 'annullata'].includes(r.outcome));
}

// Fattore di calibrazione c: ore_misurate = c * t28(R, idr) / kT(Tmedia). c = 1 e' il modello a priori.
export function calibrate(runs) {
  const u = usableRuns(runs);
  const cs = u.map((r) => r.readyH * kT(r.tMean) / t28di(r.ratio, r.idr));
  if (cs.length === 0) return { c: 1, spread: 0.25, n: 0, perRatio: {} };
  const c = median(cs);
  const dev = cs.map((x) => Math.abs(x - c) / c);
  const spread = Math.max(0.08, cs.length > 1 ? median(dev) * 1.4826 + 0.04 : 0.2);
  const perRatio = {};
  for (const r of u) {
    const key = String(r.ratio); const x = r.readyH * kT(r.tMean) / t28di(r.ratio, r.idr);
    (perRatio[key] ||= []).push(x);
  }
  for (const k of Object.keys(perRatio)) {
    const v = perRatio[k], m = median(v);
    perRatio[k] = { n: v.length, c: (m * v.length + c * 2) / (v.length + 2) };   // verso c con peso 2 (poche prove)
  }
  return { c, spread, n: u.length, perRatio };
}

// Ore previste al pronto a temperatura T
export function predictHours(cal, R, idr, T) {
  const c = cal.perRatio[String(R)]?.c ?? cal.c;
  const k = kT(T);
  return k > 0 ? c * t28di(R, idr) / k : Infinity;
}

// Per ogni rapporto: temperatura necessaria per essere pronti tra 'ore' ore
export function advise(cal, ore, idr, ratios = [1, 1.5, 2, 3]) {
  return ratios.map((R) => {
    const c = cal.perRatio[String(R)]?.c ?? cal.c;
    const Treq = TdiK(c * t28di(R, idr) / ore);
    const feasible = Treq >= MP.tsetMin && Treq <= MP.tsetMax;
    const T = Math.min(MP.tsetMax, Math.max(MP.tsetMin, Treq));
    const h = predictHours(cal, R, idr, T);
    const n = cal.perRatio[String(R)]?.n ?? 0;
    return { R, Treq, T, feasible, hours: h, lo: h * (1 - cal.spread), hi: h * (1 + cal.spread), n,
             early: !feasible && Treq < MP.tsetMin, late: !feasible && Treq > MP.tsetMax };
  });
}
export function bestOption(opts) {
  const ok = opts.filter((o) => o.feasible);
  const pool = ok.length ? ok : opts;
  // preferisci temperature centrali (24-27 C) e rapporti gia' provati
  return [...pool].sort((a, b) => (Math.abs(a.T - 26) - Math.abs(b.T - 26)) - 0.4 * (b.n - a.n))[0];
}
