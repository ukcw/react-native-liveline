import type { SkPath } from "@shopify/react-native-skia";
import type { CandlePoint } from "../types";

// ── Constants ────────────────────────────────────────────────────────

export const BULL_R = 34;
export const BULL_G = 197;
export const BULL_B = 94;

export const BEAR_R = 239;
export const BEAR_G = 68;
export const BEAR_B = 68;

// ── Color helpers ────────────────────────────────────────────────────

export function blendBullBear(t: number): { r: number; g: number; b: number } {
  "worklet";
  const ct = t < 0 ? 0 : t > 1 ? 1 : t;
  return {
    r: Math.round(BEAR_R + (BULL_R - BEAR_R) * ct),
    g: Math.round(BEAR_G + (BULL_G - BEAR_G) * ct),
    b: Math.round(BEAR_B + (BULL_B - BEAR_B) * ct),
  };
}

export const BULL_COLOR = `rgb(${BULL_R},${BULL_G},${BULL_B})`;
export const BEAR_COLOR = `rgb(${BEAR_R},${BEAR_G},${BEAR_B})`;

// ── Candle dimensions ────────────────────────────────────────────────

export interface CandleDims {
  bodyW: number;
  wickW: number;
  radius: number;
}

export function candleDims(
  chartW: number,
  leftEdge: number,
  rightEdge: number,
  candleWidthSecs: number,
): CandleDims {
  "worklet";
  const span = rightEdge - leftEdge;
  if (span <= 0) return { bodyW: 1, wickW: 0.8, radius: 0 };
  const pxPerSec = chartW / span;
  const candlePxW = candleWidthSecs * pxPerSec;
  const bodyW = Math.max(1, candlePxW * 0.7);
  const wickW = Math.max(0.8, Math.min(2, bodyW * 0.15));
  const radius = bodyW > 6 ? 1.5 : 0;
  return { bodyW, wickW, radius };
}

// ── Rounded rect helper (Skia path) ────────────────────────────────

function addRoundedRect(
  path: SkPath,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  "worklet";
  if (r <= 0 || w < r * 2 || h < r * 2) {
    path.addRect({ x, y, width: w, height: h });
    return;
  }
  path.addRRect({
    rect: { x, y, width: w, height: h },
    rx: r,
    ry: r,
  });
}

// ── Build candle paths ──────────────────────────────────────────────

export interface CandlePathResult {
  bullBodies: SkPath;
  bearBodies: SkPath;
  bullWicks: SkPath;
  bearWicks: SkPath;
  liveGlowBody: SkPath;
  closePriceLine: SkPath;
}

/**
 * Build batched Skia paths for all visible candles.
 * Bull candles → one body path + one wick path.
 * Bear candles → one body path + one wick path.
 * Live candle glow → separate body path for blur effect.
 * Close price line → horizontal dashed line at live close.
 *
 * All paths should be rewound before calling this function.
 */
