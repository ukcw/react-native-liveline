import { formatAxisValueWorklet } from "./grid";
import type { TimeFormatPreset } from "../types";
import { formatCrosshairTimeByPresetWorklet } from "./timeFormat";

// ── Multi-series crosshair ──────────────────────────────────────────

export interface MultiCrosshairEntry {
  color: string;
  label: string;
  value: number;
  valueText: string;
  y: number;
}

export interface MultiCrosshairResult {
  entries: MultiCrosshairEntry[];
  entryCount: number;
  timeText: string;
  opacity: number;
  _cachedTimeRounded: number;
}

const MAX_MULTI_CROSSHAIR_ENTRIES = 8;
const CROSSHAIR_FADE_MIN_PX = 5;

function clampValue(n: number, min: number, max: number): number {
  "worklet";
  return Math.min(max, Math.max(min, n));
}

function interpolateSeriesAtTime(
  buf: Float64Array,
  count: number,
  t: number,
): number {
  "worklet";
  if (count === 0) return 0;
  const firstT = buf[0];
  const firstV = buf[1];
  const lastT = buf[(count - 1) * 2];
  const lastV = buf[(count - 1) * 2 + 1];
  if (t <= firstT) return firstV;
  if (t >= lastT) return lastV;

  let lo = 0;
  let hi = count - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    const mt = buf[mid * 2];
    if (mt <= t) lo = mid;
    else hi = mid;
  }

  const t0 = buf[lo * 2];
  const v0 = buf[lo * 2 + 1];
  const t1 = buf[hi * 2];
  const v1 = buf[hi * 2 + 1];
  const seg = t1 - t0;
  if (seg <= 0) return v0;
  const u = (t - t0) / seg;
  return v0 + (v1 - v0) * u;
}

export function createMultiCrosshairResult(): MultiCrosshairResult {
  const entries: MultiCrosshairEntry[] = [];
  for (let i = 0; i < MAX_MULTI_CROSSHAIR_ENTRIES; i++) {
    entries.push({ color: "", label: "", value: 0, valueText: "", y: 0 });
  }
  return {
    entries,
    entryCount: 0,
    timeText: "",
    opacity: 0,
    _cachedTimeRounded: Number.NaN,
  };
}

/**
 * Compute multi-series crosshair state: for each visible series, interpolate
 * at hover time and compute Y position. Pre-allocated entries avoid per-frame
 * object allocations.
 */
export function updateMultiCrosshairState(
  hoverX: number,
  seriesBuffers: Float64Array[],
  seriesCounts: number[],
  seriesAlphas: number[],
  seriesColors: string[],
  seriesLabels: string[],
  seriesCount: number,
  start: number,
  windowSecsNow: number,
  rangeMin: number,
  rangeSpan: number,
  paddingLeft: number,
  paddingTop: number,
  innerWidth: number,
  innerHeight: number,
  liveDotX: number,
  scrubAmount: number,
  formatValueWorklet: ((v: number) => string) | undefined,
  formatTimeWorklet: ((t: number) => string) | undefined,
  formatCrosshairTimeWorklet:
    | ((tMs: number, windowSecs: number) => string)
    | undefined,
  timeFormatPreset: TimeFormatPreset | undefined,
  out: MultiCrosshairResult,
): void {
  "worklet";

  const hx = clampValue(hoverX, paddingLeft, paddingLeft + innerWidth);
  const ht = start + ((hx - paddingLeft) / innerWidth) * windowSecsNow;

  let entryIdx = 0;
  for (
    let i = 0;
    i < seriesCount && entryIdx < MAX_MULTI_CROSSHAIR_ENTRIES;
    i++
  ) {
    if (seriesAlphas[i] < 0.5) continue;
    const buf = seriesBuffers[i];
    const count = seriesCounts[i];
    if (count === 0) continue;

    const hv = interpolateSeriesAtTime(buf, count, ht);
    const hy =
      paddingTop +
      (1 - (hv - rangeMin) / Math.max(rangeSpan, 1e-6)) * innerHeight;

    const entry = out.entries[entryIdx];
    entry.color = seriesColors[i];
    entry.label = seriesLabels[i];
    entry.value = hv;
    entry.valueText = formatValueWorklet
      ? formatValueWorklet(hv)
      : formatAxisValueWorklet(hv);
    entry.y = hy;
    entryIdx++;
  }
  out.entryCount = entryIdx;

  // Cache time text
  const roundedTime = Math.round(ht);
  if (roundedTime !== out._cachedTimeRounded) {
    out._cachedTimeRounded = roundedTime;
    const tMs = ht * 1000;
    out.timeText = formatCrosshairTimeWorklet
      ? formatCrosshairTimeWorklet(tMs, windowSecsNow)
      : formatTimeWorklet
        ? formatTimeWorklet(tMs)
        : formatCrosshairTimeByPresetWorklet(tMs, windowSecsNow, timeFormatPreset);
  }

  // Opacity with live-dot fade
  const distToLive = liveDotX - hx;
  const fadeStart = Math.min(80, innerWidth * 0.3);
  const scrubOpacity =
    distToLive < CROSSHAIR_FADE_MIN_PX
      ? 0
      : distToLive >= fadeStart
        ? scrubAmount
        : ((distToLive - CROSSHAIR_FADE_MIN_PX) /
            Math.max(1e-6, fadeStart - CROSSHAIR_FADE_MIN_PX)) *
          scrubAmount;

  out.opacity = clampValue(scrubOpacity, 0, 1);
}

