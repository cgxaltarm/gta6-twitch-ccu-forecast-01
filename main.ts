// gta6-twitch-ccu-forecast-01 — kernel-weighted log-ratio ensemble with scale regression.
//
// Forecasts GTA VI's launch-day Twitch viewers for hours 2..24 of 2026-11-19 (UTC)
// from the hour-1 print, using the past launches shipped in each case file.
//
// Method (per case, from the comparables in that case file):
//   1. Pool: past launches with a complete release day (hour 1 present and > 0,
//      at least 20 of hours 2..24 present and > 0), excluding GTA VI's own
//      pre-launch history (it is a premiere curve, not a launch).
//   2. Weight each pool launch by tier (comparable 1.0, early-access-contaminated
//      0.35, weak 0.15, untagged 0.5), x0.5 when its unlock was simultaneous, and
//      a Gaussian kernel on ln(hour-1 viewers) with bandwidth 1.2 around the
//      case's own hour-1 print.
//   3. Per hour h: weighted mean mu of ln(viewers_h / viewers_1); weighted
//      least-squares slope beta of that log-ratio on ln(hour-1 viewers),
//      clamped to [-0.5, 0.5]; centre = mu + beta * (ln(p1) - weighted mean
//      ln(p1_o)); spread = weighted SD of the residuals around the fitted line,
//      floored at 0.10.
//   4. Quantiles q_tau(h) = p1 * exp(centre) * exp(z_tau * spread), z the
//      standard-normal quantiles (-1.645, -0.674, 0, 0.674, 1.645), rounded to
//      2 decimals, clamped to [1, 1e9], sorted non-decreasing.
// Fallback (empty pool): the house persistence baseline, median = hour-1 print
// with spread 0.15 * sqrt(h - 1) in log space.
//
// Node 22, standard library only. Deterministic: no randomness, no network,
// cases read in name order, one output file per input file.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** Standard-normal quantiles at the five scored levels (0.05, 0.25, 0.5, 0.75, 0.95). */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
/** Gaussian kernel bandwidth on ln(hour-1 viewers). */
const BANDWIDTH = 1.2;
/** Per-hour slope of the log-ratio on ln(hour-1 viewers), clamped to this range. */
const SLOPE_LIMIT = 0.5;
/** Minimum log-spread of an hour's quantiles. */
const SPREAD_FLOOR = 0.1;
/** Baseline spread (log units per square-root hour), used only as fallback. */
const BASELINE_SIGMA = 0.15;
/** Weight by tier tag parsed from a launch's unlock text. */
const TIER_WEIGHT: Record<string, number> = {
  comparable: 1.0,
  'early-access-contaminated': 0.35,
  weak: 0.15,
};
const DEFAULT_TIER_WEIGHT = 0.5;

interface HourlyPoint {
  from: string;
  viewers: number;
}

interface Comparable {
  name: string;
  day_start: string;
  unlock?: string;
  hourly: HourlyPoint[];
}

interface CaseFile {
  id?: string;
  known?: Array<{ hour: number; viewers: number }>;
  forecast?: Array<{ hour: number }>;
  comparables?: Comparable[];
}

/** One pool launch: its release-day hourly viewers keyed by hour 1..24. */
interface PoolLaunch {
  hourOne: number;
  logHourOne: number;
  tierWeight: number;
  simultaneous: boolean;
  byHour: Map<number, number>;
}

/** x rounded to 2 decimals (half up). */
const round2 = (x: number): number => Math.round(x * 100) / 100;

/** Hour index (1..24) of a point timestamp relative to the launch's day start. */
const hourOf = (dayStartMs: number, from: string): number =>
  Math.floor((Date.parse(from) - dayStartMs) / 3_600_000) + 1;

/** Tier weight for a launch, from the `Tier:` tag in its unlock text. */
const tierWeightOf = (unlock: string | undefined): number => {
  const hit = /Tier:\s*([a-z-]+)/.exec(unlock ?? '');
  if (hit === null) return DEFAULT_TIER_WEIGHT;
  return TIER_WEIGHT[hit[1]] ?? DEFAULT_TIER_WEIGHT;
};

/** True when the launch's unlock text describes a single global unlock. */
const isSimultaneous = (unlock: string | undefined): boolean => {
  const text = (unlock ?? '').toLowerCase();
  return (
    text.includes('simultaneous') ||
    text.includes('single global unlock') ||
    text.includes('single time')
  );
};

/** Build the pool of usable past launches from a case's comparables. */
const buildPool = (comparables: Comparable[]): PoolLaunch[] => {
  const pool: PoolLaunch[] = [];
  for (const comp of comparables) {
    // GTA VI's own category history is a premiere curve, not a launch: exclude it.
    if (comp.name.includes('Grand Theft Auto VI')) continue;
    const dayStartMs = Date.parse(comp.day_start);
    if (!Number.isFinite(dayStartMs)) continue;
    const byHour = new Map<number, number>();
    for (const pt of comp.hourly ?? []) {
      const h = hourOf(dayStartMs, pt.from);
      if (h >= 1 && h <= 24 && typeof pt.viewers === 'number' && pt.viewers > 0) {
        byHour.set(h, pt.viewers);
      }
    }
    const hourOne = byHour.get(1);
    if (hourOne === undefined || hourOne <= 0) continue;
    let present = 0;
    for (let h = 2; h <= 24; h++) if (byHour.has(h)) present++;
    if (present < 20) continue;
    pool.push({
      hourOne,
      logHourOne: Math.log(hourOne),
      tierWeight: tierWeightOf(comp.unlock),
      simultaneous: isSimultaneous(comp.unlock),
      byHour,
    });
  }
  return pool;
};

