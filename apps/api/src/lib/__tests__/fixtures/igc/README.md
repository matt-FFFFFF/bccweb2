# IGC fixtures

- `d3p.igc` — clean 3-turnpoint XC flight copied from upstream `igc-xc-score/test/d3p.igc`. Expected: parses cleanly, valid OD score path.
- `hiking-up.igc` — non-flight GPS trace copied from upstream `igc-xc-score/test/hiking-up.igc`. Expected: low-distance / non-flight behavior.
- `corrupted.igc` — truncated garbage file beginning with `AXXXBROK`. Expected: parse error or zero fixes / errors.
- `gps-spike.igc` — derived from `d3p.igc` with one latitude shifted to create an adjacent-fix speed spike > 400 km/h. Expected: `GPS_SPIKE` flag.
- `non-monotonic.igc` — derived from `d3p.igc` with two adjacent B-records swapped so timestamps go backwards once. Expected: `NON_MONOTONIC_TIMESTAMPS` flag.

Upstream mapping:

- `d3p.igc` -> `node_modules/igc-xc-score/test/d3p.igc`
- `hiking-up.igc` -> `node_modules/igc-xc-score/test/hiking-up.igc`

Generated once and committed as static test data; not produced at test runtime.
