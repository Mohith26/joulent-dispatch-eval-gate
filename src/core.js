// Dispatch-aware Eval Gate: core library (no dependencies; runs in the browser and under `node --test`).
//
// Pipeline, per backtest day d (decision made at noon on d-1, after the ERCOT day-ahead market clears):
//   1. forecasters predict tomorrow's 24 hourly real-time prices and site load from information available then;
//   2. each forecaster's own out-of-sample residuals from the previous K days become joint (price, load) scenarios
//      and a split-conformal upper bound on load (the reliability margin);
//   3. a battery DP plans charge/discharge on the price forecast; a unit-commitment DP picks how many turbine blocks
//      to keep online each hour (start costs, no-load costs, scenario-expected dispatch cost, conformal reliability floor);
//   4. the plan is settled against what actually happened (real ERCOT LZ_WEST prices, simulated campus load);
//   5. regret = settled cost - cost of the same decision process run with perfect foresight.
// The gate compares a challenger's daily regret with the champion's using a moving-block bootstrap.

export const DEFAULT_PLANT = {
  units: 12, pmax: 225, pminFrac: 0.4,       // 12 x 225 MW turbine blocks (~2.7 GW)
  heatRate: 7.0, gas: 2.5, vom: 2.5,          // MMBtu/MWh, $/MMBtu, $/MWh
  noLoad: 1200, startCost: 15000,             // $/unit-hour online, $/start
  importCap: 400, exportCap: 800,             // MW across the meter
  bess: { p: 300, e: 1200, eta: 0.87, deg: 4, step: 50 },
  voll: 10000,                                // $/MWh of unserved campus load
};

export const marginalCost = (pl) => pl.heatRate * pl.gas + pl.vom;

// ---------- small numerics ----------
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function solveSPD(A, b) {
  // Cholesky solve for a symmetric positive-definite system.
  const n = b.length, L = A.map((r) => r.map(() => 0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) {
        if (s <= 0) throw new Error("matrix not positive definite");
        L[i][i] = Math.sqrt(s);
      } else L[i][j] = s / L[j][j];
    }
  }
  const y = new Array(n).fill(0), x = new Array(n).fill(0);
  for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i][k] * y[k]; y[i] = s / L[i][i]; }
  for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k]; x[i] = s / L[i][i]; }
  return x;
}

// Ridge regression with standardized features and an unpenalized intercept.
export function fitRidge(X, y, lambda = 1) {
  const n = X.length, p = X[0].length;
  const mu = new Array(p).fill(0), sd = new Array(p).fill(0);
  for (const r of X) for (let j = 0; j < p; j++) mu[j] += r[j] / n;
  for (const r of X) for (let j = 0; j < p; j++) sd[j] += (r[j] - mu[j]) ** 2 / n;
  for (let j = 0; j < p; j++) sd[j] = Math.sqrt(sd[j]) || 1;
  const ym = y.reduce((a, b) => a + b, 0) / n;
  const A = Array.from({ length: p }, () => new Array(p).fill(0)), b = new Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    const z = X[i].map((v, j) => (v - mu[j]) / sd[j]);
    for (let j = 0; j < p; j++) { b[j] += z[j] * (y[i] - ym); for (let k = 0; k <= j; k++) A[j][k] += z[j] * z[k]; }
  }
  for (let j = 0; j < p; j++) { for (let k = 0; k < j; k++) A[k][j] = A[j][k]; A[j][j] += lambda; }
  const beta = solveSPD(A, b);
  return { predict: (x) => ym + x.reduce((s, v, j) => s + beta[j] * (v - mu[j]) / sd[j], 0), beta, mu, sd };
}

export function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// Split-conformal upper bound: the ceil((n+1)(1-alpha))-th smallest residual (finite-sample valid under exchangeability).
export function conformalUpper(residuals, alpha) {
  const s = [...residuals].sort((a, b) => a - b), n = s.length;
  const k = Math.ceil((n + 1) * (1 - alpha));
  return k > n ? Infinity : s[k - 1];
}

