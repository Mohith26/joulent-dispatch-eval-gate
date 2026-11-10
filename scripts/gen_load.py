#!/usr/bin/env python3
"""Generate the SYNTHETIC data-center load used by the demo: data/dc_load_2026.json (seeded, deterministic).

No real campus telemetry is public, so the AI-campus load is simulated from first principles and driven by
the REAL observed West Texas temperature (data/weather_midland_2026.json):

  load = IT(t) * (1 + cooling(T_obs))
  IT(t) = installed IT capacity (steps up as halls are energized)
          * utilization (AR(1) around ~0.92, small diurnal inference swing, weekly lull)
          * event multiplier (unannounced fleet-wide checkpoint/restart dips, planned maintenance windows)
  cooling(T) = 0.07 + 0.0062 * max(0, T - 12C)  (PUE ~1.07 in winter to ~1.25 on 40C afternoons)

Stdlib only. Usage: python3 scripts/gen_load.py [--seed 20261110]
"""
import argparse, datetime as dt, json, math, os, random

HERE = os.path.dirname(__file__)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=20261110)
    ap.add_argument("--out", default=os.path.join(HERE, "..", "data", "dc_load_2026.json"))
    a = ap.parse_args()
    rng = random.Random(a.seed)
    wx = json.load(open(os.path.join(HERE, "..", "data", "weather_midland_2026.json")))["rows"]

    # Installed IT capacity steps (MW): halls energized during the year (dates are part of the synthetic scenario).
    # Sized so the campus uses most of a ~2.7 GW dedicated plant, as a 2.67 GW co-located facility implies.
    steps = [("2026-01-01", 1720.0), ("2026-04-14", 1800.0), ("2026-07-07", 1880.0), ("2026-09-22", 1940.0)]

    def it_cap(date):
        cap = steps[0][1]
        for d0, c in steps:
            if date >= d0:
                cap = c
        return cap

    days = sorted({r[0] for r in wx})
    # Unannounced events: fleet-wide checkpoint/restart or job-mix dips (~3.5 per 30 days), depth 10-35%, 1-6 h.
    events = {}
    for d in days:
        if rng.random() < 3.5 / 30:
            start = rng.randint(1, 24)
            dur = rng.randint(1, 6)
            depth = rng.uniform(0.10, 0.35)
            for k in range(dur):
                idx = days.index(d) * 24 + (start - 1) + k
                events[idx] = max(events.get(idx, 0.0), depth)
    # Planned maintenance: second Tuesday of each month, HE 9-16, 12% of IT offline.
    planned = set()
    for d in days:
        y, m, dd = map(int, d.split("-"))
        wd = dt.date(y, m, dd).weekday()
        if wd == 1 and 8 <= dd <= 14:
            for he in range(9, 17):
                planned.add((d, he))

    rows, u = [], 0.0
    for i, (d, he, t_obs, _t_fc) in enumerate(wx):
        y, m, dd = map(int, d.split("-"))
        wd = dt.date(y, m, dd).weekday()
        u = 0.85 * u + rng.gauss(0, 0.012)               # AR(1) utilization noise
        util = 0.92 + u
        util += 0.025 * math.sin(2 * math.pi * (he - 9) / 24)  # inference traffic peaks mid-afternoon
        if wd >= 5:
            util -= 0.015
        util = min(util, 0.995)
        mult = 1.0 - events.get(i, 0.0)
        if (d, he) in planned:
            mult *= 0.88
        it = it_cap(d) * util * mult
        cool = 0.07 + 0.0062 * max(0.0, t_obs - 12.0)
        rows.append([d, he, round(it * (1 + cool), 1)])

    out = {
        "synthetic": True,
        "seed": a.seed,
        "description": "Simulated AI-campus load (MW) at the plant bus, driven by real observed Midland TX temperature.",
        "it_capacity_steps": steps,
        "n_unannounced_event_hours": len(events),
        "n_planned_maintenance_hours": len(planned),
        "fields": ["date", "he", "load_mw"],
        "rows": rows,
    }
    with open(a.out, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    loads = [r[2] for r in rows]
    print(f"wrote {len(rows)} hours, load min {min(loads):.0f} mean {sum(loads)/len(loads):.0f} max {max(loads):.0f} MW,"
          f" {len(events)} event hours -> {a.out}")


if __name__ == "__main__":
    main()
