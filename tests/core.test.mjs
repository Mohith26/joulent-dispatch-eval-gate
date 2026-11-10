import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as C from "../src/core.js";

const here = new URL("..", import.meta.url).pathname;
const J = (f) => JSON.parse(fs.readFileSync(here + "data/" + f));
const DAYS = C.buildDays(J("ercot_lz_west_2026.json"), J("weather_midland_2026.json"), J("dc_load_2026.json"));

test("ridge recovers a known linear model", () => {
  const rnd = C.mulberry32(1), X = [], y = [];
  for (let i = 0; i < 400; i++) { const a = rnd() * 10, b = rnd() * 5; X.push([a, b]); y.push(3 + 2 * a - 1.5 * b + (rnd() - 0.5) * 0.01); }
  const m = C.fitRidge(X, y, 1e-6);
  assert.ok(Math.abs(m.predict([4, 2]) - (3 + 8 - 3)) < 0.01);
});

test("split-conformal bound uses the ceil((n+1)(1-a)) order statistic and covers exchangeable data", () => {
  const r = Array.from({ length: 99 }, (_, i) => i + 1);
  assert.equal(C.conformalUpper(r, 0.1), 90);
  assert.equal(C.conformalUpper([1, 2, 3], 0.01), Infinity);
  const rnd = C.mulberry32(3); let hit = 0, n = 0;
  for (let t = 0; t < 400; t++) {
    const cal = Array.from({ length: 200 }, () => rnd() ** 2 * 100), q = C.conformalUpper(cal, 0.05);
    const x = rnd() ** 2 * 100; n++; if (x <= q) hit++;
  }
  assert.ok(hit / n > 0.92 && hit / n <= 1);
});

test("normal quantile approximation", () => {
  assert.ok(Math.abs(C.normInv(0.99) - 2.3263) < 1e-3);
  assert.ok(Math.abs(C.normInv(0.5)) < 1e-9);
  assert.ok(Math.abs(C.normInv(0.025) + 1.96) < 1e-3);
});

test("battery DP buys low, sells high, respects limits and returns to the target state of charge", () => {
  const pl = C.DEFAULT_PLANT, B = pl.bess;
  const prices = Array.from({ length: 24 }, (_, h) => (h < 6 ? 5 : h >= 18 && h < 22 ? 150 : 30));
  const x = C.planBattery(pl, prices, 600, 600);
  let soc = 600;
  x.forEach((xi) => {
    assert.ok(Math.abs(xi) <= B.p + 1e-9);
    soc += xi > 0 ? xi * B.eta : xi;
    assert.ok(soc >= -1e-9 && soc <= B.e + 1e-9);
  });
  assert.ok(Math.abs(soc - 600) < 1e-6);
  const cheap = x.slice(0, 6).reduce((a, b) => a + b, 0), dear = x.slice(18, 22).reduce((a, b) => a + b, 0);
  assert.ok(cheap > 0 && dear < 0);
  assert.deepEqual(C.planBattery(pl, new Array(24).fill(30), 600, 600), new Array(24).fill(0)); // flat prices: idle
});

test("dispatch runs blocks to max above marginal cost and to minimum below it", () => {
  const pl = C.DEFAULT_PLANT, c = C.marginalCost(pl);
  const hi = C.dispatchHour(pl, 10, c + 50, 2000, 0), lo = C.dispatchHour(pl, 10, c - 10, 2000, 0);
  assert.equal(hi.G, 2250); assert.equal(hi.gridFlow, 250);
  assert.equal(lo.G, 1600); assert.equal(lo.gridFlow, -400);
  const short = C.dispatchHour(pl, 6, 30, 2000, 0); // 1350 MW + 400 import < 2000
  assert.equal(short.unserved, 250);
});

test("commitment honours the reliability floor and commits fewer blocks when grid power is cheap", () => {
  const pl = C.DEFAULT_PLANT;
  const cheap = Array.from({ length: 24 }, () => [[-5, 1800]]), dear = Array.from({ length: 24 }, () => [[120, 1800]]);
  const x = new Array(24).fill(0), floor = new Array(24).fill(7);
  const uc = C.commit(pl, cheap, x, floor, 9), ud = C.commit(pl, dear, x, floor, 9);
  assert.ok(uc.every((u) => u >= 7));
  assert.ok(uc.reduce((a, b) => a + b) < ud.reduce((a, b) => a + b));
  assert.ok(ud.every((u) => u === pl.units)); // $120 power: export everything the plant can make
});