// Parametric alternative: mean + z * sd of the same residuals (assumes Gaussian errors).
export function gaussianUpper(residuals, alpha) {
  const n = residuals.length, m = residuals.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(residuals.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
  return m + normInv(1 - alpha) * sd;
}
// Acklam's rational approximation to the standard normal quantile.
export function normInv(p) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - pl) return -normInv(1 - p);
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// ---------- data ----------
export function buildDays(ercot, weather, load) {
  const key = (d, h) => d + "|" + h;
  const P = new Map(ercot.rows.map((r) => [key(r[0], r[1]), r]));
  const W = new Map(weather.rows.map((r) => [key(r[0], r[1]), r]));
  const L = new Map(load.rows.map((r) => [key(r[0], r[1]), r]));
  const dates = [...new Set(ercot.rows.map((r) => r[0]))].filter((d) => W.has(key(d, 12)) && L.has(key(d, 12))).sort();
  const days = [];
  for (const date of dates) {
    const day = { date, da: [], rt: [], tfc: [], tobs: [], load: [], filled: 0 };
    for (let h = 1; h <= 24; h++) {
      let p = P.get(key(date, h)), w = W.get(key(date, h)), l = L.get(key(date, h));
      if (!p || !w || !l) { // DST short day: carry the previous hour forward
        day.filled++;
        const j = h - 2;
        day.da.push(day.da[j]); day.rt.push(day.rt[j]); day.tfc.push(day.tfc[j]); day.tobs.push(day.tobs[j]); day.load.push(day.load[j]);
        continue;
      }
      day.da.push(p[2]); day.rt.push(p[3]); day.tfc.push(w[3]); day.tobs.push(w[2]); day.load.push(l[2]);
    }
    days.push(day);
  }
  return days;
}

const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const LAST_KNOWN_HE = 11; // telemetry and RT prices known through HE11 of d-1 when the plan is made at noon
const block = (h) => { const b = new Array(5).fill(0); const k = Math.floor((h - 1) / 4); if (k > 0) b[k - 1] = 1; return b; };
const isWeekend = (date) => { const wd = new Date(date + "T12:00:00Z").getUTCDay(); return wd === 0 || wd === 6 ? 1 : 0; };

function priceFeatures(days, k, h) {
  const d = days[k], y1 = days[k - 1], y2 = days[k - 2];
  return [
    d.da[h - 1], Math.max(0, d.da[h - 1] - 75), y2.rt[h - 1],
    mean(y1.rt.slice(0, LAST_KNOWN_HE)), mean(d.da), d.tfc[h - 1], Math.max(0, d.tfc[h - 1] - 30), ...block(h),
  ];
}
const lastSameHourLoad = (days, k, h) => (h <= LAST_KNOWN_HE ? days[k - 1] : days[k - 2]).load[h - 1];
function loadFeatures(days, k, h) {
  const d = days[k];
  return [
    days[k - 1].load[LAST_KNOWN_HE - 1], lastSameHourLoad(days, k, h),
    Math.max(0, d.tfc[h - 1] - 12), isWeekend(d.date), ...block(h),
  ];
}

const S = 20; // asinh scale ($/MWh)
export const FORECASTERS = {
  price: {
    P0: { id: "P0", name: "Day-ahead price", short: "DA as RT", kind: "price", role: "champion",
      about: "Uses the cleared LZ_WEST day-ahead price as the real-time forecast." },
    P1: { id: "P1", name: "Ridge, dollar loss", short: "Ridge", kind: "price",
      about: "Learns the DA-to-RT spread from DA price, a DA spike term, lagged RT, weather forecast and hour blocks." },
    P2: { id: "P2", name: "Ridge, asinh loss", short: "Ridge asinh", kind: "price",
      about: "Same features, trained on asinh(price/20), which damps the pull of spike hours on the fit." },
  },
  load: {
    L0: { id: "L0", name: "Last observed same hour", short: "Persistence", kind: "load", role: "champion",
      about: "Most recent observed load for the same hour (yesterday through HE11, else two days back)." },
    L1: { id: "L1", name: "Ridge with weather", short: "Ridge", kind: "load",
      about: "Ridge on latest telemetry, same-hour persistence, cooling-degree forecast, weekend and hour blocks." },
  },
};

