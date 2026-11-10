#!/usr/bin/env python3
"""Fetch REAL public hourly temperature for Midland, TX (West Texas) and write data/weather_midland_2026.json.

Source: Open-Meteo Previous Runs API (free, no key). For each hour we keep
  t_obs : temperature_2m                (the analysis / nowcast for that hour, used as "what happened")
  t_fc  : temperature_2m_previous_day1  (the value forecast one day earlier, used as the day-ahead weather input)
so the forecasting models only ever see a forecast that was actually available a day ahead.

Keys are (local date, ERCOT hour-ending): HE h covers local clock hour h-1, so we read Open-Meteo hour h-1.
Stdlib only. Usage: python3 scripts/fetch_weather.py [--start 2026-01-01] [--end 2026-11-08]
"""
import argparse, json, os, urllib.request

URL = ("https://previous-runs-api.open-meteo.com/v1/forecast?latitude=31.99&longitude=-102.08"
       "&hourly=temperature_2m,temperature_2m_previous_day1&start_date={s}&end_date={e}&timezone=America%2FChicago")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2026-01-01")
    ap.add_argument("--end", default="2026-11-08")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "data", "weather_midland_2026.json"))
    a = ap.parse_args()
    with urllib.request.urlopen(URL.format(s=a.start, e=a.end), timeout=60) as r:
        d = json.load(r)
    h = d["hourly"]
    rows, seen = [], set()
    for t, obs, fc in zip(h["time"], h["temperature_2m"], h["temperature_2m_previous_day1"]):
        date, clock = t.split("T")
        he = int(clock[:2]) + 1
        if (date, he) in seen or obs is None:
            continue
        seen.add((date, he))
        rows.append([date, he, obs, fc])
    # Where the day-ahead run is missing, fall back to persistence (same hour, previous day's observation):
    # never leak the hour's own observation into the forecast.
    for i, r in enumerate(rows):
        if r[3] is None:
            r[3] = rows[i - 24][2] if i >= 24 else r[2]
    out = {
        "station": "Midland, TX grid point (31.99N, 102.08W)",
        "source": "Open-Meteo Previous Runs API (temperature_2m, temperature_2m_previous_day1)",
        "units": "degC",
        "fields": ["date", "he", "t_obs", "t_fc"],
        "rows": rows,
    }
    with open(a.out, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    missing = sum(1 for fc in h["temperature_2m_previous_day1"] if fc is None)
    print(f"wrote {len(rows)} hours ({missing} without a day-ahead value, filled by persistence) -> {a.out}")


if __name__ == "__main__":
    main()
