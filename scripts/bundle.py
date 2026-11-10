#!/usr/bin/env python3
"""Bundle the three data files into data/bundle.js (window.EI_DATA) so the static page needs no fetch()."""
import json, os
D = os.path.join(os.path.dirname(__file__), "..", "data")
out = {k: json.load(open(os.path.join(D, f))) for k, f in
       [("ercot", "ercot_lz_west_2026.json"), ("weather", "weather_midland_2026.json"), ("load", "dc_load_2026.json")]}
with open(os.path.join(D, "bundle.js"), "w") as f:
    f.write("window.EI_DATA=" + json.dumps(out, separators=(",", ":")) + ";\n")
print("wrote data/bundle.js", os.path.getsize(os.path.join(D, "bundle.js")), "bytes")
