import * as C from "./core.js";

const D = window.EI_DATA;
const days = C.buildDays(D.ercot, D.weather, D.load);
const ctx = C.makeContext(days);
const F = C.FORECASTERS;
const $ = (id) => document.getElementById(id);
const state = { price: "P0", load: "L1", bound: "conformal", alpha: 0.01, gas: 2.5, day: null };

// ---------- formatting ----------
const money = (v, sign = false) => {
  const s = v < 0 ? "−" : sign && v > 0 ? "+" : "";
  const a = Math.abs(v);
  return s + (a >= 1e6 ? "$" + (a / 1e6).toFixed(2) + "M" : "$" + Math.round(a / 1e3).toLocaleString() + "k");
};
const fmt = (v, d = 1) => v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (v, d = 1) => (100 * v).toFixed(d) + "%";
const fdate = (s, y = false) => new Date(s + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", ...(y ? { year: "numeric" } : {}), timeZone: "UTC" });
const sum = (r, f) => r.reduce((s, d) => s + f(d), 0);

// ---------- chart styling (brand: black / orange / dark gray, hairline grid, square marks) ----------
Chart.defaults.font.family = "'DM Sans','Helvetica Neue',Arial,sans-serif";
Chart.defaults.font.size = 11;
Chart.defaults.color = "#505D70";
Chart.defaults.borderColor = "#E4E7EC";
Chart.defaults.animation = false;
Chart.defaults.plugins.legend.labels.boxWidth = 10;
Chart.defaults.plugins.legend.labels.boxHeight = 10;
Chart.defaults.plugins.legend.labels.color = "#000";
Chart.defaults.plugins.legend.labels.font = { weight: "600", size: 11 };
Object.assign(Chart.defaults.plugins.tooltip, { backgroundColor: "#000", cornerRadius: 0, titleFont: { weight: "700" }, padding: 9, displayColors: true, boxPadding: 3 });
Chart.defaults.elements.bar.borderRadius = 0;
Chart.defaults.elements.point.radius = 0;
Chart.defaults.elements.line.borderWidth = 2;
const charts = {};
function draw(id, cfg) { if (charts[id]) charts[id].destroy(); charts[id] = new Chart($(id), cfg); }
const axis = (title, extra = {}) => ({ grid: { color: "#E4E7EC" }, border: { color: "#000" }, title: title ? { display: true, text: title, color: "#505D70", font: { family: "'DM Sans',sans-serif", size: 10, weight: "700" } } : undefined, ...extra });
const legend = { position: "top", align: "start", labels: { usePointStyle: true, pointStyle: "rect" } };

// ---------- controls ----------
function fillSelect(el, opts, val) { el.innerHTML = opts.map(([v, t]) => `<option value="${v}"${v === val ? " selected" : ""}>${t}</option>`).join(""); }
fillSelect($("sel-price"), Object.values(F.price).map((m) => [m.id, m.id + " · " + m.name]), state.price);
fillSelect($("sel-load"), Object.values(F.load).map((m) => [m.id, m.id + " · " + m.name]), state.load);
for (const [id, key, cast] of [["sel-price", "price", String], ["sel-load", "load", String], ["sel-bound", "bound", String], ["sel-alpha", "alpha", Number]]) {
  $(id).addEventListener("change", (e) => { state[key] = cast(e.target.value); state.day = null; render(); });
}
$("gas").addEventListener("input", (e) => { state.gas = Number(e.target.value); state.day = null; render(); });
$("sel-day").addEventListener("change", (e) => { state.day = e.target.value; renderDay(last); });

let last = null;
function compute() {
  const pl = { ...C.DEFAULT_PLANT, gas: state.gas };
  const base = { alpha: state.alpha };
  const orc = C.runConfig(ctx, null, null, pl, { oracle: true });
  const runs = {};
  const run = (p, l, bound = "conformal") => (runs[p + l + bound] ??= C.runConfig(ctx, p, l, pl, { ...base, bound }));
  const champ = run("P0", "L0");
  const chal = run(state.price, state.load, state.bound);
  const g = C.gate(champ, chal, orc);
  const isChamp = state.price === "P0" && state.load === "L0" && state.bound === "conformal";
  const voi = C.forecastValueSplit(ctx, state.price, state.load, pl, { ...base, bound: state.bound });
  const rows = [
    ...Object.values(F.price).map((m) => ({ m, r: run(m.id, "L0"), acc: C.accuracy(ctx, m.id) })),
    ...Object.values(F.load).map((m) => ({ m, r: run("P0", m.id), acc: C.accuracy(ctx, m.id), cov: C.loadCoverage(ctx, m.id, state.alpha) })),
  ];
  const regret = (r) => sum(r, (d) => d.tot.total) - sum(orc, (d) => d.tot.total);
  rows.forEach((x) => { x.regret = regret(x.r); x.delta = x.regret - regret(champ); x.margin = sum(x.r, (d) => d.q) / x.r.length; });
  return { pl, orc, champ, chal, g, voi, rows, isChamp, cov: C.loadCoverage(ctx, state.load, state.alpha, state.bound), covChamp: C.loadCoverage(ctx, "L0", state.alpha) };
}

function render() {
  const t0 = performance.now();
  last = compute();
  const { champ, chal, g, voi, rows, orc, isChamp, cov, covChamp, pl } = last;
  const n = g.n, first = champ[0].date, lastD = champ[n - 1].date;
  const pm = F.price[state.price], lm = F.load[state.load];
  const boundName = state.bound === "conformal" ? "split-conformal bound" : "Gaussian bound";
  const chName = isChamp ? "Champion" : [state.price !== "P0" ? pm.name : null, state.load !== "L0" ? lm.name : null, state.bound !== "conformal" ? "Gaussian load bound" : null].filter(Boolean).join(" + ");

  $("crumb-model").textContent = isChamp ? "Champion" : `${state.price} + ${state.load}`;
  $("title").textContent = isChamp ? "Champion replay" : `${chName} vs champion`;
  $("meta").innerHTML = [`Kilby-class site (illustrative 12 × 225 MW)`, `LZ_WEST`, `Backtest ${fdate(first)} – ${fdate(lastD, true)}`, `${n} settled days`, `Decision at noon D-1`, `Marginal cost $${C.marginalCost(pl).toFixed(1)}/MWh`].map((s) => `<span>${s}</span>`).join("");
  $("gas-val").textContent = "$" + state.gas.toFixed(2);

  // verdict
  const w = $("v-word");
  w.textContent = isChamp ? "BASELINE" : g.verdict;
  w.className = "v-word " + (isChamp ? "hold" : g.verdict.toLowerCase());
  const ci = `90% interval ${money(g.ciTotal[0], true)} to ${money(g.ciTotal[1], true)}`;
  const need = C.daysToDecide(g);
  if (isChamp) {
    $("v-head").textContent = `The production plan left ${money(g.champRegret)} on the table over ${n} days versus perfect foresight.`;
    $("v-sub").textContent = "Pick a challenger above to replay it through the same plan.";
  } else {
    const verb = g.deltaTotal < 0 ? "Saves" : "Costs";
    $("v-head").textContent = `${verb} ${money(Math.abs(g.deltaTotal))} over ${n} days (${ci}).`;
    $("v-sub").textContent = g.verdict === "HOLD"
      ? (need != null ? `Within noise. Keep it in shadow mode: about ${need} more settled days separate it from the champion at this effect size.` : "Within noise.")
      : g.verdict === "PROMOTE" ? "Significantly cheaper with no loss of reliability: safe to promote."
      : g.reason === "reliability regressed" ? "Reliability regressed: blocked regardless of cost." : "Significantly more expensive than the champion: blocked.";
  }
  const relOk = g.rel.chal <= g.rel.champ + 1e-6;
  const covState = cov >= 1 - state.alpha - 0.0005 ? "ok" : cov >= 1 - state.alpha - 0.01 ? "wait" : "bad";
  const dollarsState = isChamp ? "ok" : g.ciTotal[1] < 0 ? "ok" : g.ciTotal[0] > 0 ? "bad" : "wait";
  $("checks").innerHTML = [
    [dollarsState, "Dollars", isChamp ? "baseline" : `${money(g.deltaTotal, true)} Δ regret`],
    [relOk ? "ok" : "bad", "Reliability", `${fmt(g.rel.chal, 0)} MWh unserved (champion ${fmt(g.rel.champ, 0)})`],
    [covState, "Load bound coverage", `${pct(cov)} vs ${pct(1 - state.alpha, 0)} target${covState === "wait" ? " (slightly under)" : ""}`],
    [n >= 90 ? "ok" : "wait", "Sample", `${n} days · 7-day block bootstrap`],
  ].map(([s, k, v]) => `<div class="chk"><span class="m ${s}"></span><b>${k}</b><span class="r">${v}</span></div>`).join("");

  const marg = sum(chal, (d) => d.q) / n, margC = sum(champ, (d) => d.q) / n;
  const blocks = (r) => sum(r, (d) => d.u.reduce((a, b) => a + b, 0)) / (24 * n);
  $("kpis").innerHTML = [
    ["Champion regret", money(g.champRegret), `${pct(g.champRegret / sum(orc, (d) => d.tot.total))} of perfect-foresight cost`],
    ["Challenger regret", money(g.chalRegret), isChamp ? "same as champion" : `${money(g.deltaTotal, true)} vs champion`],
    ["Annualized Δ", isChamp ? "–" : money((g.deltaTotal / n) * 365, true), "at this effect size"],
    ["Reliability margin", fmt(marg, 0) + " MW", isChamp ? "upper bound minus forecast" : `champion ${fmt(margC, 0)} MW`],
    ["Blocks online", fmt(blocks(chal), 2), isChamp ? "of 12 × 225 MW" : `champion ${fmt(blocks(champ), 2)}`],
  ].map(([k, v, s]) => `<div class="kpi"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join("");

  // table: accuracy rank vs dollar rank within each forecast type
  const rank = (arr, key) => { const s = [...arr].sort((a, b) => key(a) - key(b)); return (x) => s.indexOf(x) + 1; };
  const pr = rows.filter((x) => x.m.kind === "price"), lr = rows.filter((x) => x.m.kind === "load");
  const rMaeP = rank(pr, (x) => x.acc.mae), rUsdP = rank(pr, (x) => x.regret), rMaeL = rank(lr, (x) => x.acc.mae), rUsdL = rank(lr, (x) => x.regret);
  const rk = (v) => `<span class="rk${v === 1 ? " top" : ""}">${v}</span>`;
  $("tbl").innerHTML = `<thead><tr><th>Forecaster</th><th>Target</th><th class="n">MAE</th><th class="n">RMSE</th><th class="n">Spike-hour MAE · bound coverage</th><th class="n">Plan regret</th><th class="n">Δ vs champion</th><th class="n">Rank MAE</th><th class="n">Rank $</th></tr></thead><tbody>` +
    rows.map((x) => {
      const isP = x.m.kind === "price", sel = isP ? x.m.id === state.price : x.m.id === state.load;
      const unit = isP ? "$/MWh" : "MW";
      return `<tr class="${sel ? "sel" : ""}"><td><div class="nm">${x.m.id} · ${x.m.name}${x.m.role ? '<span class="tag ch">Champion</span>' : ""}${sel && !x.m.role ? '<span class="tag or">Selected</span>' : ""}</div><div class="ab">${x.m.about}</div></td>
      <td class="nw">${isP ? "RT price" : "Site load"}</td>
      <td class="n">${fmt(x.acc.mae, isP ? 2 : 0)}<span class="u"> ${unit}</span></td><td class="n">${fmt(x.acc.rmse, isP ? 2 : 0)}</td>
      <td class="n">${isP ? fmt(x.acc.spikeMae, 1) + " $/MWh" : pct(x.cov) + " · " + fmt(x.margin, 0) + " MW margin"}</td>
      <td class="n">${money(x.regret)}</td><td class="n">${x.m.role ? "–" : money(x.delta, true)}</td>
      <td class="n">${rk(isP ? rMaeP(x) : rMaeL(x))}</td><td class="n">${rk(isP ? rUsdP(x) : rUsdL(x))}</td></tr>`;
    }).join("") + "</tbody>";
  const spikeCut = rows[0].acc.spikeCut;
  $("tbl-note").textContent = `Price candidates are replayed with the champion load model and load candidates with the champion price model, ${pct(1 - state.alpha, 0)} split-conformal bound. Spike hours: real-time price ≥ $${fmt(spikeCut, 0)}/MWh (top 5% of the backtest).`;

  // cumulative regret
  let a = 0, b = 0;
  const cumA = champ.map((d, i) => (a += d.tot.total - orc[i].tot.total) / 1e6);
  const cumB = chal.map((d, i) => (b += d.tot.total - orc[i].tot.total) / 1e6);
  draw("c-cum", { type: "line", data: { labels: champ.map((d) => fdate(d.date)), datasets: [
    { label: "Champion (P0 + L0)", data: cumA, borderColor: "#505D70", backgroundColor: "#505D70" },
    ...(isChamp ? [] : [{ label: "Challenger", data: cumB, borderColor: "#FF611B", backgroundColor: "#FF611B" }]),
  ] }, options: { maintainAspectRatio: false, interaction: { mode: "index", intersect: false }, plugins: { legend,
    tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: $${c.parsed.y.toFixed(2)}M` } } },
    scales: { x: axis("", { ticks: { maxTicksLimit: 8, maxRotation: 0 } }), y: axis("Cumulative regret ($M)") } } });

  // regret by regime
  const rc = C.regretByRegime(champ, orc), rn = C.regretByRegime(chal, orc);
  draw("c-reg", { type: "bar", data: { labels: rc.map((r) => `${r.label}  (${r.hours.toLocaleString()} h)`), datasets: [
    { label: "Champion", data: rc.map((r) => r.regret / 1e3), backgroundColor: "#505D70", barPercentage: 0.8, categoryPercentage: 0.7 },
    ...(isChamp ? [] : [{ label: "Challenger", data: rn.map((r) => r.regret / 1e3), backgroundColor: "#FF611B", barPercentage: 0.8, categoryPercentage: 0.7 }]),
  ] }, options: { maintainAspectRatio: false, plugins: { legend, tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${money(c.parsed.y * 1e3, true)}` } } },
    scales: { x: axis("Realized real-time price", { grid: { display: false } }), y: axis("Regret ($k)") } } });

  // value of information
  const pos = Math.max(0, voi.price) + Math.max(0, voi.load);
  const pp = pos ? Math.max(0, voi.price) / pos : 0.5;
  const top = voi.price >= voi.load ? "price" : "load";
  const segL = (lab, f) => (f >= 0.12 ? `${lab} ${pct(f, 0)}` : "");
  $("voi").innerHTML = `<div class="bar"><div class="seg p" style="width:${(pp * 100).toFixed(1)}%">${segL("Price", pp)}</div><div class="seg l" style="width:${((1 - pp) * 100).toFixed(1)}%">${segL("Load", 1 - pp)}</div></div>
    <div class="barkey"><span><i class="sw p"></i>Price ${pct(pp, 0)}</span><span><i class="sw l"></i>Load ${pct(1 - pp, 0)}</span></div>
    <div class="rows"><div class="mode"><div class="k">Price forecast errors cost</div><div class="v">${money(voi.price)}</div><div class="s">${state.price} · ${pm.name} · ${money((voi.price / n) * 365)}/yr</div></div>
    <div class="mode"><div class="k">Load forecast errors cost</div><div class="v">${money(voi.load)}</div><div class="s">${state.load} · ${lm.name} · ${money((voi.load / n) * 365)}/yr</div></div></div>
    <p>A perfect ${top} forecast would recover ${money(top === "price" ? voi.total - voi.perfectPriceRegret : voi.total - voi.perfectLoadRegret)} of the ${money(voi.total)} regret on its own. That is the ceiling on what the next ${top} model can be worth to this plan.</p>`;

  // reliability margin over time
  draw("c-cov", { type: "line", data: { labels: champ.map((d) => fdate(d.date)), datasets: [
    { label: "Champion margin (L0, conformal)", data: champ.map((d) => d.q), borderColor: "#505D70", backgroundColor: "#505D70", borderWidth: 1.5, stepped: true },
    ...(isChamp ? [] : [{ label: `Challenger margin (${state.load}, ${state.bound})`, data: chal.map((d) => d.q), borderColor: "#FF611B", backgroundColor: "#FF611B", borderWidth: 1.5, stepped: true }]),
  ] }, options: { maintainAspectRatio: false, interaction: { mode: "index", intersect: false }, plugins: { legend, tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${Math.round(c.parsed.y)} MW` } } },
    scales: { x: axis("", { ticks: { maxTicksLimit: 8, maxRotation: 0 } }), y: axis("MW above forecast", { beginAtZero: true }) } } });

  // day selector (default: the day the challenger and champion differ most)
  const delta = g.delta;
  let best = 0;
  delta.forEach((v, i) => { if (Math.abs(v) > Math.abs(delta[best])) best = i; });
  if (!state.day) state.day = champ[isChamp ? champ.reduce((bi, d, i, arr) => (d.tot.total - orc[i].tot.total > arr[bi].tot.total - orc[bi].tot.total ? i : bi), 0) : best].date;
  fillSelect($("sel-day"), champ.map((d, i) => [d.date, `${fdate(d.date, true)} · Δ ${money(delta[i], true)}`]), state.day);
  renderDay(last);
  console.info(`eval gate recomputed in ${(performance.now() - t0).toFixed(0)} ms`);
}

