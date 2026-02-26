import type { SkPath } from "@shopify/react-native-skia";
import { loadingY } from "./loadingShape";

function ptT(buf: Float64Array, i: number): number {
  "worklet";
  return buf[i * 2];
}

function ptV(buf: Float64Array, i: number): number {
  "worklet";
  return buf[i * 2 + 1];
}

export interface SplineBuffer {
  xs: number[];
  ys: number[];
  h: number[];
  delta: number[];
  m: number[];
  capacity: number;
}

export function createSplineBuffer(capacity: number = 256): SplineBuffer {
  "worklet";
  return {
    xs: new Array(capacity).fill(0),
    ys: new Array(capacity).fill(0),
    h: new Array(capacity).fill(0),
    delta: new Array(capacity).fill(0),
    m: new Array(capacity).fill(0),
    capacity,
  };
}

function ensureCapacity(buf: SplineBuffer, needed: number): void {
  "worklet";
  if (needed <= buf.capacity) return;
  const cap = Math.max(needed, buf.capacity * 2);
  buf.xs = new Array(cap).fill(0);
  buf.ys = new Array(cap).fill(0);
  buf.h = new Array(cap).fill(0);
  buf.delta = new Array(cap).fill(0);
  buf.m = new Array(cap).fill(0);
  buf.capacity = cap;
}

const EPS = 1e-6;

function clamp(n: number, min: number, max: number): number {
  "worklet";
  return Math.min(max, Math.max(min, n));
}