// Produce day-ahead forecasts for days[from..to] (inclusive) with a rolling training window.
export function forecast(days, id, from, to, { trainDays = 56, lambda = 3, lambdaPrice = 50 } = {}) {
  const out = {};
  for (let k = from; k <= to; k++) {
    let pred;
    if (id === "P0") pred = days[k].da.slice();
    else if (id === "L0") pred = Array.from({ length: 24 }, (_, i) => lastSameHourLoad(days, k, i + 1));
    else {
      const X = [], y = [], isPrice = id[0] === "P";
      for (let j = Math.max(2, k - 1 - trainDays); j <= k - 2; j++) { // targets fully observed by decision time
        for (let h = 1; h <= 24; h++) {
          X.push(isPrice ? priceFeatures(days, j, h) : loadFeatures(days, j, h));
          const t = isPrice ? days[j].rt[h - 1] - days[j].da[h - 1] : days[j].load[h - 1]; // price models learn the DA->RT spread
          y.push(id === "P2" ? Math.asinh(t / S) : t);
        }
      }
      const m = fitRidge(X, y, isPrice ? lambdaPrice : lambda);
      const yLo = Math.min(...y), yHi = Math.max(...y); // never extrapolate beyond the training range
      pred = Array.from({ length: 24 }, (_, i) => {
        const f = isPrice ? priceFeatures(days, k, i + 1) : loadFeatures(days, k, i + 1);
        const v = Math.min(yHi, Math.max(yLo, m.predict(f))), base = isPrice ? days[k].da[i] : 0;
        return base + (id === "P2" ? S * Math.sinh(v) : v);
      });
    }
    out[k] = pred;
  }
  return out;
}

// ---------- operations models ----------
// Real-time dispatch of committed turbine blocks for one hour. x = battery grid MW (+ charging, - discharging).
export function dispatchHour(pl, u, price, load, x) {
  const c = marginalCost(pl), cap = u * pl.pmax, floor = u * pl.pmax * pl.pminFrac, need = load + x;
  let G = price > c ? Math.min(cap, need + pl.exportCap) : Math.max(floor, need - pl.importCap);
  G = Math.min(Math.max(G, floor), cap);
  const g = G - need; // + export, - import
  const unserved = Math.max(0, -pl.importCap - g);
  const gridFlow = Math.max(g, -pl.importCap);
  return { G, gridFlow, unserved, cost: c * G - price * gridFlow + pl.voll * unserved };
}

// Battery day-ahead schedule: DP over a state-of-charge grid, maximizing forecast arbitrage value.
export function planBattery(pl, prices, soc0, socEnd) {
  const B = pl.bess, n = Math.round(B.e / B.step) + 1, H = prices.length;
  const s0 = Math.round(soc0 / B.step), sT = Math.round(socEnd / B.step);
  const maxUp = Math.floor((B.p * B.eta) / B.step), maxDn = Math.floor(B.p / B.step);
  const V = Array.from({ length: H + 1 }, () => new Array(n).fill(-Infinity));
  const A = Array.from({ length: H }, () => new Array(n).fill(0));
  V[H][sT] = 0;
  for (let h = H - 1; h >= 0; h--) {
    for (let s = 0; s < n; s++) {
      for (let ds = -maxDn; ds <= maxUp; ds++) {
        const t = s + ds;
        if (t < 0 || t >= n || V[h + 1][t] === -Infinity) continue;
        const e = ds * B.step, x = e > 0 ? e / B.eta : e; // grid MW (+ charge)
        const val = -prices[h] * x - B.deg * Math.abs(x) + V[h + 1][t];
        if (val > V[h][s]) { V[h][s] = val; A[h][s] = ds; }
      }
    }
  }
  const x = [];
  let s = s0;
  if (V[0][s] === -Infinity) return new Array(H).fill(0);
  for (let h = 0; h < H; h++) { const ds = A[h][s]; const e = ds * B.step; x.push(e > 0 ? e / B.eta : e); s += ds; }
  return x;
}

