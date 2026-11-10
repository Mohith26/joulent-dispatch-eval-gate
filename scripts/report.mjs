// Prints the headline numbers shown on the page (same core, same data): node scripts/report.mjs
import fs from "node:fs";
import * as C from "../src/core.js";
const J = (f) => JSON.parse(fs.readFileSync(new URL("../data/" + f, import.meta.url)));
const days = C.buildDays(J("ercot_lz_west_2026.json"), J("weather_midland_2026.json"), J("dc_load_2026.json"));
const ctx = C.makeContext(days);
const pl = C.DEFAULT_PLANT, sum = (r, f) => r.reduce((s, d) => s + f(d), 0), M = (v) => (v / 1e6).toFixed(3) + "M";
const orc = C.runConfig(ctx, null, null, pl, { oracle: true });
const champ = C.runConfig(ctx, "P0", "L0");
console.log(`backtest ${days[ctx.scoreFrom].date} .. ${days[ctx.to].date}, ${ctx.to - ctx.scoreFrom + 1} days; oracle cost ${M(sum(orc, (d) => d.tot.total))}`);
for (const id of ["P0", "P1", "P2", "L0", "L1"]) { const a = C.accuracy(ctx, id); console.log(id, "MAE", a.mae.toFixed(2), "RMSE", a.rmse.toFixed(2), a.spikeMae != null ? "spikeMAE " + a.spikeMae.toFixed(1) : "cov99 " + (100 * C.loadCoverage(ctx, id, 0.01)).toFixed(1) + "%"); }
for (const [p, l, b] of [["P1", "L0"], ["P2", "L0"], ["P0", "L1"], ["P0", "L0", "gaussian"], ["P2", "L1"]]) {
  const r = C.runConfig(ctx, p, l, pl, { bound: b || "conformal" }), g = C.gate(champ, r, orc);
  console.log(`${p}+${l}${b ? "+" + b : ""}: regret ${M(g.chalRegret)} vs champion ${M(g.champRegret)}; delta ${M(g.deltaTotal)} CI90 [${M(g.ciTotal[0])}, ${M(g.ciTotal[1])}] -> ${g.verdict} (${g.reason}); days to decide ${C.daysToDecide(g)}; margin ${(sum(r, (d) => d.q) / r.length).toFixed(0)} MW vs ${(sum(champ, (d) => d.q) / champ.length).toFixed(0)}; unserved ${g.rel.chal.toFixed(0)} MWh`);
}
const v = C.forecastValueSplit(ctx, "P0", "L1");
console.log(`value split P0+L1: total ${M(v.total)} price ${M(v.price)} load ${M(v.load)}; perfect price leaves ${M(v.perfectPriceRegret)}`);
const v0 = C.forecastValueSplit(ctx, "P0", "L0");
console.log(`value split P0+L0: total ${M(v0.total)} price ${M(v0.price)} load ${M(v0.load)}`);