export function buildSmoothPathFromVisiblePoints(
  path: SkPath,
  pointsBuf: Float64Array,
  pointsCount: number,
  firstVisibleIndex: number,
  lastVisibleIndex: number,
  start: number,
  span: number,
  chartWidth: number,
  chartHeight: number,
  rangeMin: number,
  rangeSpan: number,
  paddingLeft: number,
  paddingTop: number,
  liveX: number,
  liveY: number,
  chartReveal: number,
  centerY: number,
  loadingAmplitude: number,
  loadingScroll: number,
  buf: SplineBuffer,
  continuePath?: boolean,
): void {
  "worklet";
  // Caller is responsible for rewinding before calling this function.
  // (engine frame callback calls path.rewind() + modify() pattern)

  const maxIndex = pointsCount - 1;
  if (maxIndex < 0) {
    return;
  }

  const safeFirst = clamp(firstVisibleIndex, 0, maxIndex);
  const safeLast = clamp(lastVisibleIndex, -1, maxIndex);

  const visibleCount = safeFirst <= safeLast ? safeLast - safeFirst + 1 : 0;
  const totalCount = visibleCount + 1;

  const chartRight = paddingLeft + chartWidth;
  const tipX =
    chartReveal < 1 ? liveX + (chartRight - liveX) * (1 - chartReveal) : liveX;

  const morphY = (rawY: number, x: number): number => {
    "worklet";
    const clampedY = clamp(rawY, paddingTop, paddingTop + chartHeight);
    if (chartReveal >= 1) return clampedY;
    const t = clamp((x - paddingLeft) / Math.max(chartWidth, EPS), 0, 1);
    const baseY = loadingY(t, centerY, loadingAmplitude, loadingScroll);
    return baseY + (clampedY - baseY) * chartReveal;
  };

  const pointX = (logicalIndex: number): number => {
    "worklet";
    if (logicalIndex >= visibleCount) return tipX;
    const idx = safeFirst + logicalIndex;
    if (idx < 0 || idx > maxIndex) return tipX;
    return (
      paddingLeft +
      ((ptT(pointsBuf, idx) - start) / Math.max(span, EPS)) * chartWidth
    );
  };

  const pointY = (logicalIndex: number): number => {
    "worklet";
    const x = pointX(logicalIndex);
    if (logicalIndex >= visibleCount) {
      // Tip (virtual point beyond data) uses the lerped display value.
      return morphY(liveY, x);
    }
    const idx = safeFirst + logicalIndex;
    if (idx < 0 || idx > maxIndex) return morphY(liveY, x);
    // Last visible data point uses liveY (the lerped display value),
    // matching the web version. Both the last point and the tip move
    // in lockstep, so the spline never curves between a "real" last
    // point and a "lerped" tip — which would create a visible dip
    // that resolves as the lerp catches up (the "bobble").
    // The range is also computed from displayValue, so all three —
    // last point, tip, and range — move together, keeping the
    // Y-position ratio stable (no oscillation).
    if (logicalIndex === visibleCount - 1) {
      return morphY(liveY, x);
    }
    const realY =
      paddingTop +
      (1 - (ptV(pointsBuf, idx) - rangeMin) / Math.max(rangeSpan, EPS)) *
        chartHeight;
    return morphY(realY, x);
  };

  // Precompute all point positions into pre-allocated buffer
  ensureCapacity(buf, totalCount);
  const xs = buf.xs;
  const ys = buf.ys;
  for (let i = 0; i < totalCount; i += 1) {
    xs[i] = pointX(i);
    ys[i] = pointY(i);
  }

  if (totalCount === 1) {
    if (continuePath) {
      path.lineTo(paddingLeft, ys[0]);
    } else {
      path.moveTo(paddingLeft, ys[0]);
    }
    path.lineTo(paddingLeft + chartWidth, ys[0]);
    return;
  }

  if (totalCount === 2) {
    if (continuePath) {
      path.lineTo(xs[0], ys[0]);
    } else {
      path.moveTo(xs[0], ys[0]);
    }
    path.lineTo(xs[1], ys[1]);
    return;
  }

  // Three-pass Fritsch-Carlson monotone spline (matches web spline.ts)
  const n = totalCount;

  // 1. Compute secant slopes and intervals (reuse pre-allocated buffers)
  const h = buf.h;
  const delta = buf.delta;
  for (let i = 0; i < n - 1; i += 1) {
    h[i] = xs[i + 1] - xs[i];
    delta[i] = Math.abs(h[i]) < EPS ? 0 : (ys[i + 1] - ys[i]) / h[i];
  }

  // 2. Initial tangent estimates (reuse pre-allocated buffer)
  const m = buf.m;
  m[0] = delta[0];
  m[n - 1] = delta[n - 2];
  for (let i = 1; i < n - 1; i += 1) {
    if (delta[i - 1] * delta[i] <= 0) {
      m[i] = 0;
    } else {
      m[i] = (delta[i - 1] + delta[i]) / 2;
    }
  }

  // 3. Fritsch-Carlson constraint: alpha^2 + beta^2 <= 9
  for (let i = 0; i < n - 1; i += 1) {
    if (delta[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
    } else {
      const alpha = m[i] / delta[i];
      const beta = m[i + 1] / delta[i];
      const s2 = alpha * alpha + beta * beta;
      if (s2 > 9) {
        const s = 3 / Math.sqrt(s2);
        m[i] = s * alpha * delta[i];
        m[i + 1] = s * beta * delta[i];
      }
    }
  }

  // 4. Draw bezier curves
  if (continuePath) {
    path.lineTo(xs[0], ys[0]);
  } else {
    path.moveTo(xs[0], ys[0]);
  }
  for (let i = 0; i < n - 1; i += 1) {
    const hi = h[i];
    if (Math.abs(hi) < EPS) {
      path.lineTo(xs[i + 1], ys[i + 1]);
    } else {
      path.cubicTo(
        xs[i] + hi / 3,
        ys[i] + (m[i] * hi) / 3,
        xs[i + 1] - hi / 3,
        ys[i + 1] - (m[i + 1] * hi) / 3,
        xs[i + 1],
        ys[i + 1],
      );
    }
  }
}

export function buildFillFromLinePath(
  path: SkPath,
  firstX: number,
  lastX: number,
  bottomY: number,
): void {
  "worklet";
  path.lineTo(lastX, bottomY);
  path.lineTo(firstX, bottomY);
  path.close();
}