test("settlement override uses the battery before counting unserved load", () => {
  const pl = C.DEFAULT_PLANT;
  const u = new Array(24).fill(6), x = new Array(24).fill(0);
  const loads = new Array(24).fill(1900); // 6*225 + 400 = 1750 -> 150 MW short each hour without the battery
  const s = C.settleDay(pl, u, x, new Array(24).fill(30), loads, 600, 6);
  assert.equal(s.hours[0].unserved, 0);
  assert.ok(s.hours[0].x < 0);
  assert.ok(s.tot.unservedMWh > 0); // battery empties after 4 hours
  const total = s.hours.reduce((a, h) => a + h.total, 0);
  assert.ok(Math.abs(total - s.tot.total) < 1e-6);
});

test("forecasts never look ahead: changing the future does not change a day's forecast", () => {
  const k = 120;
  const a = C.forecast(DAYS, "P1", k, k)[k], b = C.forecast(DAYS, "L1", k, k)[k];
  const mutated = DAYS.map((d, i) => (i < k ? d : i === k
    ? { ...d, rt: d.rt.map(() => 9999), load: d.load.map(() => 1), tobs: d.tobs.map(() => 99) } // unknown at decision time
    : { ...d, rt: d.rt.map(() => -500), da: d.da.map(() => 0), load: d.load.map(() => 0), tfc: d.tfc.map(() => 0) }));
  // also the second half of day k-1 is unknown at noon on k-1
  mutated[k - 1] = { ...DAYS[k - 1], rt: DAYS[k - 1].rt.map((v, h) => (h >= 11 ? 9999 : v)), load: DAYS[k - 1].load.map((v, h) => (h >= 11 ? 1 : v)) };
  assert.deepEqual(C.forecast(mutated, "P1", k, k)[k], a);
  assert.deepEqual(C.forecast(mutated, "L1", k, k)[k], b);
});

test("backtest: oracle has zero regret against itself, gate and value split are internally consistent", () => {
  const ctx = C.makeContext(DAYS);
  const orc = C.runConfig(ctx, null, null, C.DEFAULT_PLANT, { oracle: true });
  assert.ok(C.regretSeries(orc, orc).every((v) => v === 0));
  const champ = C.runConfig(ctx, "P0", "L0"), chal = C.runConfig(ctx, "P0", "L1");
  const g = C.gate(champ, chal, orc);
  assert.ok(Math.abs(g.deltaTotal - (g.chalRegret - g.champRegret)) < 1e-3);
  assert.ok(g.ciTotal[0] <= g.deltaTotal && g.deltaTotal <= g.ciTotal[1]);
  assert.ok(["PROMOTE", "HOLD", "BLOCK"].includes(g.verdict));
  const v = C.forecastValueSplit(ctx, "P0", "L0");
  assert.ok(Math.abs(v.price + v.load - v.total) < 1e-3);
  const reg = C.regretByRegime(champ, orc).reduce((a, r) => a + r.regret, 0);
  assert.ok(Math.abs(reg - g.champRegret) < 1e-3);
  assert.equal(C.regretByRegime(champ, orc).reduce((a, r) => a + r.hours, 0), champ.length * 24);
});

test("block bootstrap is deterministic and brackets the mean", () => {
  const rnd = C.mulberry32(9), s = Array.from({ length: 120 }, () => rnd() - 0.3);
  const a = C.blockBootstrapCI(s), b = C.blockBootstrapCI(s);
  assert.deepEqual(a, b);
  assert.ok(a.lo < a.mean && a.mean < a.hi);
  const g = { verdict: "HOLD", n: 100, deltaTotal: -10, ciTotal: [-30, 10] };
  assert.ok(C.daysToDecide(g) > 0);
  assert.equal(C.daysToDecide({ ...g, verdict: "PROMOTE" }), null);
});
