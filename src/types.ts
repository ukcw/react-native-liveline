import type { ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";

export type Momentum = "up" | "down" | "flat";
export type ThemeMode = "light" | "dark";
export type BadgeVariant = "default" | "minimal";
export type WindowStyle = "default" | "rounded" | "text";
export type WindowPosition = "left" | "right" | "bottom";
export type TimeFormatPreset =
  | "auto"
  | "intraday"
  | "swing"
  | "dateOnly"
  | "dateTime";
export type ValueDisplayMode = "latest" | "hover";
export type DataTransitionMode =
  | "none"
  | "loadingBridge";

export interface LivelinePoint {
  time: number;
  value: number;
}

export interface CandlePoint {
  time: number; // unix seconds — candle open time
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface WindowOption {
  label: string;
  secs: number;
}

export interface LivelineWindowControlsRenderProps {
  windows: WindowOption[];
  activeWindowSecs: number;
  onWindowChange: (secs: number) => void;
  isDark: boolean;
  windowStyle: WindowStyle;
  windowPosition: WindowPosition;
}

export interface ReferenceLine {
  value: number;
  label?: string;
}

export interface OrderbookData {
  bids: [price: number, size: number][];
  asks: [price: number, size: number][];
}

export interface HoverPoint {
  x: number;
  y: number;
  time: number;
  value: number;
}

export interface Padding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface LivelineSeries {
  id: string;
  data: LivelinePoint[];
  value: number;
  color: string;
  label?: string;
}

export interface DegenOptions {
  scale?: number;
  downMomentum?: boolean;
  // Back-compat with earlier RN API; scale takes precedence when present.
  shake?: number;
  particles?: number;
}

export interface LivelineProps {
  data: LivelinePoint[];
  value: number;

  theme?: ThemeMode;
  color?: string;
  grid?: boolean;
  badge?: boolean;
  badgeVariant?: BadgeVariant;
  badgeTail?: boolean;
  fill?: boolean;
  pulse?: boolean;

  momentum?: boolean | Momentum;
  scrub?: boolean;
  loading?: boolean;
  paused?: boolean;
  emptyText?: string;
  exaggerate?: boolean;
  showValue?: boolean;
  showChange?: boolean;
  /**
   * Controls what the top value/change readout tracks while scrubbing.
   * - "latest": always show live/latest value (web parity)
   * - "hover": show hovered value while touch/drag is active
   */
  valueDisplayMode?: ValueDisplayMode;
  /**
   * Controls how the engine handles abrupt dataset replacements (for example,
   * switching between different candle intervals).
   * - "none": swap immediately
   * - "loadingBridge": route through loading choreography (old -> loading -> new)
   */
  dataTransition?: DataTransitionMode;
  dataTransitionDurationMs?: number;
  dataTransitionKey?: number;
  valueMomentumColor?: boolean;
  degen?: boolean | DegenOptions;

  window?: number;
  windows?: WindowOption[];
  onWindowChange?: (secs: number) => void;
  windowStyle?: WindowStyle;
  windowPosition?: WindowPosition;
  renderWindowControls?: (
    props: LivelineWindowControlsRenderProps,
  ) => ReactNode;

  tooltipY?: number;
  tooltipOutline?: boolean;

  orderbook?: OrderbookData;

  referenceLine?: ReferenceLine;
  formatValue?: (v: number) => string;
  // Legacy JS-thread formatter (kept for web parity/backward compatibility).
  // Native rendering uses worklet formatters.
  formatTime?: (t: number) => string;
  formatValueWorklet?: (v: number) => string;
  // Legacy worklet formatter used for both axis + crosshair surfaces.
  formatTimeWorklet?: (t: number) => string;
  // First-class formatting configuration.
  timeFormatPreset?: TimeFormatPreset;
  axisTimeFormatPreset?: TimeFormatPreset;
  crosshairTimeFormatPreset?: TimeFormatPreset;
  formatAxisTimeWorklet?: (
    tMs: number,
    windowSecs: number,
    intervalSecs: number,
  ) => string;
  formatCrosshairTimeWorklet?: (tMs: number, windowSecs: number) => string;
  lerpSpeed?: number;
  padding?: Padding;
  // UI-thread callback. Must be a worklet function when provided.
  onHoverWorklet?: (point: HoverPoint | null) => void;
  cursor?: string;

  mode?: "line" | "candle";
  candles?: CandlePoint[];
  candleWidth?: number; // seconds per candle
  liveCandle?: CandlePoint; // current live candle with real-time OHLC
  lineMode?: boolean; // morph candles into line display
  lineData?: LivelinePoint[]; // tick-level data for density transition
  lineValue?: number; // current tick value
  onModeChange?: (mode: "line" | "candle") => void;

  // Multi-series mode — overrides data/value/color when provided
  series?: LivelineSeries[];
  onSeriesToggle?: (id: string, visible: boolean) => void;
  seriesToggleCompact?: boolean;

  className?: string;
  style?: StyleProp<ViewStyle>;
}

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface HSL {
  h: number;
  s: number;
  l: number;
}

export interface Palette {
  line: string;
  lineSoft: string;
  fillTop: string;
  fillBottom: string;
  dot: string;
  glow: string;
  grid: string;
  gridLine: string;
  label: string;
  gridLabel: string;
  timeLabel: string;
  tooltipBg: string;
  tooltipText: string;
  tooltipBorder: string;
  crosshairLine: string;
  badgeOuterBg: string;
  badgeOuterShadow: string;
  badgeBg: string;
  badgeText: string;
  positive: string;
  negative: string;
  neutral: string;
  overlay: string;
  overlaySubtle: string;
  referenceLine: string;
  referenceLabelBg: string;
  referenceLabelText: string;
}
