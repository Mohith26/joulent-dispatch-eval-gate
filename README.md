# Eval Gate for Joulent Energy Intelligence (concept demo)

**Live demo:** https://mohith26.github.io/joulent-dispatch-eval-gate/

An eval gate that decides whether a new price or load forecaster should replace the production one by replaying it
through the plant's actual day-ahead plan (battery schedule, turbine commitment, settlement at real-time prices) and
asking two questions: does it lose less money than the champion, and does it keep the campus served? MAE is reported
next to it, but it does not get the vote.

Unofficial concept demo by Mohith Gajjela. Not affiliated with Joulent. Prices are real ERCOT data and weather is real
Open-Meteo data; the campus load and plant parameters are synthetic and illustrative.

## Why

Joulent's Energy Intelligence team builds load- and market-facing forecasts, and its own job post says back-tests and
evals are first-class, "with P&L and reliability on the line", and that the platform sets "the eval gates that decide
which models and agents ship". For a co-located plant serving a campus across the meter, a forecast's value is not its
error: an hour where real-time prices spike and the plan has too few turbine blocks online costs far more than many
small misses at $20/MWh, and an over-wide load bound costs no-load fuel every hour it holds extra blocks online. This
demo makes that trade-off measurable and turns it into a promote / hold / block decision with error bars.

## What it does

For each operating day from Mar 23 to Nov 7, 2026 (230 days):

1. **Forecast at noon on D-1**, after the ERCOT day-ahead market clears, using only data available then
   (telemetry and real-time prices through HE11 of D-1, the cleared day-ahead prices for D, the one-day-ahead weather
   forecast). A unit test mutates every future value and checks that no forecast changes.
   * Price candidates: `P0` the cleared LZ_WEST day-ahead price (champion), `P1` ridge on the DA-to-RT spread,
     `P2` the same features fit on asinh(spread/20).
   * Load candidates: `L0` last observed same hour (champion), `L1` ridge with telemetry, persistence and a
     cooling-degree weather forecast.
2. **Uncertainty from the model's own track record.** The previous 21 settled days of each model's out-of-sample
   errors become 21 joint (price, load) scenarios per hour, and a split-conformal upper bound on load (finite-sample
   `ceil((n+1)(1-a))` order statistic over 504 pooled residuals). A Gaussian bound is available for comparison.
3. **Plan.** A battery DP (300 MW / 1,200 MWh, 87% round trip, $4/MWh wear) schedules 24 h of charge/discharge on the
   price forecast. A unit-commitment DP picks how many of 12 x 225 MW blocks to run each hour: start costs, no-load
   costs, scenario-expected dispatch cost, and a reliability floor (blocks + 400 MW import must cover the load bound).
4. **Settle against what happened**: real LZ_WEST real-time prices and the realized campus load. If the site would be
   short, settlement cancels battery charging and then discharges before counting unserved load ($10,000/MWh).
5. **Regret** = settled cost minus the cost of the same decision process with perfect foresight.
6. **Gate.** Daily regret differences (challenger minus champion), 7-day moving-block bootstrap (2,000 resamples) for
   a 90% interval. BLOCK on any reliability regression or a significantly higher cost; PROMOTE only when significantly
   cheaper; otherwise HOLD, with an estimate of how many more settled days would separate the two.
7. **Which forecast to improve next.** A two-player Shapley split of regret between the price and load forecasts
   (swap each for perfect foresight), i.e. the value of information of each input for this plan.

## Results on the default settings (gas $2.50/MMBtu, 99% reliability target)

`node scripts/report.mjs` prints these from the same code the page runs:

| Candidate | MAE | Plan regret (230 d) | vs champion (90% CI) | Gate |
|---|---|---|---|---|
| P0 + L0 (champion) | 11.79 $/MWh, 85 MW | $3.61M | | |
| P1 ridge spread | 13.02 $/MWh | $4.00M | +$393k (+$104k to +$624k) | BLOCK |
| P2 ridge asinh | 12.68 $/MWh | $3.69M | +$82k (-$109k to +$301k) | HOLD |
| L1 ridge + weather | 66 MW | $3.09M | -$514k (-$1.01M to +$75k) | HOLD, ~28 more days |

* The cleared day-ahead price is a hard baseline for the real-time price at this node: neither learned spread model
  beat it on MAE or on dollars, and the gate blocks the dollar-loss ridge.