function renderDay(L) {
  const { champ, chal, orc, pl } = L;
  const i = champ.findIndex((d) => d.date === state.day);
  const c = champ[i], x = chal[i], o = orc[i], day = days[c.k];
  const hrs = Array.from({ length: 24 }, (_, h) => "HE" + String(h + 1).padStart(2, "0"));
  const regC = c.tot.total - o.tot.total, regX = x.tot.total - o.tot.total;
  $("day-desc").textContent = `${fdate(c.date, true)}: champion regret ${money(regC)}, challenger ${money(regX)}. Peak real-time price $${fmt(Math.max(...day.rt), 0)}/MWh, peak load ${fmt(Math.max(...day.load), 0)} MW.`;
  draw("c-day-p", { type: "line", data: { labels: hrs, datasets: [
    { label: "Real-time (actual)", data: day.rt, borderColor: "#000", backgroundColor: "#000" },
    ...(state.price === "P0" ? [] : [{ label: "Day-ahead", data: day.da, borderColor: "#B7BFCC", backgroundColor: "#B7BFCC", borderDash: [4, 3] }]),
    { label: state.price === "P0" ? "Forecast (P0 = day-ahead)" : `Forecast (${state.price})`, data: x.pHat, borderColor: "#FF611B", backgroundColor: "#FF611B" },
  ] }, options: { maintainAspectRatio: false, interaction: { mode: "index", intersect: false }, plugins: { legend, tooltip: { callbacks: { label: (q) => ` ${q.dataset.label}: $${q.parsed.y.toFixed(1)}` } } },
    scales: { x: axis("", { ticks: { maxTicksLimit: 12, maxRotation: 0 } }), y: axis("LZ_WEST $/MWh") } } });
  const cap = (d) => d.u.map((u) => u * pl.pmax + pl.importCap);
  draw("c-day-u", { type: "line", data: { labels: hrs, datasets: [
    { label: "Site load (actual)", data: day.load, borderColor: "#000", backgroundColor: "#000" },
    { label: "Champion capacity", data: cap(c), borderColor: "#505D70", backgroundColor: "#505D70", stepped: true, borderWidth: 1.5 },
    { label: "Challenger capacity", data: cap(x), borderColor: "#FF611B", backgroundColor: "#FF611B", stepped: true },
    { label: "Battery (+ charge)", data: x.hours.map((h) => h.x), borderColor: "#B7BFCC", backgroundColor: "rgba(183,191,204,.45)", type: "bar", yAxisID: "y2", barPercentage: 0.9, categoryPercentage: 0.9 },
  ] }, options: { maintainAspectRatio: false, interaction: { mode: "index", intersect: false }, plugins: { legend, tooltip: { callbacks: { label: (q) => ` ${q.dataset.label}: ${Math.round(q.parsed.y)} MW` } } },
    scales: { x: axis("", { ticks: { maxTicksLimit: 12, maxRotation: 0 } }), y: axis("MW (blocks × 225 + 400 import)"), y2: axis("Battery MW", { position: "right", grid: { display: false }, min: -900, max: 900 }) } } });
}

document.fonts.ready.then(render);