// Unit commitment DP: hourly cost = no-load + scenario-expected dispatch cost; start costs on increases;
// reliability floor uMin[h] from the conformal load bound.
export function commit(pl, scen, x, uMin, uPrev) {
  const H = scen.length, N = pl.units;
  const hourCost = Array.from({ length: H }, (_, h) => {
    const row = new Array(N + 1).fill(Infinity);
    for (let u = uMin[h]; u <= N; u++) {
      let s = 0;
      for (const [p, l] of scen[h]) s += dispatchHour(pl, u, p, l, x[h]).cost;
      row[u] = pl.noLoad * u + s / scen[h].length;
    }
    return row;
  });
  const V = Array.from({ length: H + 1 }, () => new Array(N + 1).fill(0));
  const arg = Array.from({ length: H }, () => new Array(N + 1).fill(0));
  for (let h = H - 1; h >= 0; h--) {
    for (let up = 0; up <= N; up++) {
      let best = Infinity, bu = N;
      for (let u = uMin[h]; u <= N; u++) {
        const v = hourCost[h][u] + pl.startCost * Math.max(0, u - up) + V[h + 1][u];
        if (v < best) { best = v; bu = u; }
      }
      V[h][up] = best; arg[h][up] = bu;
    }
  }
  const u = [];
  let prev = uPrev;
  for (let h = 0; h < H; h++) { prev = arg[h][prev]; u.push(prev); }
  return u;
}

// Settle a plan against actuals, with a reliability override: if the site would be short, cancel battery
// charging and discharge what the battery holds before counting unserved load.
export function settleDay(pl, u, xPlan, prices, loads, soc0, uPrev) {
  const B = pl.bess, c = marginalCost(pl);
  let soc = soc0, prev = uPrev;
  const hours = [];
  const tot = { fuel: 0, noLoad: 0, starts: 0, grid: 0, bess: 0, unservedCost: 0, unservedMWh: 0, shortHours: 0, total: 0 };
  for (let h = 0; h < 24; h++) {
    let x = xPlan[h];
    x = x > 0 ? Math.min(x, (B.e - soc) / B.eta) : Math.max(x, -soc); // keep SOC feasible after any override
    let r = dispatchHour(pl, u[h], prices[h], loads[h], x);
    if (r.unserved > 0) { // lower the battery's draw by the deficit: cancel charging first, then discharge
      x = Math.max(x - r.unserved, -Math.min(B.p, soc));
      r = dispatchHour(pl, u[h], prices[h], loads[h], x);
    }
    soc += x > 0 ? x * B.eta : x;
    const starts = Math.max(0, u[h] - prev) * pl.startCost;
    prev = u[h];
    const fuel = c * r.G, noLoad = pl.noLoad * u[h];
    const grid = -prices[h] * (r.gridFlow + x); // plant + campus position across the meter
    const bess = prices[h] * x + B.deg * Math.abs(x);
    const unservedCost = pl.voll * r.unserved;
    const total = fuel + noLoad + starts + grid + bess + unservedCost;
    hours.push({ u: u[h], x, G: r.G, gridFlow: r.gridFlow, unserved: r.unserved, soc, total, price: prices[h], load: loads[h] });
    tot.fuel += fuel; tot.noLoad += noLoad; tot.starts += starts; tot.grid += grid; tot.bess += bess;
    tot.unservedCost += unservedCost; tot.unservedMWh += r.unserved; tot.shortHours += r.unserved > 1e-6 ? 1 : 0; tot.total += total;
  }
  return { hours, tot, socEnd: soc, uEnd: prev };
}

// ---------- backtest ----------
export function makeContext(days, { warmup = 21, firstForecastDay = 60, K = 21 } = {}) {
  const from = firstForecastDay, to = days.length - 1, scoreFrom = from + warmup;
  const preds = {};
  for (const id of ["P0", "P1", "P2", "L0", "L1"]) preds[id] = forecast(days, id, from, to);
  return { days, preds, from, to, scoreFrom, K };
}

// Residual pool for decision day k: days k-2 .. k-1-K (day k-1 is not complete at noon on k-1).
function residualDays(ctx, k) {
  const r = [];
  for (let j = k - 2; j >= Math.max(ctx.from, k - 1 - ctx.K); j--) r.push(j);
  return r;
}