function ptT(buf: Float64Array, i: number): number {
  "worklet";
  return buf[i * 2];
}

function ptV(buf: Float64Array, i: number): number {
  "worklet";
  return buf[i * 2 + 1];
}

export interface CrosshairResult {
  hx: number;
  hy: number;
  ht: number;
  hv: number;
  valueText: string;
  timeText: string;
  opacity: number;
  // String cache: only re-format when the rounded value/time changes,
  // avoiding ~14 string + 1 Date allocation per frame during scrub.
  _cachedValueRounded: number;
  _cachedTimeRounded: number;
}

export function createCrosshairResult(): CrosshairResult {
  return {
    hx: 0,
    hy: 0,
    ht: 0,
    hv: 0,
    valueText: "",
    timeText: "",
    opacity: 0,
    _cachedValueRounded: Number.NaN,
    _cachedTimeRounded: Number.NaN,
  };
}

/**
 * Evaluate the Fritsch-Carlson monotone cubic spline at time `t`.
 * This matches the spline the line path uses, so the crosshair dot
 * sits exactly on the drawn curve instead of floating off it.
 */
export function interpolateAtTime(
  buf: Float64Array,
  count: number,
  t: number,
): number {
  "worklet";
  if (count === 0) return 0;
  if (t <= ptT(buf, 0)) return ptV(buf, 0);
  if (t >= ptT(buf, count - 1)) return ptV(buf, count - 1);

  // Binary search for the segment containing t
  let lo = 0;
  let hi = count - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ptT(buf, mid) <= t) lo = mid;
    else hi = mid;
  }

  const t0 = ptT(buf, lo);
  const v0 = ptV(buf, lo);
  const t1 = ptT(buf, hi);
  const v1 = ptV(buf, hi);
  const seg = t1 - t0;
  if (seg <= 0) return v0;

  // Secant slope for this segment
  const delta = (v1 - v0) / seg;

  // Secant slope for the segment to the left of lo
  let deltaL = delta;
  if (lo > 0) {
    const hL = t0 - ptT(buf, lo - 1);
    if (hL > 0) deltaL = (v0 - ptV(buf, lo - 1)) / hL;
  }

  // Secant slope for the segment to the right of hi
  let deltaR = delta;
  if (hi < count - 1) {
    const hR = ptT(buf, hi + 1) - t1;
    if (hR > 0) deltaR = (ptV(buf, hi + 1) - v1) / hR;
  }

  // Initial tangent at lo (Fritsch-Carlson: average of adjacent secants,
  // zero if they have opposite signs → preserves monotonicity)
  let m0: number;
  if (lo === 0) {
    m0 = delta;
  } else if (deltaL * delta <= 0) {
    m0 = 0;
  } else {
    m0 = (deltaL + delta) / 2;
  }

  // Initial tangent at hi
  let m1: number;
  if (hi === count - 1) {
    m1 = delta;
  } else if (delta * deltaR <= 0) {
    m1 = 0;
  } else {
    m1 = (delta + deltaR) / 2;
  }

  // Fritsch-Carlson constraint: alpha^2 + beta^2 <= 9
  if (delta === 0) {
    m0 = 0;
    m1 = 0;
  } else {
    const alpha = m0 / delta;
    const beta = m1 / delta;
    const s2 = alpha * alpha + beta * beta;
    if (s2 > 9) {
      const s = 3 / Math.sqrt(s2);
      m0 = s * alpha * delta;
      m1 = s * beta * delta;
    }
  }

  // Hermite cubic basis evaluation
  const u = (t - t0) / seg;
  const u2 = u * u;
  const u3 = u2 * u;
  return (
    (2 * u3 - 3 * u2 + 1) * v0 +
    (u3 - 2 * u2 + u) * seg * m0 +
    (-2 * u3 + 3 * u2) * v1 +
    (u3 - u2) * seg * m1
  );
}