* The weather-aware load model cuts the reliability margin from 493 MW to 171 MW at about the same coverage
  (98.4% vs 98.6% of hours under the bound) and saves $514k, but the interval still touches zero, so the gate says keep
  it in shadow mode for roughly four more weeks.
* With L1 in place, 96% of the remaining regret ($2.98M of $3.09M) traces to price forecast error; a perfect price
  forecast would recover $2.92M. Under L0 the split is 69% / 31%.
* The reliability margin does double duty: the extra blocks it keeps online also capture real-time price spikes that
  the day-ahead price under-forecasts (spike-hour bias -$51/MWh). That is why the Gaussian bound, which holds less
  margin (305 MW vs 493 MW), still costs $219k more here.
* Split conformal slightly under-covers its 99% target (98.4-98.6%): load events break exchangeability. An adaptive
  conformal update would be the next step; the page shows coverage as a gate check rather than hiding it.

## Run it

Static page, no build step: open `index.html` (it loads `data/bundle.js` and runs the backtest in the browser in about
0.3 s; every control re-runs all 230 days).

```
node --test tests/core.test.mjs   # 10 tests
node scripts/report.mjs           # headline numbers
python3 scripts/fetch_ercot.py    # re-download ERCOT LZ_WEST DAM/RTM prices (public MIS reports 13060/13061/13091)
python3 scripts/fetch_weather.py  # re-download Open-Meteo observed + one-day-ahead temperature, Midland TX
python3 scripts/gen_load.py       # regenerate the synthetic campus load (seeded)
python3 scripts/bundle.py         # rebuild data/bundle.js
```

Tests cover ridge recovery, conformal order statistics and coverage, the normal quantile, battery DP limits and
end-of-day state of charge, dispatch logic, the commitment floor, the settlement override, no look-ahead, oracle
self-consistency, Shapley additivity, regime attribution summing to the total, and deterministic bootstrap intervals.

## Data

* `data/ercot_lz_west_2026.json`: real hourly ERCOT LZ_WEST day-ahead and real-time (mean of 15-minute) settlement
  point prices, Jan 1 to Nov 7, 2026, from ERCOT's public MIS archives.
* `data/weather_midland_2026.json`: real hourly 2 m temperature for Midland, TX from the Open-Meteo Previous Runs API:
  the observed value and the value forecast one day earlier (the forecast is what the models see).
* `data/dc_load_2026.json`: **synthetic** AI-campus load (1.1 to 2.3 GW) driven by the real observed temperature:
  IT halls energized in steps, AR(1) utilization, an inference diurnal swing, unannounced fleet-wide dips and monthly
  planned maintenance, plus a temperature-dependent cooling load.

## Honest limitations

* Plant parameters (block size, heat rate, no-load and start costs, import/export limits, battery size) are
  illustrative, sized to a ~2.7 GW co-located facility; they are not Joulent's. Gas is a flat assumption (slider).
* Price-taker settlement at the load-zone price; no ancillary services, no intraday re-optimization, no min-up/down
  times or ramp limits, and the battery plan is fixed day-ahead apart from the reliability override.
* In this dataset no candidate ever leaves load unserved (blocks, import and the battery override always cover it), so
  the reliability check is wired in and unit-tested but not exercised by the backtest.
* The forecasters are deliberately simple. The point is the gate, which accepts any model that emits 24 hourly
  values per day.
* Regret is measured against the same heuristic decision process with perfect inputs, so a few days and price regimes
  show negative regret; totals are what the gate uses.

## Novelty note

Decision-focused learning and regret-based evaluation of forecasts are established in the research literature (for
example arXiv:2305.00362 on price prediction for storage arbitrage, and several 2025-2026 PV-battery papers). Joulent
has no public product or documentation describing a forecast promotion gate, and I did not find an energy forecasting
product that promotes models on plant-level regret with a block-bootstrap decision, conformal reliability floor and a
price/load value-of-information split. This is a concept for how such a gate could look inside Joulent's own
Energy Intelligence tooling; the UI follows Joulent's published brand (the Energy Intelligence careers page) because
no Joulent application is public.

## Layout

`src/core.js` (all algorithms, no dependencies) · `src/app.js` (UI) · `assets/app.css` (Joulent brand tokens) ·
`tests/core.test.mjs` · `scripts/` (data fetchers, generator, report) · `data/`.

MIT License.