export function runConfig(ctx, priceId, loadId, pl = DEFAULT_PLANT, { alpha = 0.01, oracle = false, bound = "conformal", perfectPrice = false, perfectLoad = false } = {}) {
  const { days, preds } = ctx, B = pl.bess;
  let soc = B.e / 2, uPrev = Math.min(pl.units, Math.max(0, Math.ceil((days[ctx.scoreFrom - 1].load[23] - pl.importCap) / pl.pmax)));
  const daily = [];
  for (let k = ctx.scoreFrom; k <= ctx.to; k++) {
    const d = days[k];
    let pHat, lHat, scen, uMin, q = 0;
    // "perfect" inputs (used for the oracle and for value-of-information) carry no residual uncertainty
    const pPerfect = oracle || perfectPrice, lPerfect = oracle || perfectLoad;
    pHat = pPerfect ? d.rt : preds[priceId][k];
    lHat = lPerfect ? d.load : preds[loadId][k];
    const js = residualDays(ctx, k);
    scen = Array.from({ length: 24 }, (_, h) => (pPerfect && lPerfect ? [k] : js).map((j) => [
      pHat[h] + (pPerfect ? 0 : days[j].rt[h] - preds[priceId][j][h]),
      lHat[h] + (lPerfect ? 0 : days[j].load[h] - preds[loadId][j][h]),
    ]));
    if (!lPerfect) {
      const pooled = [];
      for (const j of js) for (let h = 0; h < 24; h++) pooled.push(days[j].load[h] - preds[loadId][j][h]);
      q = bound === "gaussian" ? gaussianUpper(pooled, alpha) : conformalUpper(pooled, alpha);
    }
    uMin = lHat.map((l) => Math.min(pl.units, Math.max(0, Math.ceil((l + q - pl.importCap) / pl.pmax))));
    const x = planBattery(pl, pHat, soc, B.e / 2);
    const u = commit(pl, scen, x, uMin, uPrev);
    const s = settleDay(pl, u, x, d.rt, d.load, soc, uPrev);
    soc = s.socEnd; uPrev = s.uEnd;
    daily.push({ k, date: d.date, pHat, lHat, q, u, x, ...s });
  }
  return daily;
}

export function accuracy(ctx, id) {
  const { days, preds } = ctx, isPrice = id[0] === "P";
  const err = [], spikeErr = [];
  const allRt = [];
  for (let k = ctx.scoreFrom; k <= ctx.to; k++) allRt.push(...days[k].rt);
  const spikeCut = quantile([...allRt].sort((a, b) => a - b), 0.95);
  for (let k = ctx.scoreFrom; k <= ctx.to; k++) {
    for (let h = 0; h < 24; h++) {
      const a = isPrice ? days[k].rt[h] : days[k].load[h], e = preds[id][k][h] - a;
      err.push(e);
      if (isPrice && a >= spikeCut) spikeErr.push(e);
    }
  }
  const mae = mean(err.map(Math.abs)), rmse = Math.sqrt(mean(err.map((e) => e * e))), bias = mean(err);
  return { mae, rmse, bias, n: err.length, spikeCut, spikeMae: spikeErr.length ? mean(spikeErr.map(Math.abs)) : null, spikeBias: spikeErr.length ? mean(spikeErr) : null };
}

// Empirical coverage of the conformal load bound used for the reliability floor.
export function loadCoverage(ctx, loadId, alpha, bound = "conformal") {
  let hit = 0, n = 0;
  for (let k = ctx.scoreFrom; k <= ctx.to; k++) {
    const js = residualDays(ctx, k), pooled = [];
    for (const j of js) for (let h = 0; h < 24; h++) pooled.push(ctx.days[j].load[h] - ctx.preds[loadId][j][h]);
    const q = bound === "gaussian" ? gaussianUpper(pooled, alpha) : conformalUpper(pooled, alpha);
    for (let h = 0; h < 24; h++) { n++; if (ctx.days[k].load[h] <= ctx.preds[loadId][k][h] + q) hit++; }
  }
  return hit / n;
}

// Moving-block bootstrap of the mean of a daily series (keeps weekly/weather autocorrelation).
export function blockBootstrapCI(series, { B = 2000, block = 7, level = 0.9, seed = 7 } = {}) {
  const n = series.length, rnd = mulberry32(seed), means = [];
  const nb = Math.ceil(n / block);
  for (let b = 0; b < B; b++) {
    let s = 0, c = 0;
    for (let i = 0; i < nb; i++) {
      const st = Math.floor(rnd() * (n - block + 1));
      for (let j = 0; j < block && c < n; j++, c++) s += series[st + j];
    }
    means.push(s / n);
  }
  means.sort((a, b) => a - b);
  return { lo: quantile(means, (1 - level) / 2), hi: quantile(means, 1 - (1 - level) / 2), mean: mean(series) };
}