/**
 * Compute crosshair hover state: interpolated position, formatted text,
 * and opacity with live-dot fade.  Writes into pre-allocated `out` param
 * to avoid per-frame object allocation. String formatting is cached —
 * only re-runs when the rounded value/time changes.
 */
export function updateCrosshairState(
  hoverX: number,
  buf: Float64Array,
  count: number,
  start: number,
  windowSecsNow: number,
  rangeMin: number,
  rangeSpan: number,
  paddingLeft: number,
  paddingTop: number,
  innerWidth: number,
  innerHeight: number,
  dotX: number,
  scrubAmount: number,
  formatValueWorklet: ((v: number) => string) | undefined,
  formatTimeWorklet: ((t: number) => string) | undefined,
  formatCrosshairTimeWorklet:
    | ((tMs: number, windowSecs: number) => string)
    | undefined,
  timeFormatPreset: TimeFormatPreset | undefined,
  out: CrosshairResult,
): void {
  "worklet";

  const hx = clampValue(hoverX, paddingLeft, paddingLeft + innerWidth);
  const ht = start + ((hx - paddingLeft) / innerWidth) * windowSecsNow;
  const hv = interpolateAtTime(buf, count, ht);
  const hy =
    paddingTop +
    (1 - (hv - rangeMin) / Math.max(rangeSpan, 1e-6)) * innerHeight;

  // Cache formatted strings: only re-format when rounded value/time changes.
  // This eliminates ~14 string allocations + 1 Date object per frame during scrub.
  const roundedValue = Math.round(hv * 100) / 100;
  if (roundedValue !== out._cachedValueRounded) {
    out._cachedValueRounded = roundedValue;
    out.valueText = formatValueWorklet
      ? formatValueWorklet(hv)
      : formatAxisValueWorklet(hv);
  }

  // Round time to nearest second to avoid unnecessary text churn while scrubbing.
  const roundedTime = Math.round(ht);
  if (roundedTime !== out._cachedTimeRounded) {
    out._cachedTimeRounded = roundedTime;
    const tMs = ht * 1000;
    out.timeText = formatCrosshairTimeWorklet
      ? formatCrosshairTimeWorklet(tMs, windowSecsNow)
      : formatTimeWorklet
        ? formatTimeWorklet(tMs)
        : formatCrosshairTimeByPresetWorklet(tMs, windowSecsNow, timeFormatPreset);
  }

  const distToLive = dotX - hx;
  const fadeStart = Math.min(80, innerWidth * 0.3);
  const scrubOpacity =
    distToLive < CROSSHAIR_FADE_MIN_PX
      ? 0
      : distToLive >= fadeStart
        ? scrubAmount
        : ((distToLive - CROSSHAIR_FADE_MIN_PX) /
            Math.max(1e-6, fadeStart - CROSSHAIR_FADE_MIN_PX)) *
          scrubAmount;

  out.hx = hx;
  out.hy = hy;
  out.ht = ht;
  out.hv = hv;
  out.opacity = clampValue(scrubOpacity, 0, 1);
}