export function buildCandlePaths(
  result: CandlePathResult,
  candles: CandlePoint[],
  candleWidthSecs: number,
  chartW: number,
  chartH: number,
  paddingLeft: number,
  paddingTop: number,
  leftEdge: number,
  rightEdge: number,
  rangeMin: number,
  rangeSpan: number,
  liveTime: number,
  liveBirthAlpha: number,
  lineModeProg: number,
  chartReveal: number,
): void {
  "worklet";

  const dims = candleDims(chartW, leftEdge, rightEdge, candleWidthSecs);
  const { bodyW, wickW, radius } = dims;
  const halfBody = bodyW / 2;

  const span = rightEdge - leftEdge;
  if (span <= 0 || rangeSpan <= 0) return;

  const toX = (t: number): number => {
    return paddingLeft + ((t - leftEdge) / span) * chartW;
  };

  const toY = (v: number): number => {
    return paddingTop + (1 - (v - rangeMin) / rangeSpan) * chartH;
  };

  // OHLC collapse during line morph — candle bodies shrink toward close
  const collapseOHLC = (c: CandlePoint): CandlePoint => {
    if (lineModeProg < 0.01) return c;
    const inv = 1 - lineModeProg;
    return {
      time: c.time,
      open: c.close + (c.open - c.close) * inv,
      high: c.close + (c.high - c.close) * inv,
      low: c.close + (c.low - c.close) * inv,
      close: c.close,
    };
  };

  // OHLC collapse during reveal — smoothstep from chart reveal
  const revealCollapse = (c: CandlePoint): CandlePoint => {
    if (chartReveal >= 1) return c;
    // smoothstep ramp: start expanding OHLC after reveal 0.3
    const t =
      chartReveal <= 0.3 ? 0 : chartReveal >= 1 ? 1 : (chartReveal - 0.3) / 0.7;
    const ss = t * t * (3 - 2 * t);
    return {
      time: c.time,
      open: c.close + (c.open - c.close) * ss,
      high: c.close + (c.high - c.close) * ss,
      low: c.close + (c.low - c.close) * ss,
      close: c.close,
    };
  };

  for (let i = 0; i < candles.length; i++) {
    let c = candles[i];

    // Apply morphing transforms
    c = revealCollapse(c);
    c = collapseOHLC(c);

    const isBull = c.close >= c.open;
    const isLive = c.time === liveTime;

    // Candle center X: midpoint of candle time window
    const cx = toX(c.time + candleWidthSecs / 2);

    // Body top/bottom
    const bodyTop = toY(Math.max(c.open, c.close));
    const bodyBottom = toY(Math.min(c.open, c.close));
    const bodyH = Math.max(1, bodyBottom - bodyTop);

    // Wick top/bottom
    const wickTop = toY(c.high);
    const wickBottom = toY(c.low);

    // Select target paths
    const bodyPath = isLive
      ? result.liveGlowBody
      : isBull
        ? result.bullBodies
        : result.bearBodies;
    const wickPath = isBull ? result.bullWicks : result.bearWicks;

    // Also add live candle to its bull/bear group for normal rendering
    if (isLive) {
      const normalPath = isBull ? result.bullBodies : result.bearBodies;
      addRoundedRect(normalPath, cx - halfBody, bodyTop, bodyW, bodyH, radius);
    }

    // Draw body
    addRoundedRect(bodyPath, cx - halfBody, bodyTop, bodyW, bodyH, radius);

    // Draw wicks (as thin rectangles for Skia path batching)
    const wickHalfW = wickW / 2;

    // Upper wick
    const upperWickH = bodyTop - wickTop;
    if (upperWickH > 0.5) {
      wickPath.addRect({
        x: cx - wickHalfW,
        y: wickTop,
        width: wickW,
        height: upperWickH,
      });
    }

    // Lower wick
    const lowerWickH = wickBottom - (bodyTop + bodyH);
    if (lowerWickH > 0.5) {
      wickPath.addRect({
        x: cx - wickHalfW,
        y: bodyTop + bodyH,
        width: wickW,
        height: lowerWickH,
      });
    }
  }

  // Close price line: horizontal line at the live candle's close price
  // Find the live candle (last one with matching liveTime)
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].time === liveTime) {
      const closeY = toY(candles[i].close);
      result.closePriceLine.moveTo(paddingLeft, closeY);
      result.closePriceLine.lineTo(paddingLeft + chartW, closeY);
      break;
    }
  }
}

// ── Binary search for candle at X position ──────────────────────────

export function candleAtX(
  candles: CandlePoint[],
  hoverX: number,
  candleWidthSecs: number,
  chartW: number,
  paddingLeft: number,
  leftEdge: number,
  rightEdge: number,
): CandlePoint | null {
  "worklet";
  const span = rightEdge - leftEdge;
  if (span <= 0 || candles.length === 0) return null;

  const time = leftEdge + ((hoverX - paddingLeft) / chartW) * span;

  let lo = 0;
  let hi = candles.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const ct = candles[mid].time;
    if (ct + candleWidthSecs <= time) {
      lo = mid + 1;
    } else if (ct > time) {
      hi = mid - 1;
    } else {
      return candles[mid];
    }
  }
  return null;
}

// ── Candle range computation ────────────────────────────────────────

export interface CandleRange {
  min: number;
  max: number;
}

export function computeCandleRange(candles: CandlePoint[]): CandleRange {
  "worklet";
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].low < min) min = candles[i].low;
    if (candles[i].high > max) max = candles[i].high;
  }
  if (!isFinite(min) || !isFinite(max)) return { min: 99, max: 101 };
  const range = max - min;
  const margin = range * 0.12;
  const minRange = range * 0.1 || 0.4;
  if (range < minRange) {
    const mid = (min + max) / 2;
    return { min: mid - minRange / 2, max: mid + minRange / 2 };
  }
  return { min: min - margin, max: max + margin };
}
