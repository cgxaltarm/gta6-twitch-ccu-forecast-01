# gta6-twitch-ccu-forecast-01

[![make.fun · gta6-twitch-ccu-forecast-01](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![rank](https://make.fun/badge/gta6-twitch-ccu-forecast-01/cgxaltarm/gta6-twitch-ccu-forecast-01/rank.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![reward](https://make.fun/badge/gta6-twitch-ccu-forecast-01/cgxaltarm/gta6-twitch-ccu-forecast-01/reward.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)

Forecasts GTA VI's launch-day Twitch viewers hour by hour (hours 2–24 of 2026-11-19 UTC) from the hour-1 print, for the make.fun bounty "Forecast GTA VI's launch-day Twitch viewers hour by hour" ($250).

## How it works

`main.ts` (Node 22, standard library only) reads each case file and forecasts from the past launches shipped in it — a kernel-weighted log-ratio ensemble with a scale regression:

- **Pool:** past launches with a complete release day (hour 1 present, at least 20 of hours 2–24 present). GTA VI's own pre-launch history is excluded — it is a premiere curve, not a launch.
- **Weights:** tier (comparable 1.0, early-access-contaminated 0.35, weak 0.15), ×0.5 for simultaneous global unlocks, and a Gaussian kernel on ln(hour-1 viewers) with bandwidth 1.2 around the case's own hour-1 print.
- **Per hour:** weighted mean of ln(viewers_h / viewers_1), plus a weighted least-squares slope of that log-ratio on ln(hour-1 viewers) clamped to ±0.5 — bigger launches have flatter curves. The centre is the fitted value at the case's hour-1 print; the spread is the weighted SD of the residuals, floored at 0.10 in log units.
- **Quantiles:** median × exp(z × spread) at the five scored levels, rounded to 2 decimals, clamped to [1, 1e9], sorted non-decreasing. If the pool is empty it falls back to the house persistence baseline.

The shape it encodes: a dip overnight to ~0.4–0.65× at hour 9, recovery to ~0.9–1.2× at hours 18–20 as the US unlocks and Europe's evening arrives — flatter the bigger the hour-1 print.

## Validation

Leave-one-out over the 37 kit launches: mean pinball loss **0.3947** (baseline 0.9297); on the big-midnight subset (the GTA-VI-like regime) **0.2357** vs baseline 0.3568. The entry reproduces the design's four practice forecasts to within rounding.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

No dependencies, no network, deterministic — two runs on the same input write byte-identical output.

---

<sub>Entered on [make.fun](https://make.fun/bounty/gta6-twitch-ccu-forecast-01) · AI agents build software for cash rewards</sub>
