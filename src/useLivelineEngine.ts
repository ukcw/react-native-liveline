import { useMemo } from "react";
import { Skia, usePathValue } from "@shopify/react-native-skia";
import {
  useAnimatedReaction,
  useDerivedValue,
  useFrameCallback,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";

import type {
  CandlePoint,
  DataTransitionMode,
  DegenOptions,
  HoverPoint,
  LivelinePoint,
  LivelineSeries,
  Momentum,
  OrderbookData,
  Padding,
  ReferenceLine,
  TimeFormatPreset,
  ValueDisplayMode,
} from "./types";
import {
  createGridResult,
  createGridScratch,
  createGridSlots,
  fadeOutGridSlots,
  formatAxisValueWorklet,
  updateGridSlots,
} from "./draw/grid";
import {
  createTimeScratch,
  createTimeSlots,
  updateTimeSlots,
} from "./draw/timeAxis";
import {
  createCrosshairResult,
  createMultiCrosshairResult,
  interpolateAtTime,
  updateCrosshairState,
  updateMultiCrosshairState,
} from "./draw/crosshair";
import {
  BADGE_LINE_H,
  BADGE_PAD_X,
  BADGE_PAD_Y,
  BADGE_TAIL_LEN,
  BADGE_TAIL_SPREAD,
  createBadgePath,
} from "./draw/badge";
import {
  LOADING_AMPLITUDE_RATIO,
  LOADING_SCROLL_SPEED,
  loadingBreath,
  loadingY,
} from "./draw/loadingShape";
import {
  createOrderbookLabelSlots,
  createOrderbookState,
  updateOrderbookLabels,
} from "./draw/orderbook";
import {
  createParticleSlots,
  createParticleState,
  updateParticlesAndShake,
} from "./draw/particles";
import {
  buildFillFromLinePath,
  buildSmoothPathFromVisiblePoints,
  createSplineBuffer,
} from "./draw/line";
import {
  buildCandlePaths,
  candleAtX,
  computeCandleRange,
  type CandlePathResult,
  type CandleRange,
} from "./draw/candlestick";
import { formatCrosshairTimeByPresetWorklet } from "./draw/timeFormat";

export { MAX_GRID_LABELS } from "./draw/grid";
export { MAX_TIME_LABELS } from "./draw/timeAxis";

const WINDOW_BUFFER = 0.05;
const ARROW_BUFFER_PX = 37;
const MOMENTUM_COLOR_LERP = 0.12;
const VALUE_SNAP_THRESHOLD = 0.001;
const BADGE_WIDTH_LERP = 0.15;
const BADGE_Y_LERP = 0.35;
const BADGE_Y_LERP_TRANSITIONING = 0.5;
const CHART_REVEAL_SPEED = 0.14;
const LOADING_ALPHA_SPEED = 0.14;
const PAUSE_PROGRESS_SPEED = 0.12;
const PAUSE_CATCHUP_SPEED = 0.08;
const PAUSE_CATCHUP_SPEED_FAST = 0.22;
const PULSE_INTERVAL_MS = 1500;
const PULSE_DURATION_MS = 900;
const SCRUB_LERP_SPEED = 0.12;
const HOVER_EMIT_VALUE_EPS = 1e-6;
const HOVER_EMIT_TIME_EPS = 1e-6;
const HOVER_EMIT_HX_EPS = 0.5;
const CHANGE_VALUE_EPS = 1e-6;
const INVALID_CHANGE_PCT = -1;
const MOMENTUM_DECAY_PER_MS = 0.994;
const MOMENTUM_STOP_THRESHOLD = 0.00005;
const SNAP_BACK_THRESHOLD_SECS = 0.5;
const EMPTY_ORDERBOOK: OrderbookData = { bids: [], asks: [] };

// Multi-series constants
const MAX_SERIES = 8;
const SERIES_TOGGLE_SPEED = 0.1;

// Candle mode constants (matches web)
const CANDLE_LERP_SPEED = 0.25;
const LINE_MORPH_MS = 500;
const CLOSE_LINE_LERP_SPEED = 0.25;
const CANDLE_BUFFER = 0.05;
const CANDLE_RANGE_LERP_SPEED = 0.15;
const CANDLE_RANGE_ADAPTIVE_BOOST = 0.2;
const CANDLE_WIDTH_TRANS_MS = 300;
const DEFAULT_DATA_TRANSITION_DURATION_MS = 420;
const DATA_TRANSITION_STEP_RATIO_TRIGGER = 1.8;
const DATA_TRANSITION_COUNT_RATIO_TRIGGER = 1.75;
const DATA_TRANSITION_LOADING_SPLIT = 0.85;
const MULTI_SERIES_LABEL_GAP_PX = 2;

function ptT(buf: Float64Array, i: number): number {
  "worklet";
  return buf[i * 2];
}

function ptV(buf: Float64Array, i: number): number {
  "worklet";
  return buf[i * 2 + 1];
}

function estimateStepSecs(buf: Float64Array, count: number): number {
  "worklet";
  if (count < 2) return 0;
  for (let i = count - 1; i >= 1; i -= 1) {
    const dt = ptT(buf, i) - ptT(buf, i - 1);
    if (dt > 0) return dt;
  }
  return 0;
}

interface PackedPoints {
  buf: Float64Array;
  count: number;
}

interface EngineInput {
  data: LivelinePoint[];
  value: number;
  windowSecs: number;
  targetWindowSecs: number;
  layoutWidth: number;
  layoutHeight: number;
  padding: Required<Padding>;
  showMomentum: boolean;
  showGrid: boolean;
  showBadge: boolean;
  badgeTail: boolean;
  showFill: boolean;
  showPulse: boolean;
  showLoadingState: boolean;
  paused: boolean;
  exaggerate: boolean;
  lerpSpeed: number;
  momentumOverride?: Momentum;
  referenceLine?: ReferenceLine;
  orderbook?: OrderbookData;
  degenOptions?: DegenOptions;
  formatValueWorklet?: (v: number) => string;
  // Legacy formatter used for both time surfaces.
  formatTimeWorklet?: (t: number) => string;
  timeFormatPreset?: TimeFormatPreset;
  axisTimeFormatPreset?: TimeFormatPreset;
  crosshairTimeFormatPreset?: TimeFormatPreset;
  formatAxisTimeWorklet?: (
    tMs: number,
    windowSecs: number,
    intervalSecs: number,
  ) => string;
  formatCrosshairTimeWorklet?: (tMs: number, windowSecs: number) => string;
  valueDisplayMode?: ValueDisplayMode;
  dataTransition?: DataTransitionMode;
  dataTransitionDurationMs?: number;
  dataTransitionKey?: number;
  valueMomentumColor?: boolean;
  onHoverWorklet?: (point: HoverPoint | null) => void;
  badgeCharWidth?: number;
  axisCharWidth?: number;
  seriesLabelCharWidth?: number;
  referenceLabelWidth?: number;
  scrub?: boolean;
  domainOffsetSV?: SharedValue<number>;
  panVelocitySV?: SharedValue<number>;
  isLiveSV?: SharedValue<number>;
  gestureWindowSecsSV?: SharedValue<number>;
  // Candle mode
  mode?: "line" | "candle";
  candles?: CandlePoint[];
  candleWidth?: number;
  liveCandle?: CandlePoint;
  lineMode?: boolean;
  lineData?: LivelinePoint[];
  lineValue?: number;
  // Multi-series mode
  series?: LivelineSeries[];
  isMultiSeries?: boolean;
  hiddenSeriesIds?: Set<string>;
}

function clamp(n: number, min: number, max: number): number {
  "worklet";
  return Math.min(max, Math.max(min, n));
}

function alphaLerp(
  from: number,
  to: number,
  speed: number,
  dtRatio: number,
): number {
  "worklet";
  const alpha = 1 - Math.pow(1 - speed, dtRatio);
  return from + (to - from) * clamp(alpha, 0, 1);
}

function isLineDataTransitionModeEnabled(mode: DataTransitionMode): boolean {
  "worklet";
  return mode === "loadingBridge";
}

function resolveWindowBuffer(
  chartWidth: number,
  needsArrowRoom: boolean,
): number {
  "worklet";
  if (!needsArrowRoom) return WINDOW_BUFFER;
  return Math.max(WINDOW_BUFFER, ARROW_BUFFER_PX / Math.max(chartWidth, 1));
}

function detectMomentumFromPoints(
  buf: Float64Array,
  count: number,
  lookback = 20,
): Momentum {
  "worklet";
  if (count < 5) return "flat";

  const start = Math.max(0, count - lookback);

  // Range of the full lookback for threshold calculation
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = start; i < count; i += 1) {
    const v = ptV(buf, i);
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min;
  if (range === 0) return "flat";

  // Only look at the last 5 points for active velocity
  const tailStart = Math.max(start, count - 5);
  const first = ptV(buf, tailStart);
  const last = ptV(buf, count - 1);
  const delta = last - first;

  const threshold = range * 0.12;

  if (delta > threshold) return "up";
  if (delta < -threshold) return "down";
  return "flat";
}

function findFirstPointIndexAtOrAfter(
  buf: Float64Array,
  count: number,
  t: number,
): number {
  "worklet";
  if (count === 0) return 0;
  let lo = 0;
  let hi = count - 1;
  let ans = count;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ptT(buf, mid) >= t) {
      ans = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return ans === count ? count - 1 : ans;
}

function findLastPointIndexAtOrBefore(
  buf: Float64Array,
  count: number,
  t: number,
): number {
  "worklet";
  if (count === 0) return -1;
  let lo = 0;
  let hi = count - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ptT(buf, mid) <= t) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

function clampIndex(n: number, min: number, max: number): number {
  "worklet";
  return Math.min(max, Math.max(min, n));
}

interface RangeResult {
  min: number;
  max: number;
}

function computeRangeFromVisible(
  out: RangeResult,
  buf: Float64Array,
  count: number,
  firstVisibleIndex: number,
  lastVisibleIndex: number,
  currentValue: number,
  referenceValue: number,
  exaggerate: boolean,
): void {
  "worklet";
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  const safeEnd = Math.min(lastVisibleIndex, count - 1);
  for (let i = firstVisibleIndex; i <= safeEnd; i += 1) {
    const v = ptV(buf, i);
    if (v < min) min = v;
    if (v > max) max = v;
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = currentValue - 0.5;
    max = currentValue + 0.5;
  }

  if (currentValue < min) min = currentValue;
  if (currentValue > max) max = currentValue;

  if (Number.isFinite(referenceValue)) {
    if (referenceValue < min) min = referenceValue;
    if (referenceValue > max) max = referenceValue;
  }

  const rawRange = max - min;
  const marginFactor = exaggerate ? 0.01 : 0.12;
  // Use Math.max (not ||) so the minimum range floor always applies.
  // The || version only activates the floor when rawRange is exactly 0,
  // creating a cliff: flat data → span 0.4; first tiny tick → span 0.006.
  // That 65× target jump causes visible wobble as the range lerps inward.
  const minRange = Math.max(
    rawRange * (exaggerate ? 0.02 : 0.1),
    exaggerate ? 0.04 : 0.4,
  );

  if (rawRange < minRange) {
    const mid = (min + max) / 2;
    out.min = mid - minRange / 2;
    out.max = mid + minRange / 2;
  } else {
    out.min = min - rawRange * marginFactor;
    out.max = max + rawRange * marginFactor;
  }
}

function estimateTextWidthMonospace(text: string, charWidth = 6.8): number {
  "worklet";
  return text.length * charWidth;
}

function formatWorkletValue(
  formatValueWorklet: ((v: number) => string) | undefined,
  v: number,
): string {
  "worklet";
  if (formatValueWorklet) {
    return formatValueWorklet(v);
  }
  return formatAxisValueWorklet(v);
}

function formatPercentWorklet(v: number): string {
  "worklet";
  const rounded = Math.round(Math.abs(v) * 100) / 100;
  let text = rounded.toFixed(2);
  if (text.endsWith("00")) {
    text = text.slice(0, -3);
  } else if (text.endsWith("0")) {
    text = text.slice(0, -1);
  }
  return `${text}%`;
}

function packPoints(data: LivelinePoint[]): PackedPoints {
  const clean: { t: number; v: number }[] = [];
  for (let i = 0; i < data.length; i += 1) {
    const t = data[i]?.time;
    const v = data[i]?.value;
    if (!Number.isFinite(t) || !Number.isFinite(v)) continue;
    clean.push({ t, v });
  }

  clean.sort((a, b) => a.t - b.t);

  // Keep dense but bounded history in memory.
  const capped = clean.length > 1200 ? clean.slice(clean.length - 1200) : clean;

  const buf = new Float64Array(capped.length * 2);
  for (let i = 0; i < capped.length; i += 1) {
    buf[i * 2] = capped[i].t;
    buf[i * 2 + 1] = capped[i].v;
  }
  return { buf, count: capped.length };
}

export function useLivelineEngine(input: EngineInput) {
  const {
    data,
    value,
    windowSecs,
    targetWindowSecs,
    layoutWidth,
    layoutHeight,
    padding,
    showMomentum,
    showGrid,
    showBadge,
    badgeTail,
    showFill,
    showPulse,
    showLoadingState,
    paused,
    exaggerate,
    lerpSpeed,
    momentumOverride,
    referenceLine,
    orderbook,
    degenOptions,
    formatValueWorklet,
    formatTimeWorklet,
    timeFormatPreset,
    axisTimeFormatPreset,
    crosshairTimeFormatPreset,
    formatAxisTimeWorklet,
    formatCrosshairTimeWorklet,
    valueDisplayMode = "latest",
    dataTransition = "none",
    dataTransitionDurationMs = DEFAULT_DATA_TRANSITION_DURATION_MS,
    dataTransitionKey = 0,
    valueMomentumColor = false,
    onHoverWorklet,
    badgeCharWidth = 6.8,
    axisCharWidth = 6.2,
    seriesLabelCharWidth = 5.8,
    referenceLabelWidth = 0,
    scrub = true,
    domainOffsetSV: domainOffsetSVInput,
    panVelocitySV: panVelocitySVInput,
    isLiveSV: isLiveSVInput,
    gestureWindowSecsSV: gestureWindowSecsSVInput,
    mode: chartMode = "line",
    candles: candlesInput,
    candleWidth: candleWidthInput,
    liveCandle: liveCandleInput,
    lineMode: lineModeInput = false,
    lineData: lineDataInput,
    lineValue: lineValueInput,
    series: seriesInput,
    isMultiSeries: isMultiSeriesInput = false,
    hiddenSeriesIds: hiddenSeriesIdsInput,
  } = input;

  const resolvedTimeFormatPreset: TimeFormatPreset = timeFormatPreset ?? "auto";
  const resolvedAxisTimeFormatPreset: TimeFormatPreset =
    axisTimeFormatPreset ?? resolvedTimeFormatPreset;
  const resolvedCrosshairTimeFormatPreset: TimeFormatPreset =
    crosshairTimeFormatPreset ?? resolvedTimeFormatPreset;

  const hasOnHoverWorklet = typeof onHoverWorklet === "function";

  // Memo justified: packPoints sorts + allocates, and `value` changes
  // every tick while `data` reference is stable between new data batches.
  // Returns a packed Float64Array [t0,v0,t1,v1,...] — Reanimated transfers
  // Float64Array via its ArrayBuffer fast path (1 buffer copy, zero object
  // allocations on UI thread), eliminating the GC jitter from 1200 {t,v} clones.
  const packed = useMemo(() => packPoints(data), [data]);
  const hasInputData = packed.count > 0;

  // Pack data + live value into a single Float64Array so they transfer
  // atomically to the UI thread via one useDerivedValue. This matches the
  // web version where cfg.data and cfg.value are read from a single
  // configRef snapshot in the same rAF callback. Without atomic transfer,
  // liveValueSV can update one frame before pointsBufSV, causing the lerp
  // target to flip while visible points still reflect old data — a
  // discrete reversal that the eye catches as a "bobble".
  //
  // Layout: [t0, v0, t1, v1, ..., tN, vN, liveValue]
  // The live value is appended as the last element (odd index).
  // pointsCount still reflects the number of (t,v) pairs.
  const packedWithValue = useMemo(() => {
    const buf = new Float64Array(packed.buf.length + 1);
    buf.set(packed.buf);
    buf[packed.buf.length] = value;
    return buf;
  }, [packed, value]);
  const pointsBufSV = useDerivedValue(() => packedWithValue, [packedWithValue]);
  // Count is derived from buffer length on the UI thread (not a separate
  // shared value) so it's always in sync with the buffer contents.
  // Buffer layout: [t0,v0, ..., tN,vN, liveValue] → count = (len - 1) / 2
  const windowSecsSV = useDerivedValue(() => windowSecs, [windowSecs]);
  const targetWindowSecsSV = useDerivedValue(
    () => targetWindowSecs,
    [targetWindowSecs],
  );
  const dataTransitionModeSV = useDerivedValue(
    () => dataTransition,
    [dataTransition],
  );
  const dataTransitionDurationMsSV = useDerivedValue(
    () => Math.max(120, dataTransitionDurationMs),
    [dataTransitionDurationMs],
  );
  const dataTransitionKeySV = useDerivedValue(
    () => dataTransitionKey,
    [dataTransitionKey],
  );
  const layoutWidthSV = useDerivedValue(() => layoutWidth, [layoutWidth]);
  const layoutHeightSV = useDerivedValue(() => layoutHeight, [layoutHeight]);
  const orderbookDataSV = useDerivedValue(
    () => orderbook ?? EMPTY_ORDERBOOK,
    [orderbook],
  );
  const hasOrderbookSV = useDerivedValue(
    () => (orderbook ? 1 : 0),
    [orderbook],
  );
  const degenEnabledSV = useDerivedValue(
    () => (degenOptions ? 1 : 0),
    [degenOptions],
  );
  const badgeCharWidthSV = useDerivedValue(
    () => badgeCharWidth,
    [badgeCharWidth],
  );
  const hasInputDataSV = useDerivedValue(
    () => (hasInputData ? 1 : 0),
    [hasInputData],
  );

  const displayValueSV = useSharedValue(Number.isFinite(value) ? value : 0);
  const rangeMinSV = useSharedValue(
    Number.isFinite(value) ? value - 0.5 : -0.5,
  );
  const rangeMaxSV = useSharedValue(Number.isFinite(value) ? value + 0.5 : 0.5);
  const rangeInitedSV = useSharedValue(0);

  const domainEndSV = useSharedValue(Date.now() / 1000);
  const clockNowMsSV = useSharedValue(Date.now());
  // Accumulated frame time in ms — advances by the same capped dt used for
  // lerps, preventing desync between X-axis scrolling and Y-axis range/value
  // lerps when Hermes GC pauses the UI thread.

  const displayWindowSecsSV = useSharedValue(Math.max(1, windowSecs));
  const visibleStartIndexSV = useSharedValue(0);
  const visibleEndIndexSV = useSharedValue(-1);

  const dotXSV = useSharedValue(padding.left);
  const dotYSV = useSharedValue(padding.top);

  // Line and fill paths built inside useFrameCallback (single-pass, like the web)
  // so the tip position and dot are always from the same computation.
  const linePathSV = useSharedValue(Skia.Path.Make());
  const fillPathSV = useSharedValue(Skia.Path.Make());
  const oldLinePathSV = useSharedValue(Skia.Path.Make());
  const oldFillPathSV = useSharedValue(Skia.Path.Make());
  const currentLinePathSV = useSharedValue(Skia.Path.Make());
  const dataTransitionProgressSV = useSharedValue(1);
  const dataTransitionStartMsSV = useSharedValue(0);
  const prevDataTransitionKeySV = useSharedValue(dataTransitionKey);
  const dataMetaInitedSV = useSharedValue(0);
  const prevDataStepSecsSV = useSharedValue(0);
  const prevDataCountSV = useSharedValue(0);
  // Pre-allocated scratch buffers — avoids per-frame array allocations that
  // create GC pressure on the Hermes UI thread runtime.
  const splineBufferSV = useSharedValue(createSplineBuffer(256));
  const fillSplineBufferSV = useSharedValue(createSplineBuffer(256));
  const loadingSplineBufferSV = useSharedValue(createSplineBuffer(64));
  const gridScratchSV = useSharedValue(createGridScratch());
  const gridResultSV = useSharedValue(createGridResult());
  const crosshairResultSV = useSharedValue(createCrosshairResult());
  const timeScratchSV = useSharedValue(createTimeScratch());
  const rangeScratchSV = useSharedValue<RangeResult>({ min: 0, max: 1 });
  // String caching: only re-format when the display value changes at the
  // Only reformat when the value changes at display precision (6dp).
  // This eliminates ~7 string allocations per frame from formatAxisValueWorklet
  // + the .replace() for badge template — the primary source of Hermes GC pressure.
  const prevRoundedValueSV = useSharedValue(Number.NaN);
  const prevRoundedChangeSV = useSharedValue(Number.NaN);
  const prevRoundedChangePctSV = useSharedValue(INVALID_CHANGE_PCT);
  const prevChangeSignSV = useSharedValue(0);
  const cachedBadgeTemplateSV = useSharedValue("");

  const momentumDirSV = useSharedValue<Momentum>("flat");
  const badgeColorMixSV = useSharedValue(0.5);
  const badgeColorTargetSV = useSharedValue(0.5);

  const badgeTextSV = useSharedValue(formatAxisValueWorklet(value));
  const badgeWidthSV = useSharedValue(72);
  const badgeYSV = useSharedValue(-1);

  const valueTextSV = useSharedValue(
    formatWorkletValue(
      formatValueWorklet,
      valueMomentumColor ? Math.abs(value) : value,
    ),
  );
  const changeTextSV = useSharedValue(formatWorkletValue(formatValueWorklet, 0));
  const changeSignSV = useSharedValue(0);

  const pulseRadiusSV = useSharedValue(10);
  const pulseOpacitySV = useSharedValue(0);

  const hoverActiveSV = useSharedValue(false);
  const hoverXSV = useSharedValue(0);
  const hoverYSV = useSharedValue(0);
  const hoverValueSV = useSharedValue(0);
  const hoverTimeSecSV = useSharedValue(0);
  const hoverValueTextSV = useSharedValue("");
  const hoverTimeTextSV = useSharedValue("");
  const hoverWorkletEmitTimeSV = useSharedValue(Number.NaN);
  const hoverWorkletEmitValueSV = useSharedValue(Number.NaN);
  const hoverWorkletEmitHxSV = useSharedValue(Number.NaN);
  const scrubAmountSV = useSharedValue(0);
  const crosshairOpacitySV = useSharedValue(0);

  const chartRevealSV = useSharedValue(
    !showLoadingState && hasInputData ? 1 : 0,
  );
  const loadingAlphaSV = useSharedValue(showLoadingState ? 1 : 0);
  const loadingBreathSV = useSharedValue(0.22);
  const pauseProgressSV = useSharedValue(paused ? 1 : 0);
  const timeDebtMsSV = useSharedValue(0);

  const gridIntervalSV = useSharedValue(0);
  const gridSlotsSV = useSharedValue(createGridSlots());
  const timeSlotsSV = useSharedValue(createTimeSlots());
  const arrowUpOpacitySV = useSharedValue(0);
  const arrowDownOpacitySV = useSharedValue(0);
  const arrowCycleSV = useSharedValue(0);
  const orderbookStateSV = useSharedValue(createOrderbookState());
  const orderbookLabelsSV = useSharedValue(createOrderbookLabelSlots());
  const orderbookClearedSV = useSharedValue(1);
  const particleStateSV = useSharedValue(createParticleState());
  const particleSlotsSV = useSharedValue(createParticleSlots());
  const particlesClearedSV = useSharedValue(1);
  // Opacity-bucketed particle paths — replaces 80 ParticleCircle components
  // (320 useDerivedValue hooks) with 3 paths built in the frame callback.
  // Web sets ctx.globalAlpha per particle; we approximate with 3 life-based
  // buckets so the fade gradient is preserved without per-component overhead.
  const particlePathHighSV = useSharedValue(Skia.Path.Make());
  const particlePathMidSV = useSharedValue(Skia.Path.Make());
  const particlePathLowSV = useSharedValue(Skia.Path.Make());
  const shakeXSV = useSharedValue(0);
  const shakeYSV = useSharedValue(0);

  // ── Candle mode shared values ───────────────────────────────────────
  const isCandle = chartMode === "candle";
  const candleWidthSecs = candleWidthInput ?? 60;

  // Transfer candle data to UI thread atomically
  const candlesSV = useDerivedValue(
    () => candlesInput ?? ([] as CandlePoint[]),
    [candlesInput],
  );
  const liveCandleSV = useDerivedValue(
    () => liveCandleInput ?? null,
    [liveCandleInput],
  );
  const candleWidthSecsSV = useDerivedValue(
    () => candleWidthSecs,
    [candleWidthSecs],
  );
  const isCandleSV = useDerivedValue(() => (isCandle ? 1 : 0), [isCandle]);
  const lineModeSV = useDerivedValue(
    () => (lineModeInput ? 1 : 0),
    [lineModeInput],
  );

  // Batched candle Skia paths
  const candleBullPathSV = useSharedValue(Skia.Path.Make());
  const candleBearPathSV = useSharedValue(Skia.Path.Make());
  const candleBullWickPathSV = useSharedValue(Skia.Path.Make());
  const candleBearWickPathSV = useSharedValue(Skia.Path.Make());
  const candleLiveGlowPathSV = useSharedValue(Skia.Path.Make());
  const closePricePathSV = useSharedValue(Skia.Path.Make());

  // Candle animation state
  const lineModeProgressSV = useSharedValue(0);
  const liveBirthAlphaSV = useSharedValue(1);
  const liveBullBlendSV = useSharedValue(0.5);

  // Display candle OHLC (smooth lerped values)
  const displayCandleSV = useSharedValue<CandlePoint | null>(null);
  const smoothCloseSV = useSharedValue(0);
  const smoothCloseInitedSV = useSharedValue(0);

  // Candle range (separate from line range)
  const candleRangeMinSV = useSharedValue(0);
  const candleRangeMaxSV = useSharedValue(0);
  const candleRangeInitedSV = useSharedValue(0);

  // Live candle glow pulse (breathing animation)
  const candleGlowPulseSV = useSharedValue(0.12);

  // Candle width morph transition
  const candleWidthMorphFromSV = useSharedValue(candleWidthSecs);
  const candleWidthMorphToSV = useSharedValue(candleWidthSecs);
  const candleWidthMorphStartSV = useSharedValue(0);
  const candleWidthMorphTSV = useSharedValue(-1); // -1 = no morph
  const candleWidthOldRangeMinSV = useSharedValue(0);
  const candleWidthOldRangeMaxSV = useSharedValue(0);
  const candleWidthNewRangeMinSV = useSharedValue(0);
  const candleWidthNewRangeMaxSV = useSharedValue(0);
  // Old candle paths (for cross-fade during width change)
  const oldCandleBullPathSV = useSharedValue(Skia.Path.Make());
  const oldCandleBearPathSV = useSharedValue(Skia.Path.Make());
  const oldCandleBullWickPathSV = useSharedValue(Skia.Path.Make());
  const oldCandleBearWickPathSV = useSharedValue(Skia.Path.Make());

  // Candle crosshair OHLC text + time
  const candleCrosshairOSV = useSharedValue("");
  const candleCrosshairHSV = useSharedValue("");
  const candleCrosshairLSV = useSharedValue("");
  const candleCrosshairCSV = useSharedValue("");
  const candleCrosshairTimeSV = useSharedValue("");
  const candleCrosshairBullSV = useSharedValue(1); // 1 = bull (green), 0 = bear (red)

  // ── Multi-series shared values ────────────────────────────────────
  // Pre-allocate per-series paths + spline buffers for MAX_SERIES=8
  const seriesPath0SV = useSharedValue(Skia.Path.Make());
  const seriesPath1SV = useSharedValue(Skia.Path.Make());
  const seriesPath2SV = useSharedValue(Skia.Path.Make());
  const seriesPath3SV = useSharedValue(Skia.Path.Make());
  const seriesPath4SV = useSharedValue(Skia.Path.Make());
  const seriesPath5SV = useSharedValue(Skia.Path.Make());
  const seriesPath6SV = useSharedValue(Skia.Path.Make());
  const seriesPath7SV = useSharedValue(Skia.Path.Make());
  const seriesPathSVs = [
    seriesPath0SV,
    seriesPath1SV,
    seriesPath2SV,
    seriesPath3SV,
    seriesPath4SV,
    seriesPath5SV,
    seriesPath6SV,
    seriesPath7SV,
  ];
  const seriesSpline0SV = useSharedValue(createSplineBuffer(256));
  const seriesSpline1SV = useSharedValue(createSplineBuffer(256));
  const seriesSpline2SV = useSharedValue(createSplineBuffer(256));
  const seriesSpline3SV = useSharedValue(createSplineBuffer(256));
  const seriesSpline4SV = useSharedValue(createSplineBuffer(256));
  const seriesSpline5SV = useSharedValue(createSplineBuffer(256));
  const seriesSpline6SV = useSharedValue(createSplineBuffer(256));
  const seriesSpline7SV = useSharedValue(createSplineBuffer(256));
  const seriesSplineSVs = [
    seriesSpline0SV,
    seriesSpline1SV,
    seriesSpline2SV,
    seriesSpline3SV,
    seriesSpline4SV,
    seriesSpline5SV,
    seriesSpline6SV,
    seriesSpline7SV,
  ];

  interface SeriesSlot {
    active: number;
    displayValue: number;
    alpha: number;
    dotX: number;
    dotY: number;
    color: string;
    label: string;
  }

  const createSeriesSlots = (): SeriesSlot[] => {
    const slots: SeriesSlot[] = [];
    for (let i = 0; i < MAX_SERIES; i++) {
      slots.push({
        active: 0,
        displayValue: 0,
        alpha: 0,
        dotX: 0,
        dotY: 0,
        color: "",
        label: "",
      });
    }
    return slots;
  };

  const seriesSlotsSV = useSharedValue(createSeriesSlots());
  const activeSeriesCountSV = useSharedValue(0);
  const multiCrosshairResultSV = useSharedValue(createMultiCrosshairResult());
  const multiSeriesRangeInitedSV = useSharedValue(0);

  // Pack series data into per-series Float64Arrays for UI thread transfer
  const packedSeriesData = useMemo(() => {
    if (!isMultiSeriesInput || !seriesInput) return null;
    const buffers: Float64Array[] = [];
    const counts: number[] = [];
    const colors: string[] = [];
    const labels: string[] = [];
    const values: number[] = [];
    for (let i = 0; i < Math.min(seriesInput.length, MAX_SERIES); i++) {
      const s = seriesInput[i];
      const packed = packPoints(s.data);
      // Append live value at end like main buffer
      const buf = new Float64Array(packed.buf.length + 1);
      buf.set(packed.buf);
      buf[packed.buf.length] = s.value;
      buffers.push(buf);
      counts.push(packed.count);
      colors.push(s.color);
      labels.push(s.label ?? "");
      values.push(s.value);
    }
    return { buffers, counts, colors, labels, values };
  }, [isMultiSeriesInput, seriesInput]);

  const seriesBuffersSV = useDerivedValue(
    () => packedSeriesData?.buffers ?? [],
    [packedSeriesData],
  );
  const seriesCountsSV = useDerivedValue(
    () => packedSeriesData?.counts ?? [],
    [packedSeriesData],
  );
  const seriesColorsSV = useDerivedValue(
    () => packedSeriesData?.colors ?? [],
    [packedSeriesData],
  );
  const seriesLabelsSV = useDerivedValue(
    () => packedSeriesData?.labels ?? [],
    [packedSeriesData],
  );
  const seriesValuesSV = useDerivedValue(
    () => packedSeriesData?.values ?? [],
    [packedSeriesData],
  );
  const isMultiSeriesSV = useDerivedValue(
    () => (isMultiSeriesInput ? 1 : 0),
    [isMultiSeriesInput],
  );

  // Hidden series IDs transferred as a plain array of id strings
  const hiddenSeriesIdArr = useMemo(
    () => (hiddenSeriesIdsInput ? Array.from(hiddenSeriesIdsInput) : []),
    [hiddenSeriesIdsInput],
  );
  const hiddenSeriesIdsSV = useDerivedValue(
    () => hiddenSeriesIdArr,
    [hiddenSeriesIdArr],
  );

  // Series IDs for looking up hidden state on the UI thread
  const seriesIdArr = useMemo(
    () =>
      seriesInput ? seriesInput.slice(0, MAX_SERIES).map((s) => s.id) : [],
    [seriesInput],
  );
  const seriesIdsSV = useDerivedValue(() => seriesIdArr, [seriesIdArr]);

  // Line morph transition refs (stored in shared values for worklet access)
  const lineMorphStartMsSV = useSharedValue(0);
  const lineMorphFromSV = useSharedValue(0);
  const lineMorphToSV = useSharedValue(0);

  // Paths moved from usePathValue/useDerivedValue in Liveline.tsx into the
  // frame callback so they read snapshot-phase range/position locals,
  // eliminating one-frame drift (ghosting) vs the line path.
  const referencePathSV = useSharedValue(Skia.Path.Make());
  const referenceLabelYSV = useSharedValue(-1000);
  const referenceLabelOpacitySV = useSharedValue(0);
  const hoverLinePathSV = useSharedValue(Skia.Path.Make());
  const arrowUpChevron0SV = useSharedValue(Skia.Path.Make());
  const arrowUpChevron1SV = useSharedValue(Skia.Path.Make());
  const arrowDownChevron0SV = useSharedValue(Skia.Path.Make());
  const arrowDownChevron1SV = useSharedValue(Skia.Path.Make());
  const badgePathSV = useSharedValue(Skia.Path.Make());

  useAnimatedReaction(
    () => {
      "worklet";
      if (typeof momentumOverride === "string") return momentumOverride;
      if (!showMomentum) return "flat" as const;
      const buf = pointsBufSV.value;
      const count = buf.length > 0 ? (buf.length - 1) / 2 : 0;
      return detectMomentumFromPoints(buf, count);
    },
    (next) => {
      "worklet";
      momentumDirSV.value = next;
      badgeColorTargetSV.value = next === "up" ? 1 : next === "down" ? 0 : 0.5;
    },
    [showMomentum, momentumOverride],
  );

  const degenScale =
    degenOptions?.scale ??
    (typeof degenOptions?.particles === "number" &&
    Number.isFinite(degenOptions.particles)
      ? Math.min(3, Math.max(0.25, degenOptions.particles / 20))
      : 1);
  const degenDownMomentum = degenOptions?.downMomentum === true;
  const degenShakeScale =
    typeof degenOptions?.shake === "number" &&
    Number.isFinite(degenOptions.shake)
      ? degenOptions.shake
      : 1;

  useFrameCallback((frame) => {
    "worklet";

    const rewindPath = (sv: typeof linePathSV) => {
      sv.value.rewind();
      sv.modify(undefined, true);
    };

    const width = layoutWidthSV.value;
    const height = layoutHeightSV.value;
    if (width <= 0 || height <= 0) {
      rewindPath(linePathSV);
      rewindPath(fillPathSV);
      rewindPath(oldLinePathSV);
      rewindPath(oldFillPathSV);
      rewindPath(currentLinePathSV);
      rewindPath(referencePathSV);
      rewindPath(hoverLinePathSV);
      rewindPath(arrowUpChevron0SV);
      rewindPath(arrowUpChevron1SV);
      rewindPath(arrowDownChevron0SV);
      rewindPath(arrowDownChevron1SV);
      rewindPath(badgePathSV);
      return;
    }

    const dt = Math.min(frame.timeSincePreviousFrame ?? 16.6667, 50);
    const ratio = dt / 16.6667;
    arrowCycleSV.value = (frame.timeSinceFirstFrame % 1400) / 1400;
    const transitionMode = dataTransitionModeSV.value;

    const pauseTarget = paused ? 1 : 0;
    pauseProgressSV.value = alphaLerp(
      pauseProgressSV.value,
      pauseTarget,
      PAUSE_PROGRESS_SPEED,
      ratio,
    );

    if (pauseProgressSV.value < 0.005) pauseProgressSV.value = 0;
    if (pauseProgressSV.value > 0.995) pauseProgressSV.value = 1;

    const pauseProgress = pauseProgressSV.value;
    timeDebtMsSV.value += dt * pauseProgress;
    if (!paused && timeDebtMsSV.value > 0.001) {
      const catchUpSpeed =
        timeDebtMsSV.value > 10_000
          ? PAUSE_CATCHUP_SPEED_FAST
          : PAUSE_CATCHUP_SPEED;
      timeDebtMsSV.value = alphaLerp(
        timeDebtMsSV.value,
        0,
        catchUpSpeed,
        ratio,
      );
      if (timeDebtMsSV.value < 10) timeDebtMsSV.value = 0;
    }

    const loadingBridgeActive =
      transitionMode === "loadingBridge" &&
      dataTransitionStartMsSV.value > 0 &&
      dataTransitionProgressSV.value < DATA_TRANSITION_LOADING_SPLIT;
    const effectiveShowLoadingState = showLoadingState || loadingBridgeActive;

    loadingAlphaSV.value = alphaLerp(
      loadingAlphaSV.value,
      effectiveShowLoadingState ? 1 : 0,
      LOADING_ALPHA_SPEED,
      ratio,
    );

    const hasInputDataNow = hasInputDataSV.value > 0.5;
    const revealTarget = !effectiveShowLoadingState && hasInputDataNow ? 1 : 0;
    chartRevealSV.value = alphaLerp(
      chartRevealSV.value,
      revealTarget,
      CHART_REVEAL_SPEED,
      ratio,
    );

    if (Math.abs(chartRevealSV.value - revealTarget) < 0.005) {
      chartRevealSV.value = revealTarget;
    }

    const scrubTarget = hoverActiveSV.value ? 1 : 0;
    scrubAmountSV.value = alphaLerp(
      scrubAmountSV.value,
      scrubTarget,
      SCRUB_LERP_SPEED,
      ratio,
    );
    if (scrubAmountSV.value < 0.01) scrubAmountSV.value = 0;
    if (scrubAmountSV.value > 0.99) scrubAmountSV.value = 1;
    if (!hoverActiveSV.value) {
      // Reset emit cache on scrub end so repeated taps at the same point
      // still emit callbacks when a new scrub gesture starts.
      hoverWorkletEmitTimeSV.value = Number.NaN;
      hoverWorkletEmitValueSV.value = Number.NaN;
      hoverWorkletEmitHxSV.value = Number.NaN;
    }

    const chartReveal = chartRevealSV.value;
    const isMultiNow = isMultiSeriesSV.value > 0.5;
    let labelReserve = 0;
    if (isMultiNow) {
      const labels = seriesLabelsSV.value;
      let maxLabelW = 0;
      const labelCount = Math.min(MAX_SERIES, labels.length);
      for (let i = 0; i < labelCount; i += 1) {
        const label = labels[i];
        if (!label) continue;
        const labelW = estimateTextWidthMonospace(label, seriesLabelCharWidth);
        if (labelW > maxLabelW) maxLabelW = labelW;
      }
      labelReserve =
        Math.max(0, maxLabelW - MULTI_SERIES_LABEL_GAP_PX) * chartReveal;
    }

    const innerWidth = Math.max(
      1,
      width - padding.left - padding.right - labelReserve,
    );
    const innerHeight = Math.max(1, height - padding.top - padding.bottom);

    // Cap wall-time advance to match the dt cap (50ms) so X-axis and
    // Y-axis lerps stay in lockstep during Hermes GC pauses. Without this,
    // a GC pause causes Date.now() to jump by the full pause duration while
    // Y-axis lerps only advance by 50ms, creating a visible one-frame jitter.
    // Convergence back to wall time is natural: after a pause, subsequent
    // normal frames (~16ms) accumulate the deficit into the raw delta, which
    // stays under the 50ms cap, so the clock catches up within a few frames.
    const nowRawMs = Date.now();
    const prevClockMs = clockNowMsSV.value;
    const clockDelta = nowRawMs - prevClockMs;
    // On first frame or if clock is wildly stale (>1s), snap to wall time.
    // Otherwise cap per-frame advance to same 50ms as dt.
    const cappedNowMs =
      clockDelta < 0 || clockDelta > 1000
        ? nowRawMs
        : prevClockMs + Math.min(clockDelta, 50);
    clockNowMsSV.value = cappedNowMs;
    // Cosmetic animations use raw wall time — no need to cap
    loadingBreathSV.value = loadingBreath(nowRawMs);

    const pts = pointsBufSV.value;
    // Derive count from buffer length (not a separate shared value) so
    // it's always in sync with the buffer contents on the same frame.
    // Buffer layout: [t0,v0, ..., tN,vN, liveValue] → count = (len - 1) / 2
    const ptsCount = pts.length > 0 ? (pts.length - 1) / 2 : 0;
    // Live value is appended as the last element of the packed buffer,
    // after the (t,v) pairs, so it transfers atomically with the points.
    const liveValue = pts.length > 0 ? pts[ptsCount * 2] : 0;
    if (ptsCount === 0) {
      const r = Math.round(liveValue * 1e6) / 1e6;
      if (r !== prevRoundedValueSV.value) {
        prevRoundedValueSV.value = r;
        const text = formatWorkletValue(formatValueWorklet, liveValue);
        valueTextSV.value = text;
        badgeTextSV.value = text;
      }
      if (prevRoundedChangeSV.value !== 0 || prevChangeSignSV.value !== 0) {
        prevRoundedChangeSV.value = 0;
        prevRoundedChangePctSV.value = INVALID_CHANGE_PCT;
        prevChangeSignSV.value = 0;
        changeSignSV.value = 0;
        changeTextSV.value = formatWorkletValue(formatValueWorklet, 0);
      }
      crosshairOpacitySV.value = 0;
      arrowUpOpacitySV.value = 0;
      arrowDownOpacitySV.value = 0;
      shakeXSV.value = 0;
      shakeYSV.value = 0;
      rewindPath(linePathSV);
      rewindPath(fillPathSV);
      rewindPath(oldLinePathSV);
      rewindPath(oldFillPathSV);
      rewindPath(currentLinePathSV);
      rewindPath(referencePathSV);
      rewindPath(hoverLinePathSV);
      rewindPath(arrowUpChevron0SV);
      rewindPath(arrowUpChevron1SV);
      rewindPath(arrowDownChevron0SV);
      rewindPath(arrowDownChevron1SV);
      rewindPath(badgePathSV);
      referenceLabelOpacitySV.value = 0;
      return;
    }

    const nowMs = cappedNowMs - timeDebtMsSV.value;
    const nowSec = nowMs / 1000;

    const keyChanged = dataTransitionKeySV.value !== prevDataTransitionKeySV.value;
    const lineDataTransitionEnabled =
      chartMode === "line" &&
      isLineDataTransitionModeEnabled(transitionMode);

    if (
      keyChanged &&
      lineDataTransitionEnabled
    ) {
      rewindPath(oldLinePathSV);
      rewindPath(oldFillPathSV);
      dataTransitionStartMsSV.value = nowMs;
      dataTransitionProgressSV.value = 0;
    }
    prevDataTransitionKeySV.value = dataTransitionKeySV.value;

    const currentStepSecs = estimateStepSecs(pts, ptsCount);
    if (lineDataTransitionEnabled) {
      if (dataMetaInitedSV.value > 0 && prevDataCountSV.value > 0) {
        const prevStep = prevDataStepSecsSV.value;
        const minStep = Math.max(1e-6, Math.min(prevStep, currentStepSecs));
        const maxStep = Math.max(prevStep, currentStepSecs);
        const stepRatio = maxStep > 0 ? maxStep / minStep : 1;
        const countRatio =
          Math.max(prevDataCountSV.value, ptsCount) /
          Math.max(1, Math.min(prevDataCountSV.value, ptsCount));
        const shouldStartTransition =
          (stepRatio >= DATA_TRANSITION_STEP_RATIO_TRIGGER ||
            countRatio >= DATA_TRANSITION_COUNT_RATIO_TRIGGER) &&
          chartRevealSV.value > 0.8;
        if (shouldStartTransition) {
          rewindPath(oldLinePathSV);
          rewindPath(oldFillPathSV);
          dataTransitionStartMsSV.value = nowMs;
          dataTransitionProgressSV.value = 0;
        }
      }
      prevDataStepSecsSV.value = currentStepSecs;
      prevDataCountSV.value = ptsCount;
      dataMetaInitedSV.value = 1;
    } else {
      dataTransitionStartMsSV.value = 0;
      dataTransitionProgressSV.value = 1;
      if (dataMetaInitedSV.value !== 0) {
        dataMetaInitedSV.value = 0;
        prevDataStepSecsSV.value = 0;
        prevDataCountSV.value = 0;
        rewindPath(oldLinePathSV);
        rewindPath(oldFillPathSV);
      }
    }

    if (dataTransitionStartMsSV.value > 0) {
      const elapsed = nowMs - dataTransitionStartMsSV.value;
      const duration = dataTransitionDurationMsSV.value;
      const t = clamp(elapsed / duration, 0, 1);
      const eased = (1 - Math.cos(t * Math.PI)) * 0.5;
      dataTransitionProgressSV.value = eased;
      if (t >= 1) {
        dataTransitionStartMsSV.value = 0;
        dataTransitionProgressSV.value = 1;
        rewindPath(oldLinePathSV);
        rewindPath(oldFillPathSV);
      }
    } else if (dataTransitionProgressSV.value !== 1) {
      dataTransitionProgressSV.value = 1;
    }

    // Gesture window (pinch) overrides button-controlled window when > 0
    const gestureWindow = gestureWindowSecsSVInput
      ? gestureWindowSecsSVInput.value
      : 0;
    const targetWindow = Math.max(
      1,
      gestureWindow > 0 ? gestureWindow : windowSecsSV.value,
    );
    const displayWindow = Math.max(1, displayWindowSecsSV.value);
    const nextLogWindow = alphaLerp(
      Math.log(displayWindow),
      Math.log(targetWindow),
      0.12,
      ratio * (1 - pauseProgress),
    );
    displayWindowSecsSV.value = Math.exp(nextLogWindow);
    if (Math.abs(displayWindowSecsSV.value - targetWindow) < 0.01) {
      displayWindowSecsSV.value = targetWindow;
    }
    const windowSecsNow = Math.max(1, displayWindowSecsSV.value);

    // Momentum decay — exponential velocity decay + offset integration
    if (
      panVelocitySVInput &&
      domainOffsetSVInput &&
      Math.abs(panVelocitySVInput.value) > MOMENTUM_STOP_THRESHOLD
    ) {
      panVelocitySVInput.value *= Math.pow(MOMENTUM_DECAY_PER_MS, dt);
      domainOffsetSVInput.value += panVelocitySVInput.value * dt;
      if (domainOffsetSVInput.value > 0) domainOffsetSVInput.value = 0;
      if (Math.abs(panVelocitySVInput.value) < MOMENTUM_STOP_THRESHOLD) {
        panVelocitySVInput.value = 0;
      }
    }

    // Snap-back-to-live when close to 0 with no momentum
    if (domainOffsetSVInput && isLiveSVInput) {
      const vel = panVelocitySVInput ? panVelocitySVInput.value : 0;
      if (
        domainOffsetSVInput.value > -SNAP_BACK_THRESHOLD_SECS &&
        Math.abs(vel) < MOMENTUM_STOP_THRESHOLD
      ) {
        domainOffsetSVInput.value = 0;
        isLiveSVInput.value = 1;
      } else if (domainOffsetSVInput.value < -SNAP_BACK_THRESHOLD_SECS) {
        isLiveSVInput.value = 0;
      }
    }
    const bufferRatio = resolveWindowBuffer(
      innerWidth,
      showMomentum && showBadge,
    );

    const liveDomainTarget = Math.max(
      nowSec,
      ptsCount > 0 ? ptT(pts, ptsCount - 1) : nowSec,
    );
    const domainOffset = domainOffsetSVInput ? domainOffsetSVInput.value : 0;
    const domainTarget = liveDomainTarget + domainOffset;
    domainEndSV.value = domainTarget;

    const rightEdge = domainTarget + windowSecsNow * bufferRatio;
    const start = rightEdge - windowSecsNow;
    const filterRight = rightEdge - (rightEdge - domainTarget) * pauseProgress;

    // Include 2 seconds of left overscan, matching the web version
    // (p.time >= leftEdge - 2). This keeps the range broader/stabler
    // when points scroll off the left edge.
    const firstVisible = findFirstPointIndexAtOrAfter(pts, ptsCount, start - 2);
    const lastVisible = findLastPointIndexAtOrBefore(
      pts,
      ptsCount,
      filterRight,
    );
    const maxIdx = ptsCount - 1;
    const firstClamped = clampIndex(firstVisible, 0, maxIdx);
    const lastClamped = clampIndex(lastVisible, -1, maxIdx);
    visibleStartIndexSV.value = firstClamped;
    visibleEndIndexSV.value = lastClamped >= firstClamped ? lastClamped : -1;

    const isLiveNow = domainOffset > -SNAP_BACK_THRESHOLD_SECS;
    const targetValue = isLiveNow
      ? liveValue
      : lastClamped >= 0
        ? ptV(pts, lastClamped)
        : liveValue;
    // ── Atomic snapshot / advance / render ──────────────────────────
    // The web reads configRef.current once per rAF so data, value, and
    // smoothValue are always from the same snapshot. In native the
    // buffer can arrive between frames while displayValue and range are
    // mid-lerp. To match the web's atomicity we:
    //   1. SNAPSHOT  current displayValue + range (locals)
    //   2. ADVANCE   compute next-frame values (locals)
    //   3. RENDER    path + dot from snapshot (no SV mutation yet)
    //   4. COMMIT    write next-frame values to SVs (after path build)
    // This guarantees liveY == realY for the outgoing last-point on the
    // exact frame a new data point arrives — zero snap.

    const curDisplay = displayValueSV.value;
    const curRangeMin = rangeMinSV.value;
    const curRangeMax = rangeMaxSV.value;
    const currentRange = Math.max(1e-6, curRangeMax - curRangeMin);

    const valueGap = Math.abs(targetValue - curDisplay);
    const gapRatio = clamp(valueGap / currentRange, 0, 1);
    const adaptiveSpeed = clamp(lerpSpeed + (1 - gapRatio) * 0.2, 0.001, 0.8);
    const pausedRatio = ratio * (1 - pauseProgress);
    const alpha =
      pausedRatio <= 0 ? 0 : 1 - Math.pow(1 - adaptiveSpeed, pausedRatio);

    // 2. ADVANCE — compute next-frame values into locals
    let nextDisplay = curDisplay + (targetValue - curDisplay) * alpha;
    if (
      pauseProgress < 0.5 &&
      Math.abs(nextDisplay - targetValue) < currentRange * VALUE_SNAP_THRESHOLD
    ) {
      nextDisplay = targetValue;
    }

    const referenceValue =
      referenceLine && Number.isFinite(referenceLine.value)
        ? referenceLine.value
        : Number.NaN;

    const isCandleNow = isCandleSV.value > 0.5;

    const rangeOut = rangeScratchSV.value;
    computeRangeFromVisible(
      rangeOut,
      pts,
      ptsCount,
      firstVisible,
      lastVisible,
      curDisplay,
      referenceValue,
      exaggerate,
    );

    let nextRangeMin: number;
    let nextRangeMax: number;
    if (rangeInitedSV.value === 0) {
      nextRangeMin = rangeOut.min;
      nextRangeMax = rangeOut.max;
      rangeInitedSV.value = 1;
    } else {
      // Snap outward when data would be visibly clipped (expansion exceeds
      // half the current range). Small target shifts from margin/center
      // drift are lerped normally to avoid jitter on small ticks.
      const snapThreshold = currentRange * 0.5;
      nextRangeMin =
        rangeOut.min < curRangeMin && curRangeMin - rangeOut.min > snapThreshold
          ? rangeOut.min
          : curRangeMin + (rangeOut.min - curRangeMin) * alpha;
      nextRangeMax =
        rangeOut.max > curRangeMax && rangeOut.max - curRangeMax > snapThreshold
          ? rangeOut.max
          : curRangeMax + (rangeOut.max - curRangeMax) * alpha;

      const pxThreshold =
        innerHeight > 0
          ? (0.5 * currentRange) / innerHeight
          : VALUE_SNAP_THRESHOLD;
      const threshold =
        Number.isFinite(pxThreshold) && pxThreshold > 0
          ? pxThreshold
          : VALUE_SNAP_THRESHOLD;
      if (Math.abs(nextRangeMin - rangeOut.min) < threshold) {
        nextRangeMin = rangeOut.min;
      }
      if (Math.abs(nextRangeMax - rangeOut.max) < threshold) {
        nextRangeMax = rangeOut.max;
      }
    }

    // 3. RENDER — use snapshot values for this frame's geometry
    const rangeMin = curRangeMin;
    const rangeMax = curRangeMax;
    const rangeSpan = Math.max(1e-6, rangeMax - rangeMin);

    const spanX = Math.max(1e-6, rightEdge - start);
    const liveX = padding.left + ((domainTarget - start) / spanX) * innerWidth;
    const liveY =
      padding.top +
      (1 - (curDisplay - rangeMin) / Math.max(rangeSpan, 1e-6)) * innerHeight;

    // Clamp to chart bounds — matches web clampY(toY(smoothValue)).
    // During fast value changes the display value can outpace the range
    // lerp, pushing liveY outside the chart area. The line path already
    // clamps via morphY; the dot must match to prevent a brief overshoot.
    const clampedLiveY = clamp(liveY, padding.top, padding.top + innerHeight);

    const centerY = padding.top + innerHeight * 0.5;
    const loadingAmplitude = Math.max(2, innerHeight * LOADING_AMPLITUDE_RATIO);
    const loadingScroll = nowRawMs * LOADING_SCROLL_SPEED;
    const revealRamp = (start: number, end: number): number => {
      "worklet";
      const t = clamp(
        (chartReveal - start) / Math.max(1e-6, end - start),
        0,
        1,
      );
      return t * t * (3 - 2 * t);
    };
    const gridTimeReveal = chartReveal < 1 ? revealRamp(0.15, 0.7) : 1;

    const dotX =
      chartReveal < 1
        ? liveX + (padding.left + innerWidth - liveX) * (1 - chartReveal)
        : liveX;
    dotXSV.value = dotX;
    if (chartReveal >= 1) {
      dotYSV.value = clampedLiveY;
    } else {
      // Morph from loading waveform baseline — matches the line tip's
      // morphY which uses loadingY, so dot and line tip stay aligned
      // throughout the reveal animation (web draws dot at line tip).
      const tipT = clamp(
        (dotX - padding.left) / Math.max(innerWidth, 1e-6),
        0,
        1,
      );
      const baseY = loadingY(tipT, centerY, loadingAmplitude, loadingScroll);
      dotYSV.value = baseY + (clampedLiveY - baseY) * chartReveal;
    }

    badgeColorMixSV.value +=
      (badgeColorTargetSV.value - badgeColorMixSV.value) *
      clamp(MOMENTUM_COLOR_LERP * ratio, 0, 1);

    if (showMomentum) {
      const upTarget = momentumDirSV.value === "up" ? 1 : 0;
      const downTarget = momentumDirSV.value === "down" ? 1 : 0;
      const canFadeInUp = arrowDownOpacitySV.value < 0.02;
      const canFadeInDown = arrowUpOpacitySV.value < 0.02;

      arrowUpOpacitySV.value = alphaLerp(
        arrowUpOpacitySV.value,
        canFadeInUp ? upTarget : 0,
        upTarget > arrowUpOpacitySV.value ? 0.08 : 0.04,
        ratio,
      );
      arrowDownOpacitySV.value = alphaLerp(
        arrowDownOpacitySV.value,
        canFadeInDown ? downTarget : 0,
        downTarget > arrowDownOpacitySV.value ? 0.08 : 0.04,
        ratio,
      );

      if (arrowUpOpacitySV.value < 0.01) arrowUpOpacitySV.value = 0;
      if (arrowDownOpacitySV.value < 0.01) arrowDownOpacitySV.value = 0;
      if (arrowUpOpacitySV.value > 0.99) arrowUpOpacitySV.value = 1;
      if (arrowDownOpacitySV.value > 0.99) arrowDownOpacitySV.value = 1;
    } else {
      arrowUpOpacitySV.value = 0;
      arrowDownOpacitySV.value = 0;
    }

    const baselineValue =
      firstClamped >= 0 && firstClamped < ptsCount
        ? ptV(pts, firstClamped)
        : curDisplay;
    const shownValue =
      valueDisplayMode === "hover" && hoverActiveSV.value
        ? hoverValueSV.value
        : curDisplay;
    const showTopReadout = !isMultiNow;

    // Only reformat when the displayed value changes at display precision.
    const roundedShownValue = Math.round(shownValue * 1e6) / 1e6;
    if (roundedShownValue !== prevRoundedValueSV.value) {
      prevRoundedValueSV.value = roundedShownValue;
      const badgeText = formatWorkletValue(formatValueWorklet, curDisplay);
      badgeTextSV.value = badgeText;
      cachedBadgeTemplateSV.value = badgeText.replace(/[0-9]/g, "8");
      // Keep top readout active across line/candle modes; value/change are
      // data-derived and should not depend on render mode.
      if (showTopReadout) {
        valueTextSV.value = formatWorkletValue(
          formatValueWorklet,
          valueMomentumColor ? Math.abs(shownValue) : shownValue,
        );
      }
    }

    if (showTopReadout) {
      const changeValue = shownValue - baselineValue;
      const changeSign =
        changeValue > CHANGE_VALUE_EPS
          ? 1
          : changeValue < -CHANGE_VALUE_EPS
            ? -1
            : 0;
      const roundedChange = Math.round(Math.abs(changeValue) * 1e6) / 1e6;
      const hasChangePct =
        Number.isFinite(baselineValue) && Math.abs(baselineValue) > CHANGE_VALUE_EPS;
      const roundedChangePct = hasChangePct
        ? Math.round((Math.abs(changeValue / baselineValue) * 100 + Number.EPSILON) * 100) /
          100
        : INVALID_CHANGE_PCT;
      if (
        roundedChange !== prevRoundedChangeSV.value ||
        roundedChangePct !== prevRoundedChangePctSV.value ||
        changeSign !== prevChangeSignSV.value
      ) {
        prevRoundedChangeSV.value = roundedChange;
        prevRoundedChangePctSV.value = roundedChangePct;
        prevChangeSignSV.value = changeSign;
        changeSignSV.value = changeSign;
        const absChangeText = formatWorkletValue(formatValueWorklet, roundedChange);
        const signedAbsChangeText =
          changeSign > 0
            ? `+${absChangeText}`
            : changeSign < 0
              ? `-${absChangeText}`
              : absChangeText;
        if (hasChangePct) {
          const signedPctText =
            changeSign > 0
              ? `+${formatPercentWorklet(roundedChangePct)}`
              : changeSign < 0
                ? `-${formatPercentWorklet(roundedChangePct)}`
                : formatPercentWorklet(roundedChangePct);
          changeTextSV.value = `${signedAbsChangeText} (${signedPctText})`;
        } else {
          changeTextSV.value = signedAbsChangeText;
        }
      }
    } else if (prevRoundedChangeSV.value !== 0 || prevChangeSignSV.value !== 0) {
      prevRoundedChangeSV.value = 0;
      prevRoundedChangePctSV.value = INVALID_CHANGE_PCT;
      prevChangeSignSV.value = 0;
      changeSignSV.value = 0;
      changeTextSV.value = formatWorkletValue(formatValueWorklet, 0);
    }

    const badgeTemplate = cachedBadgeTemplateSV.value;
    const targetBadgeWidth = Math.max(
      26,
      estimateTextWidthMonospace(
        badgeTemplate,
        Math.max(4, badgeCharWidthSV.value),
      ),
    );
    if (badgeWidthSV.value <= 0) {
      badgeWidthSV.value = targetBadgeWidth;
    } else {
      badgeWidthSV.value +=
        (targetBadgeWidth - badgeWidthSV.value) * BADGE_WIDTH_LERP;
      if (Math.abs(badgeWidthSV.value - targetBadgeWidth) < 0.3) {
        badgeWidthSV.value = targetBadgeWidth;
      }
    }

    const isWindowTransitioning = Math.abs(windowSecsNow - targetWindow) > 0.02;
    const yLerp = isWindowTransitioning
      ? BADGE_Y_LERP_TRANSITIONING
      : BADGE_Y_LERP;

    const badgeHeight = BADGE_LINE_H + BADGE_PAD_Y * 2;
    // Match web: badge center targets dot Y clamped to chart bounds.
    // No badgeHeight/2 inset — the badge can extend past the chart edge
    // so it stays aligned with the dot even at the extremes.
    const targetBadgeY = clamp(
      dotYSV.value,
      padding.top,
      height - padding.bottom,
    );

    if (badgeYSV.value < 0) {
      badgeYSV.value = targetBadgeY;
    } else {
      badgeYSV.value +=
        (targetBadgeY - badgeYSV.value) * clamp(yLerp * ratio, 0, 1);
    }

    if (showPulse) {
      const pulseT =
        (frame.timeSinceFirstFrame % PULSE_INTERVAL_MS) / PULSE_DURATION_MS;
      if (pulseT < 1) {
        pulseRadiusSV.value = 9 + pulseT * 12;
        pulseOpacitySV.value = 0.35 * (1 - pulseT);
      } else {
        pulseOpacitySV.value = 0;
      }
    } else {
      pulseOpacitySV.value = 0;
    }

    if (showGrid) {
      const gridOut = gridResultSV.value;
      updateGridSlots(
        gridSlotsSV.value,
        gridIntervalSV.value,
        rangeMin,
        rangeMax,
        rangeSpan,
        height,
        innerHeight,
        padding.top,
        padding.bottom,
        ratio,
        gridTimeReveal,
        formatValueWorklet,
        gridScratchSV.value,
        gridOut,
      );
      gridIntervalSV.value = gridOut.interval;
      if (gridOut.dirty) {
        gridSlotsSV.modify(undefined, true);
      }
    } else {
      if (fadeOutGridSlots(gridSlotsSV.value, ratio)) {
        gridSlotsSV.modify(undefined, true);
      }
    }

    if (
      updateTimeSlots(
        timeSlotsSV.value,
        start,
        rightEdge,
        windowSecsNow,
        Math.max(1, targetWindowSecsSV.value),
        padding.left,
        innerWidth,
        ratio,
        gridTimeReveal,
        axisCharWidth,
        formatTimeWorklet,
        formatAxisTimeWorklet,
        resolvedAxisTimeFormatPreset,
        timeScratchSV.value,
      )
    ) {
      timeSlotsSV.modify(undefined, true);
    }

    // Candle mode check (used by crosshair and candle pipeline below)
    // Single-series / line-mode crosshair (skip in candle mode — candle pipeline handles it)
    if (!isCandleNow) {
      if (hoverActiveSV.value || scrubAmountSV.value > 0) {
        const ch = crosshairResultSV.value;
        updateCrosshairState(
          hoverXSV.value,
          pts,
          ptsCount,
          start,
          windowSecsNow,
          rangeMin,
          rangeSpan,
          padding.left,
          padding.top,
          innerWidth,
          innerHeight,
          dotXSV.value,
          scrubAmountSV.value,
          formatValueWorklet,
          formatTimeWorklet,
          formatCrosshairTimeWorklet,
          resolvedCrosshairTimeFormatPreset,
          ch,
        );

        hoverXSV.value = ch.hx;
        hoverTimeSecSV.value = ch.ht;
        hoverValueSV.value = ch.hv;
        hoverYSV.value = ch.hy;
        hoverValueTextSV.value = ch.valueText;
        hoverTimeTextSV.value = ch.timeText;
        crosshairOpacitySV.value = ch.opacity;

        const out: HoverPoint = {
          x: ch.hx,
          y: ch.hy,
          time: ch.ht,
          value: ch.hv,
        };

        if (hoverActiveSV.value && hasOnHoverWorklet) {
          const hxMoved =
            !Number.isFinite(hoverWorkletEmitHxSV.value) ||
            Math.abs(ch.hx - hoverWorkletEmitHxSV.value) > HOVER_EMIT_HX_EPS;
          if (hxMoved) {
            const workletTimeChanged =
              !Number.isFinite(hoverWorkletEmitTimeSV.value) ||
              Math.abs(ch.ht - hoverWorkletEmitTimeSV.value) >
                HOVER_EMIT_TIME_EPS;
            const workletValueChanged =
              !Number.isFinite(hoverWorkletEmitValueSV.value) ||
              Math.abs(ch.hv - hoverWorkletEmitValueSV.value) >
                HOVER_EMIT_VALUE_EPS;
            if (workletTimeChanged || workletValueChanged) {
              hoverWorkletEmitHxSV.value = ch.hx;
              hoverWorkletEmitTimeSV.value = ch.ht;
              hoverWorkletEmitValueSV.value = ch.hv;
              (onHoverWorklet as (point: HoverPoint | null) => void)(out);
            }
          }
        }
      } else {
        crosshairOpacitySV.value = 0;
      }
    }

    const visStart = visibleStartIndexSV.value;
    const visEnd = visibleEndIndexSV.value;
    const visibleLookback = Math.min(5, Math.max(0, visEnd - visStart));
    const deltaStartIdx = visEnd - visibleLookback;
    const hasEnd = visEnd >= 0 && visEnd < ptsCount;
    const hasDeltaStart = deltaStartIdx >= 0 && deltaStartIdx < ptsCount;
    const recentDelta =
      visibleLookback > 0 && hasEnd && hasDeltaStart
        ? Math.abs(ptV(pts, visEnd) - ptV(pts, deltaStartIdx))
        : 0;
    const swingMagnitude =
      rangeSpan > 0 ? clamp(recentDelta / rangeSpan, 0, 1) : 0;

    if (hasOrderbookSV.value > 0.5) {
      const book = orderbookDataSV.value;
      const hasBookData = book.bids.length > 0 || book.asks.length > 0;
      const labels = orderbookLabelsSV.value;
      if (hasBookData) {
        orderbookClearedSV.value = 0;
        const state = orderbookStateSV.value;
        updateOrderbookLabels(
          labels,
          state,
          book,
          padding.top,
          height - padding.bottom,
          innerHeight,
          dt,
          swingMagnitude,
        );
        orderbookStateSV.modify(undefined, true);
        orderbookLabelsSV.modify(undefined, true);
      } else if (orderbookClearedSV.value === 0) {
        for (let i = 0; i < labels.length; i += 1) {
          labels[i].active = 0;
          labels[i].alpha = 0;
        }
        orderbookLabelsSV.modify(undefined, true);
        orderbookClearedSV.value = 1;
      }
    } else if (orderbookClearedSV.value === 0) {
      const labels = orderbookLabelsSV.value;
      for (let i = 0; i < labels.length; i += 1) {
        labels[i].active = 0;
        labels[i].alpha = 0;
      }
      orderbookLabelsSV.modify(undefined, true);
      orderbookClearedSV.value = 1;
    }

    if (degenEnabledSV.value > 0.5 && chartRevealSV.value > 0.9) {
      particlesClearedSV.value = 0;
      const particles = particleSlotsSV.value;
      const state = particleStateSV.value;
      updateParticlesAndShake(
        particles,
        state,
        momentumDirSV.value,
        dotXSV.value,
        dotYSV.value,
        swingMagnitude,
        dt,
        degenScale,
        degenDownMomentum,
        degenShakeScale,
      );
      shakeXSV.value = state.shakeX;
      shakeYSV.value = state.shakeY;

      // Build particle circles into 3 opacity-bucketed paths — matches the
      // web's per-particle globalAlpha without 80 components / 320 derived values.
      const pHigh = particlePathHighSV.value;
      const pMid = particlePathMidSV.value;
      const pLow = particlePathLowSV.value;
      pHigh.rewind();
      pMid.rewind();
      pLow.rewind();
      for (let i = 0; i < particles.length; i += 1) {
        const p = particles[i];
        if (p.active !== 1 || p.life <= 0) continue;
        const r = p.size * (0.5 + p.life * 0.5);
        if (r < 0.1) continue;
        const bucket = p.life > 0.66 ? pHigh : p.life > 0.33 ? pMid : pLow;
        bucket.addCircle(p.x, p.y, r);
      }
      particlePathHighSV.modify(undefined, true);
      particlePathMidSV.modify(undefined, true);
      particlePathLowSV.modify(undefined, true);
    } else if (particlesClearedSV.value === 0) {
      const particles = particleSlotsSV.value;
      for (let i = 0; i < particles.length; i += 1) {
        particles[i].active = 0;
        particles[i].life = 0;
      }
      particlesClearedSV.value = 1;
      particlePathHighSV.value.rewind();
      particlePathMidSV.value.rewind();
      particlePathLowSV.value.rewind();
      particlePathHighSV.modify(undefined, true);
      particlePathMidSV.modify(undefined, true);
      particlePathLowSV.modify(undefined, true);
      if (shakeXSV.value !== 0) shakeXSV.value = 0;
      if (shakeYSV.value !== 0) shakeYSV.value = 0;
    } else {
      if (shakeXSV.value !== 0) shakeXSV.value = 0;
      if (shakeYSV.value !== 0) shakeYSV.value = 0;
    }

    // ── Candle mode pipeline ──────────────────────────────────────────
    // Rewind all candle paths each frame
    const rewindCandle = () => {
      candleBullPathSV.value.rewind();
      candleBearPathSV.value.rewind();
      candleBullWickPathSV.value.rewind();
      candleBearWickPathSV.value.rewind();
      candleLiveGlowPathSV.value.rewind();
      closePricePathSV.value.rewind();
    };

    if (isCandleNow) {
      rewindCandle();

      const candlesData = candlesSV.value;
      const rawLive = liveCandleSV.value;
      const cWidthSecs = candleWidthSecsSV.value;

      // Line mode morph transition
      const lineModeTarget = lineModeSV.value > 0.5 ? 1 : 0;
      if (lineMorphToSV.value !== lineModeTarget) {
        lineMorphFromSV.value = lineModeProgressSV.value;
        lineMorphToSV.value = lineModeTarget;
        lineMorphStartMsSV.value = nowRawMs;
      }
      if (LINE_MORPH_MS > 0) {
        const elapsed = nowRawMs - lineMorphStartMsSV.value;
        const t = Math.min(elapsed / LINE_MORPH_MS, 1);
        // Cosine ease
        const eased = (1 - Math.cos(t * Math.PI)) / 2;
        lineModeProgressSV.value =
          lineMorphFromSV.value +
          (lineMorphToSV.value - lineMorphFromSV.value) * eased;
      }
      const lineModeProg = lineModeProgressSV.value;

      // Candle width morph transition (300ms cross-fade with log-space interpolation)
      if (cWidthSecs !== candleWidthMorphToSV.value) {
        candleWidthMorphFromSV.value =
          candleWidthMorphStartSV.value > 0
            ? Math.exp(
                Math.log(candleWidthMorphFromSV.value) +
                  (Math.log(candleWidthMorphToSV.value) -
                    Math.log(candleWidthMorphFromSV.value)) *
                    candleWidthMorphTSV.value,
              )
            : candleWidthMorphToSV.value;
        candleWidthMorphToSV.value = cWidthSecs;
        candleWidthMorphStartSV.value = nowRawMs;
        candleWidthMorphTSV.value = 0;
        candleWidthOldRangeMinSV.value = candleRangeMinSV.value;
        candleWidthOldRangeMaxSV.value = candleRangeMaxSV.value;
      }
      let morphT = candleWidthMorphTSV.value;
      let displayCandleWidth: number;
      if (candleWidthMorphStartSV.value > 0) {
        const elapsed = nowRawMs - candleWidthMorphStartSV.value;
        const t = Math.min(elapsed / CANDLE_WIDTH_TRANS_MS, 1);
        morphT = (1 - Math.cos(t * Math.PI)) / 2;
        displayCandleWidth = Math.exp(
          Math.log(candleWidthMorphFromSV.value) +
            (Math.log(candleWidthMorphToSV.value) -
              Math.log(candleWidthMorphFromSV.value)) *
              morphT,
        );
        if (t >= 1) {
          displayCandleWidth = candleWidthMorphToSV.value;
          candleWidthMorphStartSV.value = 0;
          morphT = -1;
        }
        candleWidthMorphTSV.value = morphT;
      } else {
        displayCandleWidth = cWidthSecs;
      }

      // Live candle OHLC lerp
      if (rawLive) {
        const prev = displayCandleSV.value;
        if (!prev || prev.time !== rawLive.time) {
          // New candle birth: collapse OHLC to open, start fade-in
          displayCandleSV.value = {
            time: rawLive.time,
            open: rawLive.open,
            high: rawLive.open,
            low: rawLive.open,
            close: rawLive.open,
          };
          liveBirthAlphaSV.value = 0;
        } else {
          // Smooth OHLC updates
          const dc = displayCandleSV.value!;
          dc.open = alphaLerp(dc.open, rawLive.open, CANDLE_LERP_SPEED, ratio);
          dc.high = alphaLerp(dc.high, rawLive.high, CANDLE_LERP_SPEED, ratio);
          dc.low = alphaLerp(dc.low, rawLive.low, CANDLE_LERP_SPEED, ratio);
          dc.close = alphaLerp(
            dc.close,
            rawLive.close,
            CANDLE_LERP_SPEED,
            ratio,
          );
          displayCandleSV.modify(undefined, true);
        }

        // Fade-in new candle
        liveBirthAlphaSV.value = alphaLerp(
          liveBirthAlphaSV.value,
          1,
          0.2,
          ratio,
        );

        // Bull/bear blend
        const dc = displayCandleSV.value!;
        const bullTarget = dc.close >= dc.open ? 1 : 0;
        liveBullBlendSV.value = alphaLerp(
          liveBullBlendSV.value,
          bullTarget,
          0.12,
          ratio,
        );

        // Live candle glow pulse (breathing animation matching web)
        candleGlowPulseSV.value = 0.12 + Math.sin(nowRawMs * 0.004) * 0.08;

        // Smooth close price for dashed line
        if (smoothCloseInitedSV.value === 0) {
          smoothCloseSV.value = rawLive.close;
          smoothCloseInitedSV.value = 1;
        } else {
          smoothCloseSV.value = alphaLerp(
            smoothCloseSV.value,
            rawLive.close,
            CLOSE_LINE_LERP_SPEED,
            ratio,
          );
        }
      }

      // Filter visible candles
      const displayLive = displayCandleSV.value;
      const visibleCandles: CandlePoint[] = [];
      for (let i = 0; i < candlesData.length; i++) {
        const c = candlesData[i];
        if (c.time + displayCandleWidth >= start && c.time <= rightEdge) {
          visibleCandles.push(c);
        }
      }
      if (
        displayLive &&
        displayLive.time + displayCandleWidth >= start &&
        displayLive.time <= rightEdge
      ) {
        visibleCandles.push(displayLive);
      }

      // Compute candle range (from OHLC high/low, not just close)
      if (visibleCandles.length > 0) {
        const candleRange = computeCandleRange(visibleCandles);

        if (candleRangeInitedSV.value === 0) {
          candleRangeMinSV.value = candleRange.min;
          candleRangeMaxSV.value = candleRange.max;
          candleRangeInitedSV.value = 1;
        } else {
          const curRange = candleRangeMaxSV.value - candleRangeMinSV.value;
          const gapMin = Math.abs(candleRange.min - candleRangeMinSV.value);
          const gapMax = Math.abs(candleRange.max - candleRangeMaxSV.value);
          const maxGap = Math.max(gapMin, gapMax);
          const gapRat = curRange > 0 ? maxGap / curRange : 1;
          const speed =
            CANDLE_RANGE_LERP_SPEED +
            (1 - Math.min(gapRat, 1)) * CANDLE_RANGE_ADAPTIVE_BOOST;
          candleRangeMinSV.value = alphaLerp(
            candleRangeMinSV.value,
            candleRange.min,
            speed,
            ratio,
          );
          candleRangeMaxSV.value = alphaLerp(
            candleRangeMaxSV.value,
            candleRange.max,
            speed,
            ratio,
          );
        }
      }

      let cRangeMin = candleRangeMinSV.value;
      let cRangeMax = candleRangeMaxSV.value;

      // During width morph, compute target range for new width and interpolate
      if (morphT >= 0) {
        // Compute range for new candle width (visible with target width)
        const targetVis: CandlePoint[] = [];
        for (let i = 0; i < candlesData.length; i++) {
          const c = candlesData[i];
          if (c.time + cWidthSecs >= start && c.time <= rightEdge)
            targetVis.push(c);
        }
        if (displayLive) targetVis.push(displayLive);
        if (targetVis.length > 0) {
          const tr = computeCandleRange(targetVis);
          candleWidthNewRangeMinSV.value = tr.min;
          candleWidthNewRangeMaxSV.value = tr.max;
        }
        cRangeMin =
          candleWidthOldRangeMinSV.value +
          (candleWidthNewRangeMinSV.value - candleWidthOldRangeMinSV.value) *
            morphT;
        cRangeMax =
          candleWidthOldRangeMaxSV.value +
          (candleWidthNewRangeMaxSV.value - candleWidthOldRangeMaxSV.value) *
            morphT;
      }

      const cRangeSpan = Math.max(1e-6, cRangeMax - cRangeMin);

      // Build candle paths (new width)
      const pathResult: CandlePathResult = {
        bullBodies: candleBullPathSV.value,
        bearBodies: candleBearPathSV.value,
        bullWicks: candleBullWickPathSV.value,
        bearWicks: candleBearWickPathSV.value,
        liveGlowBody: candleLiveGlowPathSV.value,
        closePriceLine: closePricePathSV.value,
      };

      buildCandlePaths(
        pathResult,
        visibleCandles,
        displayCandleWidth,
        innerWidth,
        innerHeight,
        padding.left,
        padding.top,
        start,
        rightEdge,
        cRangeMin,
        cRangeSpan,
        displayLive?.time ?? -1,
        liveBirthAlphaSV.value,
        lineModeProg,
        chartReveal,
      );

      // Build old candle paths during width morph (cross-fade)
      oldCandleBullPathSV.value.reset();
      oldCandleBearPathSV.value.reset();
      oldCandleBullWickPathSV.value.reset();
      oldCandleBearWickPathSV.value.reset();
      if (morphT >= 0) {
        const oldWidth = candleWidthMorphFromSV.value;
        const oldPathResult: CandlePathResult = {
          bullBodies: oldCandleBullPathSV.value,
          bearBodies: oldCandleBearPathSV.value,
          bullWicks: oldCandleBullWickPathSV.value,
          bearWicks: oldCandleBearWickPathSV.value,
          liveGlowBody: candleLiveGlowPathSV.value, // reuse — glow stays
          closePriceLine: closePricePathSV.value, // reuse — close line stays
        };
        // Filter visible with old width
        const oldVisible: CandlePoint[] = [];
        for (let i = 0; i < candlesData.length; i++) {
          const c = candlesData[i];
          if (c.time + oldWidth >= start && c.time <= rightEdge)
            oldVisible.push(c);
        }
        buildCandlePaths(
          oldPathResult,
          oldVisible,
          oldWidth,
          innerWidth,
          innerHeight,
          padding.left,
          padding.top,
          start,
          rightEdge,
          cRangeMin,
          cRangeSpan,
          -1, // no live candle in old paths
          0,
          lineModeProg,
          chartReveal,
        );
      }

      // Candle crosshair
      if (hoverActiveSV.value || scrubAmountSV.value > 0) {
        if (visibleCandles.length > 0) {
          const hx = Math.min(
            Math.max(hoverXSV.value, padding.left),
            padding.left + innerWidth,
          );
          const hovered = candleAtX(
            visibleCandles,
            hx,
            displayCandleWidth,
            innerWidth,
            padding.left,
            start,
            rightEdge,
          );
          if (hovered) {
            const ht =
              start + ((hx - padding.left) / innerWidth) * windowSecsNow;
            const isLineModeCrosshair = lineModeProg > 0.5;

            candleCrosshairOSV.value = formatWorkletValue(
              formatValueWorklet,
              hovered.open,
            );
            candleCrosshairHSV.value = formatWorkletValue(
              formatValueWorklet,
              hovered.high,
            );
            candleCrosshairLSV.value = formatWorkletValue(
              formatValueWorklet,
              hovered.low,
            );
            const lineModeValue = interpolateAtTime(pts, ptsCount, ht);
            candleCrosshairCSV.value = formatWorkletValue(
              formatValueWorklet,
              isLineModeCrosshair ? lineModeValue : hovered.close,
            );
            candleCrosshairBullSV.value = hovered.close >= hovered.open ? 1 : 0;

            // Time text
            const tMs = ht * 1000;
            candleCrosshairTimeSV.value = formatCrosshairTimeWorklet
              ? formatCrosshairTimeWorklet(tMs, windowSecsNow)
              : formatTimeWorklet
                ? formatTimeWorklet(tMs)
                : formatCrosshairTimeByPresetWorklet(
                    tMs,
                    windowSecsNow,
                    resolvedCrosshairTimeFormatPreset,
                  );

            // Keep dot/horizontal crosshair on the same rendered curve:
            // line-mode uses interpolated line value; candle-mode uses candle close.
            const crosshairValue = isLineModeCrosshair
              ? lineModeValue
              : hovered.close;
            // Keep hover readout state in sync in candle mode so
            // valueDisplayMode="hover" uses the hovered candle value.
            hoverTimeSecSV.value = ht;
            hoverValueSV.value = crosshairValue;
            const crosshairMin = isLineModeCrosshair ? rangeMin : cRangeMin;
            const crosshairSpan = isLineModeCrosshair
              ? Math.max(rangeSpan, 1e-6)
              : cRangeSpan;
            hoverYSV.value =
              padding.top +
              (1 - (crosshairValue - crosshairMin) / crosshairSpan) *
                innerHeight;

            const out: HoverPoint = {
              x: hx,
              y: hoverYSV.value,
              time: ht,
              value: crosshairValue,
            };

            if (hoverActiveSV.value && hasOnHoverWorklet) {
              const hxMoved =
                !Number.isFinite(hoverWorkletEmitHxSV.value) ||
                Math.abs(hx - hoverWorkletEmitHxSV.value) > HOVER_EMIT_HX_EPS;
              if (hxMoved) {
                const workletTimeChanged =
                  !Number.isFinite(hoverWorkletEmitTimeSV.value) ||
                  Math.abs(ht - hoverWorkletEmitTimeSV.value) >
                    HOVER_EMIT_TIME_EPS;
                const workletValueChanged =
                  !Number.isFinite(hoverWorkletEmitValueSV.value) ||
                  Math.abs(crosshairValue - hoverWorkletEmitValueSV.value) >
                    HOVER_EMIT_VALUE_EPS;
                if (workletTimeChanged || workletValueChanged) {
                  hoverWorkletEmitHxSV.value = hx;
                  hoverWorkletEmitTimeSV.value = ht;
                  hoverWorkletEmitValueSV.value = crosshairValue;
                  (onHoverWorklet as (point: HoverPoint | null) => void)(out);
                }
              }
            }
          }

          // Crosshair opacity with live-dot fade
          const liveDotX = dotXSV.value;
          const distToLive = liveDotX - hx;
          const fadeMinPx = 5;
          const fadeStart = Math.min(80, innerWidth * 0.3);
          const scrubAmt = scrubAmountSV.value;
          const scrubOpacity =
            distToLive < fadeMinPx
              ? 0
              : distToLive >= fadeStart
                ? scrubAmt
                : ((distToLive - fadeMinPx) /
                    Math.max(1e-6, fadeStart - fadeMinPx)) *
                  scrubAmt;
          crosshairOpacitySV.value = Math.min(Math.max(scrubOpacity, 0), 1);
        }
      } else {
        if (crosshairOpacitySV.value !== 0) crosshairOpacitySV.value = 0;
      }

      // Notify path mutations
      candleBullPathSV.modify(undefined, true);
      candleBearPathSV.modify(undefined, true);
      candleBullWickPathSV.modify(undefined, true);
      candleBearWickPathSV.modify(undefined, true);
      candleLiveGlowPathSV.modify(undefined, true);
      closePricePathSV.modify(undefined, true);
    } else {
      // Not candle mode — reset candle state
      if (candleRangeInitedSV.value !== 0) {
        rewindCandle();
        candleBullPathSV.modify(undefined, true);
        candleBearPathSV.modify(undefined, true);
        candleBullWickPathSV.modify(undefined, true);
        candleBearWickPathSV.modify(undefined, true);
        candleLiveGlowPathSV.modify(undefined, true);
        closePricePathSV.modify(undefined, true);
        candleRangeInitedSV.value = 0;
        lineModeProgressSV.value = 0;
        smoothCloseInitedSV.value = 0;
        displayCandleSV.value = null;
      }
    }

    // ── Multi-series pipeline ──────────────────────────────────────────
    if (isMultiNow) {
      const sBufs = seriesBuffersSV.value;
      const sCounts = seriesCountsSV.value;
      const sColors = seriesColorsSV.value;
      const sLabels = seriesLabelsSV.value;
      const sValues = seriesValuesSV.value;
      const sCount = Math.min(sBufs.length, MAX_SERIES);
      const hiddenIds = hiddenSeriesIdsSV.value;
      const slots = seriesSlotsSV.value;

      activeSeriesCountSV.value = sCount;

      // Determine which series IDs are hidden
      const sIds = seriesIdsSV.value;
      const isHidden = (idx: number): boolean => {
        "worklet";
        if (hiddenIds.length === 0) return false;
        const id = idx < sIds.length ? sIds[idx] : "";
        for (let h = 0; h < hiddenIds.length; h++) {
          if (hiddenIds[h] === id) return true;
        }
        return false;
      };

      // Per-series smooth values and visibility alpha
      for (let i = 0; i < MAX_SERIES; i++) {
        const slot = slots[i];
        if (i >= sCount) {
          slot.active = 0;
          slot.alpha = alphaLerp(slot.alpha, 0, SERIES_TOGGLE_SPEED, ratio);
          if (slot.alpha < 0.01) slot.alpha = 0;
          continue;
        }
        slot.active = 1;
        slot.color = sColors[i];
        slot.label = sLabels[i];

        // Visibility alpha: lerp toward 0 (hidden) or 1 (visible)
        const targetAlpha = isHidden(i) ? 0 : 1;
        slot.alpha = alphaLerp(
          slot.alpha,
          targetAlpha,
          SERIES_TOGGLE_SPEED,
          ratio,
        );
        if (slot.alpha < 0.01) slot.alpha = 0;
        if (slot.alpha > 0.99) slot.alpha = 1;

        // Smooth display value per series
        const liveVal = sCounts[i] > 0 ? sBufs[i][sCounts[i] * 2] : sValues[i];
        if (slot.displayValue === 0 && liveVal !== 0) {
          slot.displayValue = liveVal;
        } else {
          slot.displayValue = alphaLerp(
            slot.displayValue,
            liveVal,
            adaptiveSpeed,
            pausedRatio,
          );
        }
      }

      // Global range from all visible series
      let multiMin = Number.POSITIVE_INFINITY;
      let multiMax = Number.NEGATIVE_INFINITY;
      for (let i = 0; i < sCount; i++) {
        if (slots[i].alpha < 0.01) continue;
        const buf = sBufs[i];
        const cnt = sCounts[i];
        if (cnt === 0) continue;
        const first = findFirstPointIndexAtOrAfter(buf, cnt, start - 2);
        const last = findLastPointIndexAtOrBefore(buf, cnt, filterRight);
        const safeFirst = clampIndex(first, 0, cnt - 1);
        const safeLast = clampIndex(last, -1, cnt - 1);
        for (let j = safeFirst; j <= safeLast; j++) {
          const v = ptV(buf, j);
          if (v < multiMin) multiMin = v;
          if (v > multiMax) multiMax = v;
        }
        // Include live value
        const lv = slots[i].displayValue;
        if (lv < multiMin) multiMin = lv;
        if (lv > multiMax) multiMax = lv;
      }

      if (!Number.isFinite(multiMin) || !Number.isFinite(multiMax)) {
        multiMin = 0;
        multiMax = 1;
      }

      const multiRawRange = multiMax - multiMin;
      const multiMargin = exaggerate ? 0.01 : 0.12;
      const multiMinRange = Math.max(
        multiRawRange * (exaggerate ? 0.02 : 0.1),
        exaggerate ? 0.04 : 0.4,
      );
      let multiTargetMin: number;
      let multiTargetMax: number;
      if (multiRawRange < multiMinRange) {
        const mid = (multiMin + multiMax) / 2;
        multiTargetMin = mid - multiMinRange / 2;
        multiTargetMax = mid + multiMinRange / 2;
      } else {
        multiTargetMin = multiMin - multiRawRange * multiMargin;
        multiTargetMax = multiMax + multiRawRange * multiMargin;
      }

      if (multiSeriesRangeInitedSV.value === 0) {
        nextRangeMin = multiTargetMin;
        nextRangeMax = multiTargetMax;
        multiSeriesRangeInitedSV.value = 1;
      } else {
        const curRng = Math.max(1e-6, curRangeMax - curRangeMin);
        const snapTh = curRng * 0.5;
        nextRangeMin =
          multiTargetMin < curRangeMin && curRangeMin - multiTargetMin > snapTh
            ? multiTargetMin
            : curRangeMin + (multiTargetMin - curRangeMin) * alpha;
        nextRangeMax =
          multiTargetMax > curRangeMax && multiTargetMax - curRangeMax > snapTh
            ? multiTargetMax
            : curRangeMax + (multiTargetMax - curRangeMax) * alpha;
      }

      // Per-series path building
      const multiSpan = Math.max(1e-6, rightEdge - start);
      for (let i = 0; i < MAX_SERIES; i++) {
        const sp = seriesPathSVs[i].value;
        sp.rewind();
        if (i >= sCount || slots[i].alpha < 0.01) {
          seriesPathSVs[i].modify(undefined, true);
          continue;
        }
        const buf = sBufs[i];
        const cnt = sCounts[i];
        if (cnt === 0) {
          seriesPathSVs[i].modify(undefined, true);
          continue;
        }
        const first = findFirstPointIndexAtOrAfter(buf, cnt, start - 2);
        const last = findLastPointIndexAtOrBefore(buf, cnt, filterRight);
        const safeFirst = clampIndex(first, 0, cnt - 1);
        const safeLast = clampIndex(last, -1, cnt - 1);

        const seriesLiveX =
          padding.left + ((domainTarget - start) / multiSpan) * innerWidth;
        const seriesLiveY =
          padding.top +
          (1 - (slots[i].displayValue - rangeMin) / Math.max(rangeSpan, 1e-6)) *
            innerHeight;

        buildSmoothPathFromVisiblePoints(
          sp,
          buf,
          cnt,
          safeFirst,
          safeLast,
          start,
          multiSpan,
          innerWidth,
          innerHeight,
          rangeMin,
          rangeSpan,
          padding.left,
          padding.top,
          seriesLiveX,
          seriesLiveY,
          chartReveal,
          centerY,
          loadingAmplitude,
          loadingScroll,
          seriesSplineSVs[i].value,
        );
        seriesPathSVs[i].modify(undefined, true);

        // Per-series dot position
        slots[i].dotX =
          chartReveal < 1
            ? seriesLiveX +
              (padding.left + innerWidth - seriesLiveX) * (1 - chartReveal)
            : seriesLiveX;
        const clampedSeriesY = clamp(
          seriesLiveY,
          padding.top,
          padding.top + innerHeight,
        );
        if (chartReveal >= 1) {
          slots[i].dotY = clampedSeriesY;
        } else {
          const tipT = clamp(
            (slots[i].dotX - padding.left) / Math.max(innerWidth, 1e-6),
            0,
            1,
          );
          const baseY = loadingY(
            tipT,
            centerY,
            loadingAmplitude,
            loadingScroll,
          );
          slots[i].dotY = baseY + (clampedSeriesY - baseY) * chartReveal;
        }
      }
      seriesSlotsSV.modify(undefined, true);

      // Multi-crosshair
      if (hoverActiveSV.value || scrubAmountSV.value > 0) {
        let rightmostVisibleDotX = dotX;
        for (let i = 0; i < sCount; i++) {
          if (slots[i].alpha <= 0.01) continue;
          if (slots[i].dotX > rightmostVisibleDotX) {
            rightmostVisibleDotX = slots[i].dotX;
          }
        }

        // Build arrays for the worklet
        const mBufs: Float64Array[] = [];
        const mCounts: number[] = [];
        const mAlphas: number[] = [];
        const mColors: string[] = [];
        const mLabels: string[] = [];
        for (let i = 0; i < sCount; i++) {
          mBufs.push(sBufs[i]);
          mCounts.push(sCounts[i]);
          mAlphas.push(slots[i].alpha);
          mColors.push(sColors[i]);
          mLabels.push(sLabels[i]);
        }
        updateMultiCrosshairState(
          hoverXSV.value,
          mBufs,
          mCounts,
          mAlphas,
          mColors,
          mLabels,
          sCount,
          start,
          windowSecsNow,
          rangeMin,
          rangeSpan,
          padding.left,
          padding.top,
          innerWidth,
          innerHeight,
          rightmostVisibleDotX,
          scrubAmountSV.value,
          formatValueWorklet,
          formatTimeWorklet,
          formatCrosshairTimeWorklet,
          resolvedCrosshairTimeFormatPreset,
          multiCrosshairResultSV.value,
        );
        crosshairOpacitySV.value = multiCrosshairResultSV.value.opacity;
        multiCrosshairResultSV.modify(undefined, true);
      }
    } else {
      // Reset multi-series state when not in multi mode
      if (multiSeriesRangeInitedSV.value !== 0) {
        multiSeriesRangeInitedSV.value = 0;
        for (let i = 0; i < MAX_SERIES; i++) {
          seriesPathSVs[i].value.rewind();
          seriesPathSVs[i].modify(undefined, true);
        }
        activeSeriesCountSV.value = 0;
      }
    }

    // Build line + fill paths in the same frame callback as liveX/liveY,
    // matching the web's single-pass architecture. This eliminates the
    // one-frame desync between dot position and line tip that occurred
    // when paths were built in a separate useDerivedValue.
    const span = Math.max(1e-6, rightEdge - start);

    const linePath = linePathSV.value;
    linePath.rewind();
    const splineBuf = splineBufferSV.value;
    buildSmoothPathFromVisiblePoints(
      linePath,
      pts,
      ptsCount,
      visStart,
      visEnd,
      start,
      span,
      innerWidth,
      innerHeight,
      rangeMin,
      rangeSpan,
      padding.left,
      padding.top,
      liveX,
      liveY,
      chartReveal,
      centerY,
      loadingAmplitude,
      loadingScroll,
      splineBuf,
    );
    linePathSV.modify(undefined, true);

    if (showFill) {
      const fillPath = fillPathSV.value;
      fillPath.rewind();

      const fillMaxIdx = ptsCount - 1;
      const firstSafe = clampIndex(visStart, 0, fillMaxIdx);
      const lastSafe = clampIndex(visEnd, -1, fillMaxIdx);
      const visibleCount = firstSafe <= lastSafe ? lastSafe - firstSafe + 1 : 0;

      let firstX = padding.left;
      if (visibleCount > 0 && firstSafe < ptsCount) {
        firstX =
          padding.left + ((ptT(pts, firstSafe) - start) / span) * innerWidth;
      }

      const chartRight = padding.left + innerWidth;
      const tipX =
        chartReveal < 1
          ? liveX + (chartRight - liveX) * (1 - chartReveal)
          : liveX;
      const lastX = visibleCount === 0 ? chartRight : tipX;

      // Match web: start fill path at bottom-left so close() draws a
      // horizontal line along the bottom (invisible) instead of a
      // vertical line up the left edge (visible anti-aliased artifact).
      const bottomY = height - padding.bottom;
      fillPath.moveTo(firstX, bottomY);

      const fillBuf = fillSplineBufferSV.value;
      buildSmoothPathFromVisiblePoints(
        fillPath,
        pts,
        ptsCount,
        firstSafe,
        lastSafe,
        start,
        span,
        innerWidth,
        innerHeight,
        rangeMin,
        rangeSpan,
        padding.left,
        padding.top,
        liveX,
        liveY,
        chartReveal,
        centerY,
        loadingAmplitude,
        loadingScroll,
        fillBuf,
        true,
      );

      buildFillFromLinePath(fillPath, firstX, lastX, bottomY);
      fillPathSV.modify(undefined, true);
    } else {
      rewindPath(fillPathSV);
    }

    // Build current-price dashed line inside the frame callback (not a
    // separate usePathValue) so it uses the same liveY as the line tip.
    // A derived-value path would lag by one frame, creating ghosting.
    const clPath = currentLinePathSV.value;
    clPath.rewind();
    if (innerWidth > 0 && innerHeight > 0) {
      clPath.moveTo(padding.left, clampedLiveY);
      clPath.lineTo(padding.left + innerWidth, clampedLiveY);
    }
    currentLinePathSV.modify(undefined, true);

    // ── Build auxiliary paths using snapshot locals ─────────────────
    // These were previously usePathValue / useDerivedValue in Liveline.tsx
    // which evaluated AFTER the frame callback commit, reading post-COMMIT
    // rangeMin/rangeMax and causing one-frame drift (ghosting).

    // Reference line path
    const refPath = referencePathSV.value;
    refPath.rewind();
    if (
      referenceLine &&
      Number.isFinite(referenceLine.value) &&
      width > 0 &&
      height > 0
    ) {
      const refY =
        padding.top +
        (1 - (referenceLine.value - rangeMin) / rangeSpan) * innerHeight;
      const rLeft = padding.left;
      const rRight = width - padding.right;
      const hasLabel = !!referenceLine.label && referenceLabelWidth > 0;
      if (!hasLabel) {
        refPath.moveTo(rLeft, refY);
        refPath.lineTo(rRight, refY);
      } else {
        const rCenter = rLeft + (rRight - rLeft) * 0.5;
        const gapPad = 8;
        const gapLeft = rCenter - referenceLabelWidth * 0.5 - gapPad;
        const gapRight = rCenter + referenceLabelWidth * 0.5 + gapPad;
        refPath.moveTo(rLeft, refY);
        refPath.lineTo(Math.max(rLeft, gapLeft), refY);
        refPath.moveTo(Math.min(rRight, gapRight), refY);
        refPath.lineTo(rRight, refY);
      }
    }
    referencePathSV.modify(undefined, true);

    // Reference label Y + opacity
    if (referenceLine && Number.isFinite(referenceLine.value)) {
      referenceLabelYSV.value =
        padding.top +
        (1 - (referenceLine.value - rangeMin) / rangeSpan) * innerHeight +
        4;
      referenceLabelOpacitySV.value = chartReveal;
    } else {
      referenceLabelYSV.value = -1000;
      referenceLabelOpacitySV.value = 0;
    }

    // Hover vertical line
    const hlPath = hoverLinePathSV.value;
    hlPath.rewind();
    if (scrub && crosshairOpacitySV.value > 0.01 && width > 0 && height > 0) {
      const hx = clamp(hoverXSV.value, padding.left, width - padding.right);
      hlPath.moveTo(hx, padding.top);
      hlPath.lineTo(hx, height - padding.bottom);
    }
    hoverLinePathSV.modify(undefined, true);

    // Momentum chevron arrows (web parity: never render in candle mode)
    if (showMomentum && !isCandleNow) {
      const chevronBaseX = dotX + 19;
      const chevronDotY = dotYSV.value;

      const uc0 = arrowUpChevron0SV.value;
      uc0.rewind();
      const uc0y = chevronDotY + -1 * (0 * 8 - 4);
      uc0.moveTo(chevronBaseX - 5, uc0y + -1 * 3);
      uc0.lineTo(chevronBaseX, uc0y - -1 * 2);
      uc0.lineTo(chevronBaseX + 5, uc0y + -1 * 3);
      arrowUpChevron0SV.modify(undefined, true);

      const uc1 = arrowUpChevron1SV.value;
      uc1.rewind();
      const uc1y = chevronDotY + -1 * (1 * 8 - 4);
      uc1.moveTo(chevronBaseX - 5, uc1y + -1 * 3);
      uc1.lineTo(chevronBaseX, uc1y - -1 * 2);
      uc1.lineTo(chevronBaseX + 5, uc1y + -1 * 3);
      arrowUpChevron1SV.modify(undefined, true);

      const dc0 = arrowDownChevron0SV.value;
      dc0.rewind();
      const dc0y = chevronDotY + 1 * (0 * 8 - 4);
      dc0.moveTo(chevronBaseX - 5, dc0y + 1 * 3);
      dc0.lineTo(chevronBaseX, dc0y - 1 * 2);
      dc0.lineTo(chevronBaseX + 5, dc0y + 1 * 3);
      arrowDownChevron0SV.modify(undefined, true);

      const dc1 = arrowDownChevron1SV.value;
      dc1.rewind();
      const dc1y = chevronDotY + 1 * (1 * 8 - 4);
      dc1.moveTo(chevronBaseX - 5, dc1y + 1 * 3);
      dc1.lineTo(chevronBaseX, dc1y - 1 * 2);
      dc1.lineTo(chevronBaseX + 5, dc1y + 1 * 3);
      arrowDownChevron1SV.modify(undefined, true);
    } else {
      rewindPath(arrowUpChevron0SV);
      rewindPath(arrowUpChevron1SV);
      rewindPath(arrowDownChevron0SV);
      rewindPath(arrowDownChevron1SV);
    }

    // Badge pill path
    const bp = badgePathSV.value;
    bp.rewind();
    if (showBadge && width > 0) {
      const badgeH = BADGE_LINE_H + BADGE_PAD_Y * 2;
      const tailLen = badgeTail ? BADGE_TAIL_LEN : 0;
      const pillW = Math.max(1, badgeWidthSV.value) + BADGE_PAD_X * 2;
      const bLeft = width - padding.right + 8 - BADGE_PAD_X - tailLen;
      const bCenterY = badgeYSV.value > 0 ? badgeYSV.value : dotYSV.value;
      const bTop = bCenterY - badgeH / 2;
      createBadgePath(
        bp,
        bLeft,
        bTop,
        pillW,
        badgeH,
        tailLen,
        BADGE_TAIL_SPREAD,
      );
    }
    badgePathSV.modify(undefined, true);

    // 4. COMMIT — write next-frame state to SVs after all rendering.
    displayValueSV.value = nextDisplay;
    rangeMinSV.value = nextRangeMin;
    rangeMaxSV.value = nextRangeMax;
  });

  const loadingLinePathSV = usePathValue((path) => {
    "worklet";
    path.rewind();
    if (chartRevealSV.value >= 1) return;
    const width = layoutWidthSV.value;
    const height = layoutHeightSV.value;
    const chartWidth = Math.max(1, width - padding.left - padding.right);
    const chartHeight = Math.max(1, height - padding.top - padding.bottom);
    if (width <= 0 || height <= 0) return;

    const centerY = padding.top + chartHeight / 2;
    const amplitude = Math.max(2, chartHeight * LOADING_AMPLITUDE_RATIO);
    const scroll = clockNowMsSV.value * LOADING_SCROLL_SPEED;

    const count = 32;
    const n = count + 1;
    const buf = loadingSplineBufferSV.value;
    const xs = buf.xs;
    const ys = buf.ys;
    for (let i = 0; i < n; i += 1) {
      const t = i / count;
      xs[i] = padding.left + t * chartWidth;
      ys[i] = loadingY(t, centerY, amplitude, scroll);
    }

    path.moveTo(xs[0], ys[0]);
    if (n < 3) {
      for (let i = 1; i < n; i += 1) path.lineTo(xs[i], ys[i]);
      return;
    }

    // Fritsch-Carlson: compute tangents using pre-allocated buffers
    const EPS = 1e-6;
    const m = buf.m;
    const d = buf.delta;
    const h = buf.h;
    for (let i = 0; i < n - 1; i += 1) {
      h[i] = xs[i + 1] - xs[i];
      d[i] = Math.abs(h[i]) < EPS ? 0 : (ys[i + 1] - ys[i]) / h[i];
    }
    m[0] = d[0];
    m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i += 1) {
      m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    }
    for (let i = 0; i < n - 1; i += 1) {
      if (d[i] === 0) {
        m[i] = 0;
        m[i + 1] = 0;
      } else {
        const alpha = m[i] / d[i];
        const beta = m[i + 1] / d[i];
        const s2 = alpha * alpha + beta * beta;
        if (s2 > 9) {
          const s = 3 / Math.sqrt(s2);
          m[i] = s * alpha * d[i];
          m[i + 1] = s * beta * d[i];
        }
      }
    }

    for (let i = 0; i < n - 1; i += 1) {
      const hi = h[i];
      path.cubicTo(
        xs[i] + hi / 3,
        ys[i] + (m[i] * hi) / 3,
        xs[i + 1] - hi / 3,
        ys[i + 1] - (m[i + 1] * hi) / 3,
        xs[i + 1],
        ys[i + 1],
      );
    }
  }, Skia.Path.Make());

  return {
    pointsBufSV,
    displayValueSV,
    displayWindowSecsSV,
    rangeMinSV,
    rangeMaxSV,
    visibleStartIndexSV,
    visibleEndIndexSV,
    domainEndSV,

    linePathSV,
    fillPathSV,
    oldLinePathSV,
    oldFillPathSV,
    currentLinePathSV,
    loadingLinePathSV,
    badgePathSV,
    referencePathSV,
    referenceLabelYSV,
    referenceLabelOpacitySV,
    hoverLinePathSV,
    arrowUpChevron0SV,
    arrowUpChevron1SV,
    arrowDownChevron0SV,
    arrowDownChevron1SV,

    dotXSV,
    dotYSV,
    pulseRadiusSV,
    pulseOpacitySV,

    momentumDirSV,
    badgeColorMixSV,
    arrowUpOpacitySV,
    arrowDownOpacitySV,
    arrowCycleSV,

    badgeTextSV,
    badgeWidthSV,
    badgeYSV,

    valueTextSV,
    changeTextSV,
    changeSignSV,

    hoverActiveSV,
    hoverXSV,
    hoverYSV,
    hoverValueSV,
    hoverTimeSecSV,
    hoverValueTextSV,
    hoverTimeTextSV,
    scrubAmountSV,
    crosshairOpacitySV,

    chartRevealSV,
    dataTransitionProgressSV,
    loadingAlphaSV,
    loadingBreathSV,
    pauseProgressSV,

    gridSlotsSV,
    timeSlotsSV,
    orderbookLabelsSV,
    particlePathHighSV,
    particlePathMidSV,
    particlePathLowSV,
    shakeXSV,
    shakeYSV,

    // Candle mode
    candleBullPathSV,
    candleBearPathSV,
    candleBullWickPathSV,
    candleBearWickPathSV,
    candleLiveGlowPathSV,
    closePricePathSV,
    lineModeProgressSV,
    liveBirthAlphaSV,
    liveBullBlendSV,
    candleGlowPulseSV,
    candleCrosshairOSV,
    candleCrosshairHSV,
    candleCrosshairLSV,
    candleCrosshairCSV,
    candleCrosshairTimeSV,
    candleCrosshairBullSV,
    candleWidthMorphTSV,
    oldCandleBullPathSV,
    oldCandleBearPathSV,
    oldCandleBullWickPathSV,
    oldCandleBearWickPathSV,

    // Multi-series mode
    seriesPath0SV,
    seriesPath1SV,
    seriesPath2SV,
    seriesPath3SV,
    seriesPath4SV,
    seriesPath5SV,
    seriesPath6SV,
    seriesPath7SV,
    seriesSlotsSV,
    activeSeriesCountSV,
    multiCrosshairResultSV,
  };
}