export function regretSeries(run, oracleRun) { return run.map((d, i) => d.tot.total - oracleRun[i].tot.total); }

// Gate verdict for a challenger vs the champion.
export function gate(champRun, chalRun, oracleRun, opts = {}) {
  const rc = regretSeries(champRun, oracleRun), rn = regretSeries(chalRun, oracleRun);
  const delta = rn.map((v, i) => v - rc[i]);
  const ci = blockBootstrapCI(delta, opts);
  const n = delta.length;
  const unserved = (r) => r.reduce((s, d) => s + d.tot.unservedMWh, 0);
  const shortHours = (r) => r.reduce((s, d) => s + d.tot.shortHours, 0);
  const rel = { champ: unserved(champRun), chal: unserved(chalRun), champHours: shortHours(champRun), chalHours: shortHours(chalRun) };
  const relWorse = rel.chal > rel.champ + 1e-6;
  let verdict, reason;
  if (relWorse) { verdict = "BLOCK"; reason = "reliability regressed"; }
  else if (ci.lo > 0) { verdict = "BLOCK"; reason = "costs significantly more"; }
  else if (ci.hi < 0) { verdict = "PROMOTE"; reason = "saves money with no reliability loss"; }
  else { verdict = "HOLD"; reason = "difference is within noise"; }
  return {
    verdict, reason, n,
    champRegret: rc.reduce((a, b) => a + b, 0), chalRegret: rn.reduce((a, b) => a + b, 0),
    deltaTotal: ci.mean * n, ciTotal: [ci.lo * n, ci.hi * n], delta, rc, rn, rel,
  };
}

// Value of information: two-player Shapley split of a configuration's regret between its price and load forecasts.
// R(P,L) is regret with both forecasts; swapping one input for perfect foresight measures what its errors cost.
export function forecastValueSplit(ctx, priceId, loadId, pl = DEFAULT_PLANT, opts = {}) {
  const tot = (r) => r.reduce((s, d) => s + d.tot.total, 0);
  const O = tot(runConfig(ctx, null, null, pl, { ...opts, oracle: true }));
  const RPL = tot(runConfig(ctx, priceId, loadId, pl, opts)) - O;
  const RoL = tot(runConfig(ctx, priceId, loadId, pl, { ...opts, perfectPrice: true })) - O;
  const RPo = tot(runConfig(ctx, priceId, loadId, pl, { ...opts, perfectLoad: true })) - O;
  const price = 0.5 * ((RPL - RoL) + (RPo - 0)), load = 0.5 * ((RPL - RPo) + (RoL - 0));
  return { total: RPL, price, load, perfectPriceRegret: RoL, perfectLoadRegret: RPo };
}

// How many more scored days the gate needs to separate the challenger from the champion at this effect size
// (normal approximation with the bootstrap standard error; null when the effect is already significant or zero).
export function daysToDecide(g, z = 1.645) {
  const se = (g.ciTotal[1] - g.ciTotal[0]) / (2 * z) / g.n; // per-day-mean SE
  const eff = Math.abs(g.deltaTotal / g.n);
  if (g.verdict !== "HOLD" || eff === 0) return null;
  const need = g.n * ((z * se) / eff) ** 2;
  return Math.max(0, Math.ceil(need - g.n));
}

// Attribute regret to hours by the actual real-time price regime.
export const REGIMES = [
  { id: "neg", label: "< $0", lo: -Infinity, hi: 0 },
  { id: "low", label: "$0-25", lo: 0, hi: 25 },
  { id: "mid", label: "$25-60", lo: 25, hi: 60 },
  { id: "high", label: "$60-200", lo: 60, hi: 200 },
  { id: "spike", label: "> $200", lo: 200, hi: Infinity },
];
export function regretByRegime(run, oracleRun, pl = DEFAULT_PLANT) {
  const out = REGIMES.map((r) => ({ ...r, regret: 0, hours: 0 }));
  run.forEach((d, i) => {
    const o = oracleRun[i];
    // start costs are booked in the hour the unit starts, so hour totals sum exactly to the day total
    d.hours.forEach((hh, h) => {
      const r = out.find((g) => hh.price >= g.lo && hh.price < g.hi);
      r.regret += hh.total - o.hours[h].total; r.hours++;
    });
  });
  return out;
}