/** Kernel weight of one pool launch for a case whose hour-1 print is p1. */
const launchWeight = (p1: number, launch: PoolLaunch): number => {
  let w = launch.tierWeight;
  if (launch.simultaneous) w *= 0.5;
  const d = Math.log(p1) - launch.logHourOne;
  return w * Math.exp(-(d * d) / (2 * BANDWIDTH * BANDWIDTH));
};

/** The five quantiles for one hour from a centre (log-ratio) and a log-spread. */
const quantilesFrom = (p1: number, centre: number, spread: number): number[] => {
  const qs = Z.map((z) => round2(p1 * Math.exp(centre) * Math.exp(z * spread)));
  const clamped = qs.map((q) => Math.min(1e9, Math.max(1, q)));
  clamped.sort((a, b) => a - b);
  return clamped;
};

/** House persistence baseline for one hour: median = hour-1 print, widening spread. */
const baselineHour = (p1: number, h: number): number[] =>
  quantilesFrom(p1, 0, BASELINE_SIGMA * Math.sqrt(h - 1));

/** Forecast hours 2..24 for a case with hour-1 print p1 and pool `pool`. */
const forecastHours = (p1: number, pool: PoolLaunch[]): Array<{ hour: number; q: number[] }> => {
  const logP1 = Math.log(p1);
  const weights = pool.map((launch) => launchWeight(p1, launch));
  const weightSum = weights.reduce((a, b) => a + b, 0);
  if (pool.length === 0 || !(weightSum > 0)) {
    return Array.from({ length: 23 }, (_, i) => ({ hour: i + 2, q: baselineHour(p1, i + 2) }));
  }
  // Weighted mean of ln(hour-1 viewers) over the whole pool (the regression centre).
  const meanLogP1 =
    weights.reduce((sum, w, i) => sum + w * pool[i].logHourOne, 0) / weightSum;

  const rows: Array<{ hour: number; q: number[] }> = [];
  for (let h = 2; h <= 24; h++) {
    const have: number[] = [];
    for (let i = 0; i < pool.length; i++) if (pool[i].byHour.has(h)) have.push(i);
    if (have.length === 0) {
      rows.push({ hour: h, q: baselineHour(p1, h) });
      continue;
    }
    const wHour = have.map((i) => weights[i]);
    const wHourSum = wHour.reduce((a, b) => a + b, 0);
    const logRatios = have.map((i) => Math.log(pool[i].byHour.get(h)! / pool[i].hourOne));
    const logP1s = have.map((i) => pool[i].logHourOne);
    // Weighted mean log-ratio at this hour.
    const mu = logRatios.reduce((sum, y, j) => sum + wHour[j] * y, 0) / wHourSum;
    // Weighted least-squares slope of the log-ratio on ln(hour-1 viewers),
    // centred on the pool's weighted mean ln(hour-1). Clamped to +/-SLOPE_LIMIT.
    let num = 0;
    let den = 0;
    for (let j = 0; j < have.length; j++) {
      num += wHour[j] * (logP1s[j] - meanLogP1) * (logRatios[j] - mu);
      den += wHour[j] * (logP1s[j] - meanLogP1) * (logP1s[j] - meanLogP1);
    }
    const rawSlope = den > 1e-9 ? num / den : 0;
    const slope = Math.max(-SLOPE_LIMIT, Math.min(SLOPE_LIMIT, rawSlope));
    const centre = mu + slope * (logP1 - meanLogP1);
    // Weighted SD of the residuals around the fitted line, floored at SPREAD_FLOOR.
    const residuals = logRatios.map(
      (y, j) => y - (mu + slope * (logP1s[j] - meanLogP1)),
    );
    const meanResidual =
      residuals.reduce((sum, r, j) => sum + wHour[j] * r, 0) / wHourSum;
    const variance =
      residuals.reduce((sum, r, j) => sum + wHour[j] * (r - meanResidual) * (r - meanResidual), 0) /
      wHourSum;
    const spread = Math.max(SPREAD_FLOOR, Math.sqrt(Math.max(0, variance)));
    rows.push({ hour: h, q: quantilesFrom(p1, centre, spread) });
  }
  return rows;
};

/** Forecast one parsed case; on any bad input, fall back to the persistence
 *  baseline around the hour-1 print (or 1) so the run still emits a valid file
 *  instead of crashing the whole run. */
const forecastCase = (c: CaseFile): Array<{ hour: number; q: number[] }> => {
  const first = (c.known ?? []).find((k) => k.hour === 1);
  const p1 = Math.max(1, first !== undefined && Number.isFinite(first.viewers) ? first.viewers : 1);
  const pool = buildPool(c.comparables ?? []);
  return forecastHours(p1, pool);
};

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  let hours: Array<{ hour: number; q: number[] }>;
  try {
    const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as CaseFile;
    hours = forecastCase(c);
  } catch {
    // Unparseable case file: persistence baseline around 1 still scores as a
    // valid case instead of an invalid one.
    hours = Array.from({ length: 23 }, (_, i) => ({ hour: i + 2, q: baselineHour(1, i + 2) }));
  }
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ hours })}\n`);
}
