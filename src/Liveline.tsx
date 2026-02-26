import { memo, useMemo, useState, useRef } from "react";
import {
  LayoutChangeEvent,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  Canvas,
  Circle,
  DashPathEffect,
  Group,
  LinearGradient,
  matchFont,
  rect,
  Path,
  Rect,
  Skia,
  Text as SkiaText,
  usePathValue,
  vec,
} from "@shopify/react-native-skia";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedProps,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";

import { derivePalette } from "./theme";
import type {
  DegenOptions,
  LivelineProps,
  LivelineWindowControlsRenderProps,
  Momentum,
  Padding,
  WindowOption,
  WindowStyle,
} from "./types";
import { BADGE_LINE_H, BADGE_PAD_Y } from "./draw/badge";
import {
  BULL_COLOR,
  BEAR_COLOR,
  BULL_R,
  BULL_G,
  BULL_B,
  BEAR_R,
  BEAR_G,
  BEAR_B,
  blendBullBear,
} from "./draw/candlestick";
import {
  MAX_ORDERBOOK_LABELS,
  type OrderbookLabelSlot,
} from "./draw/orderbook";
import { LOADING_AMPLITUDE_RATIO } from "./draw/loadingShape";
import {
  MAX_GRID_LABELS,
  MAX_TIME_LABELS,
  useLivelineEngine,
} from "./useLivelineEngine";

const AnimatedTextInput = Animated.createAnimatedComponent(TextInput);
Animated.addWhitelistedNativeProps({ text: true, value: true });

const DEFAULT_PADDING: Required<Padding> = {
  top: 12,
  right: 80,
  bottom: 28,
  left: 12,
};

const Y_LABEL_SLOTS = MAX_GRID_LABELS;
const X_LABEL_SLOTS = MAX_TIME_LABELS;
const AXIS_FONT_SIZE = 10;
const BADGE_HEIGHT = BADGE_LINE_H + BADGE_PAD_Y * 2;
const LAYOUT_EPSILON = 0.5;

interface GridSlot {
  key: number;
  y: number;
  value: number;
  text: string;
  alpha: number;
}

interface TimeSlot {
  key: number;
  x: number;
  tSec: number;
  text: string;
  alpha: number;
  renderAlpha: number;
}

const defaultFormatValue = (v: number) => v.toFixed(2);
const defaultFormatTime = (tMs: number) => {
  const d = new Date(tMs);
  const hh = `${d.getHours()}`.padStart(2, "0");
  const mm = `${d.getMinutes()}`.padStart(2, "0");
  const ss = `${d.getSeconds()}`.padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
};

function clamp(n: number, min: number, max: number) {
  "worklet";
  return Math.min(max, Math.max(min, n));
}

function parseRgb(color: string): { r: number; g: number; b: number } {
  const hex = color.trim();
  if (hex.startsWith("#")) {
    const v = hex.slice(1);
    const full =
      v.length === 3
        ? `${v[0]}${v[0]}${v[1]}${v[1]}${v[2]}${v[2]}`
        : v.length === 6
          ? v
          : "ffffff";
    const int = Number.parseInt(full, 16);
    if (Number.isFinite(int)) {
      return {
        r: (int >> 16) & 255,
        g: (int >> 8) & 255,
        b: int & 255,
      };
    }
  }

  const m = color.match(
    /rgba?\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)/i,
  );
  if (m) {
    return {
      r: Number(m[1]) || 255,
      g: Number(m[2]) || 255,
      b: Number(m[3]) || 255,
    };
  }

  return { r: 255, g: 255, b: 255 };
}

/**
 * Cached rgb string builder — only allocates a new string when the integer
 * r,g,b values actually change from the previous call. During steady-state
 * momentum lerps the rounded values often repeat frame-to-frame.
 */
interface RgbCache {
  r: number;
  g: number;
  b: number;
  str: string;
}

function createRgbCache(): RgbCache {
  return { r: -1, g: -1, b: -1, str: "rgb(0,0,0)" };
}

function rgbCached(cache: RgbCache, r: number, g: number, b: number): string {
  "worklet";
  if (r === cache.r && g === cache.g && b === cache.b) {
    return cache.str;
  }
  cache.r = r;
  cache.g = g;
  cache.b = b;
  cache.str = `rgb(${r},${g},${b})`;
  return cache.str;
}

interface AxisYLabelProps {
  index: number;
  slotsSV: SharedValue<GridSlot[]>;
  color: string;
  x: number;
  font: ReturnType<typeof matchFont>;
}

const AxisYLabel = memo(function AxisYLabel({
  index,
  slotsSV,
  color,
  x,
  font,
}: AxisYLabelProps) {
  const text = useDerivedValue(() => {
    "worklet";
    const slot = slotsSV.value[index];
    return slot?.text ?? "";
  }, [index]);

  const y = useDerivedValue(() => {
    "worklet";
    const slot = slotsSV.value[index];
    if (!slot) {
      return -1000;
    }
    // Match web canvas text baseline offset: fillText(..., y + 4)
    return slot.y + 4;
  }, [index]);

  const opacity = useDerivedValue(() => {
    "worklet";
    const slot = slotsSV.value[index];
    return slot?.alpha ?? 0;
  }, [index]);

  return (
    <SkiaText
      x={x}
      y={y}
      text={text}
      font={font}
      color={color}
      opacity={opacity}
    />
  );
});

interface AxisXLabelProps {
  index: number;
  slotsSV: SharedValue<TimeSlot[]>;
  color: string;
  tickColor: string;
  bottomY: number;
  leftBound: number;
  rightBound: number;
  charWidth: number;
  font: ReturnType<typeof matchFont>;
}

const AxisXLabel = memo(function AxisXLabel({
  index,
  slotsSV,
  color,
  tickColor,
  bottomY,
  leftBound,
  rightBound,
  charWidth,
  font,
}: AxisXLabelProps) {
  const width = 58;

  const text = useDerivedValue(() => {
    "worklet";
    const slot = slotsSV.value[index];
    return slot?.text ?? "";
  }, [index]);

  const x = useDerivedValue(() => {
    "worklet";
    const slot = slotsSV.value[index];
    if (!slot) {
      return -1000;
    }

    // Center text on tick — no edge clamping so labels scroll off
    // naturally (matching web). The edge fade in updateTimeSlots
    // handles the disappearing.
    const estTextW = slot.text.length * Math.max(4, charWidth);
    return slot.x - estTextW * 0.5;
  }, [charWidth, index]);

  const y = useDerivedValue(() => bottomY + 14, [bottomY]);

  const opacity = useDerivedValue(() => {
    "worklet";
    const slot = slotsSV.value[index];
    return slot?.renderAlpha ?? 0;
  }, [index]);

  const tickPathSV = usePathValue((path) => {
    "worklet";
    path.rewind();
    const slot = slotsSV.value[index];
    if (!slot || slot.renderAlpha <= 0.01) return;
    path.moveTo(slot.x, bottomY);
    path.lineTo(slot.x, bottomY + 5);
  }, Skia.Path.Make());

  return (
    <>
      <Path
        path={tickPathSV}
        style="stroke"
        strokeWidth={1}
        color={tickColor}
        opacity={opacity}
      />
      <SkiaText
        x={x}
        y={y}
        text={text}
        font={font}
        color={color}
        opacity={opacity}
      />
    </>
  );
});

interface BadgeValueTextProps {
  badgeTextSV: SharedValue<string>;
  badgeYSV: SharedValue<number>;
  dotYSV: SharedValue<number>;
  opacitySV: SharedValue<number>;
  x: number;
  baselineOffset: number;
  color: string;
  font: ReturnType<typeof matchFont>;
}

const BadgeValueText = memo(function BadgeValueText({
  badgeTextSV,
  badgeYSV,
  dotYSV,
  opacitySV,
  x,
  baselineOffset,
  color,
  font,
}: BadgeValueTextProps) {
  const text = useDerivedValue(() => {
    "worklet";
    return badgeTextSV.value;
  });

  const y = useDerivedValue(() => {
    "worklet";
    const centerY = badgeYSV.value > 0 ? badgeYSV.value : dotYSV.value;
    return centerY - BADGE_HEIGHT * 0.5 + baselineOffset;
  });

  const opacity = useDerivedValue(() => {
    "worklet";
    return opacitySV.value;
  });

  return (
    <SkiaText
      x={x}
      y={y}
      text={text}
      font={font}
      color={color}
      opacity={opacity}
    />
  );
});

interface GridLineProps {
  index: number;
  slotsSV: SharedValue<GridSlot[]>;
  left: number;
  right: number;
  color: string;
}

const GridLine = memo(function GridLine({
  index,
  slotsSV,
  left,
  right,
  color,
}: GridLineProps) {
  const pathSV = usePathValue((path) => {
    "worklet";
    path.rewind();
    const slot = slotsSV.value[index];
    if (!slot || slot.alpha <= 0.01) return;
    path.moveTo(left, slot.y);
    path.lineTo(right, slot.y);
  }, Skia.Path.Make());

  const opacity = useDerivedValue(() => {
    "worklet";
    const slot = slotsSV.value[index];
    return slot?.alpha ?? 0;
  }, [index]);

  return (
    <Path
      path={pathSV}
      style="stroke"
      strokeWidth={1}
      color={color}
      opacity={opacity}
    >
      <DashPathEffect intervals={[1, 3]} />
    </Path>
  );
});

interface CrosshairTopLabelProps {
  crosshairOpacitySV: SharedValue<number>;
  hoverXSV: SharedValue<number>;
  liveDotXSV: SharedValue<number>;
  hoverValueTextSV: SharedValue<string>;
  hoverTimeTextSV: SharedValue<string>;
  leftBound: number;
  rightBound: number;
  top: number;
  textColor: string;
  dividerColor: string;
  outlineColor: string;
  tooltipOutline: boolean;
  charWidth: number;
  separatorWidth: number;
  font: ReturnType<typeof matchFont>;
}

const CrosshairTopLabel = memo(function CrosshairTopLabel({
  crosshairOpacitySV,
  hoverXSV,
  liveDotXSV,
  hoverValueTextSV,
  hoverTimeTextSV,
  leftBound,
  rightBound,
  top,
  textColor,
  dividerColor,
  outlineColor,
  tooltipOutline,
  charWidth,
  separatorWidth,
  font,
}: CrosshairTopLabelProps) {
  const separator = "  ·  ";
  const minWidth = 200;

  const opacity = useDerivedValue(() => {
    "worklet";
    const o = crosshairOpacitySV.value;
    if (o < 0.1 || rightBound - leftBound < minWidth) return 0;
    return o;
  }, [leftBound, rightBound]);

  const valueText = useDerivedValue(() => {
    "worklet";
    return hoverValueTextSV.value;
  });
  const timeText = useDerivedValue(() => {
    "worklet";
    return hoverTimeTextSV.value;
  });

  const baseX = useDerivedValue(() => {
    "worklet";
    const valueW = hoverValueTextSV.value.length * charWidth;
    const sepW = separatorWidth;
    const timeW = hoverTimeTextSV.value.length * charWidth;
    const totalW = valueW + sepW + timeW;
    const minX = leftBound + 4;
    const maxX = Math.max(minX, liveDotXSV.value + 7 - totalW);
    return clamp(hoverXSV.value - totalW * 0.5, minX, maxX);
  }, [charWidth, leftBound, separatorWidth]);

  const sepX = useDerivedValue(() => {
    "worklet";
    return baseX.value + hoverValueTextSV.value.length * charWidth;
  }, [charWidth]);

  const timeX = useDerivedValue(() => {
    "worklet";
    return sepX.value + separatorWidth;
  }, [separatorWidth]);

  const y = useDerivedValue(() => {
    "worklet";
    return top + 10;
  }, [top]);

  return (
    <>
      {tooltipOutline ? (
        <>
          <SkiaText
            x={baseX}
            y={y}
            text={valueText}
            font={font}
            style="stroke"
            strokeWidth={3}
            color={outlineColor}
            opacity={opacity}
          />
          <SkiaText
            x={sepX}
            y={y}
            text={separator}
            font={font}
            style="stroke"
            strokeWidth={3}
            color={outlineColor}
            opacity={opacity}
          />
          <SkiaText
            x={timeX}
            y={y}
            text={timeText}
            font={font}
            style="stroke"
            strokeWidth={3}
            color={outlineColor}
            opacity={opacity}
          />
        </>
      ) : null}

      <SkiaText
        x={baseX}
        y={y}
        text={valueText}
        font={font}
        color={textColor}
        opacity={opacity}
      />
      <SkiaText
        x={sepX}
        y={y}
        text={separator}
        font={font}
        color={dividerColor}
        opacity={opacity}
      />
      <SkiaText
        x={timeX}
        y={y}
        text={timeText}
        font={font}
        color={dividerColor}
        opacity={opacity}
      />
    </>
  );
});

// ── Candle OHLC crosshair tooltip ──────────────────────────────────

interface CandleCrosshairLabelProps {
  crosshairOpacitySV: SharedValue<number>;
  lineModeProgressSV: SharedValue<number>;
  hoverXSV: SharedValue<number>;
  liveDotXSV: SharedValue<number>;
  oSV: SharedValue<string>;
  hSV: SharedValue<string>;
  lSV: SharedValue<string>;
  cSV: SharedValue<string>;
  timeSV: SharedValue<string>;
  bullSV: SharedValue<number>;
  leftBound: number;
  rightBound: number;
  top: number;
  labelColor: string;
  lineColor: string;
  outlineColor: string;
  tooltipOutline: boolean;
  charWidth: number;
  font: ReturnType<typeof matchFont>;
}

const CandleCrosshairLabel = memo(function CandleCrosshairLabel({
  crosshairOpacitySV,
  lineModeProgressSV,
  hoverXSV,
  liveDotXSV,
  oSV,
  hSV,
  lSV,
  cSV,
  timeSV,
  bullSV,
  leftBound,
  rightBound,
  top,
  labelColor,
  lineColor,
  outlineColor,
  tooltipOutline,
  charWidth,
  font,
}: CandleCrosshairLabelProps) {
  const minWidth = 200;

  const opacity = useDerivedValue(() => {
    "worklet";
    const o = crosshairOpacitySV.value;
    if (o < 0.1 || rightBound - leftBound < minWidth) return 0;
    return o;
  }, [leftBound, rightBound]);

  // Use condensed format (C only) when chart is narrow
  const isWide = rightBound - leftBound >= 400;

  // Build text segments:
  // Candle mode (lineModeProg <= 0.5): "O 123  H 456  L 78  C 90  ·  12:34:56"
  //   or condensed: "C 90  ·  12:34:56"
  // Line mode (lineModeProg > 0.5): "90  ·  12:34:56" (just value + time, web pattern)
  const fullText = useDerivedValue(() => {
    "worklet";
    // When in line mode during candle morph, show simple value + time (web: drawLineModeCrosshair)
    if (lineModeProgressSV.value > 0.5) {
      return cSV.value;
    }
    if (isWide) {
      return (
        "O " +
        oSV.value +
        "  H " +
        hSV.value +
        "  L " +
        lSV.value +
        "  C " +
        cSV.value
      );
    }
    return "C " + cSV.value;
  }, [isWide]);

  const sep = "  ·  ";

  const timeText = useDerivedValue(() => {
    "worklet";
    return timeSV.value;
  });

  // Compute baseX to center the full tooltip on hoverX
  const baseX = useDerivedValue(() => {
    "worklet";
    const ohlcW = fullText.value.length * charWidth;
    const sepW = sep.length * charWidth;
    const timeW = timeSV.value.length * charWidth;
    const totalW = ohlcW + sepW + timeW;
    const minX = leftBound + 4;
    const maxX = Math.max(minX, liveDotXSV.value + 7 - totalW);
    return Math.min(Math.max(hoverXSV.value - totalW * 0.5, minX), maxX);
  }, [charWidth, leftBound]);

  const sepX = useDerivedValue(() => {
    "worklet";
    return baseX.value + fullText.value.length * charWidth;
  }, [charWidth]);

  const timeX = useDerivedValue(() => {
    "worklet";
    return sepX.value + sep.length * charWidth;
  }, [charWidth]);

  const y = useDerivedValue(() => {
    "worklet";
    return top + 10;
  }, [top]);

  const valueColor = useDerivedValue(() => {
    "worklet";
    // Web: line mode crosshair uses palette.line color for value
    if (lineModeProgressSV.value > 0.5) return lineColor;
    return bullSV.value >= 0.5 ? BULL_COLOR : BEAR_COLOR;
  });

  return (
    <>
      {tooltipOutline ? (
        <>
          <SkiaText
            x={baseX}
            y={y}
            text={fullText}
            font={font}
            style="stroke"
            strokeWidth={3}
            color={outlineColor}
            opacity={opacity}
          />
          <SkiaText
            x={sepX}
            y={y}
            text={sep}
            font={font}
            style="stroke"
            strokeWidth={3}
            color={outlineColor}
            opacity={opacity}
          />
          <SkiaText
            x={timeX}
            y={y}
            text={timeText}
            font={font}
            style="stroke"
            strokeWidth={3}
            color={outlineColor}
            opacity={opacity}
          />
        </>
      ) : null}

      <SkiaText
        x={baseX}
        y={y}
        text={fullText}
        font={font}
        color={valueColor}
        opacity={opacity}
      />
      <SkiaText
        x={sepX}
        y={y}
        text={sep}
        font={font}
        color={labelColor}
        opacity={opacity}
      />
      <SkiaText
        x={timeX}
        y={y}
        text={timeText}
        font={font}
        color={labelColor}
        opacity={opacity}
      />
    </>
  );
});

interface MultiCrosshairTopLabelProps {
  crosshairOpacitySV: SharedValue<number>;
  hoverXSV: SharedValue<number>;
  liveDotXSV: SharedValue<number>;
  multiCrosshairResultSV: SharedValue<
    import("./draw/crosshair").MultiCrosshairResult
  >;
  leftBound: number;
  rightBound: number;
  top: number;
  textColor: string;
  outlineColor: string;
  tooltipOutline: boolean;
  charWidth: number;
  font: ReturnType<typeof matchFont>;
}

const MultiCrosshairTopLabel = memo(function MultiCrosshairTopLabel({
  crosshairOpacitySV,
  hoverXSV,
  liveDotXSV,
  multiCrosshairResultSV,
  leftBound,
  rightBound,
  top,
  textColor,
  outlineColor,
  tooltipOutline,
  charWidth,
  font,
}: MultiCrosshairTopLabelProps) {
  const minWidth = 220;

  const text = useDerivedValue(() => {
    "worklet";
    const result = multiCrosshairResultSV.value;
    let out = result.timeText;
    for (let i = 0; i < result.entryCount; i += 1) {
      const entry = result.entries[i];
      const label = entry?.label ? `${entry.label} ` : "";
      out += `  ·  ${label}${entry?.valueText ?? ""}`;
    }
    return out;
  });

  const x = useDerivedValue(() => {
    "worklet";
    const result = multiCrosshairResultSV.value;
    // Match web behavior: reserve inline-dot width for each series entry
    // and use a slightly conservative char estimate to avoid right-edge spill.
    const width =
      text.value.length * charWidth * 1.06 + result.entryCount * 12;
    const minX = leftBound + 4;
    const dotRightEdge = liveDotXSV.value + 7;
    const rightBoundEdge = rightBound - 4;
    const maxX = Math.max(
      minX,
      Math.min(dotRightEdge - width, rightBoundEdge - width),
    );
    return Math.min(Math.max(hoverXSV.value - width * 0.5, minX), maxX);
  }, [charWidth, leftBound, rightBound]);

  const y = useDerivedValue(() => {
    "worklet";
    return top + 10;
  }, [top]);

  const opacity = useDerivedValue(() => {
    "worklet";
    const o = crosshairOpacitySV.value;
    if (o < 0.1 || rightBound - leftBound < minWidth) return 0;
    const result = multiCrosshairResultSV.value;
    return result.entryCount > 0 ? o : 0;
  }, [leftBound, rightBound]);

  return (
    <>
      {tooltipOutline ? (
        <SkiaText
          x={x}
          y={y}
          text={text}
          font={font}
          style="stroke"
          strokeWidth={3}
          color={outlineColor}
          opacity={opacity}
        />
      ) : null}
      <SkiaText
        x={x}
        y={y}
        text={text}
        font={font}
        color={textColor}
        opacity={opacity}
      />
    </>
  );
});

const OB_GREEN_STR = "rgb(34, 197, 94)";
const OB_RED_STR = "rgb(239, 68, 68)";

interface OrderbookLabelProps {
  index: number;
  labelsSV: SharedValue<OrderbookLabelSlot[]>;
  revealSV: SharedValue<number>;
  left: number;
  font: ReturnType<typeof matchFont>;
}

const OrderbookLabel = memo(function OrderbookLabel({
  index,
  labelsSV,
  revealSV,
  left,
  font,
}: OrderbookLabelProps) {
  const x = Math.round(left);

  const text = useDerivedValue(() => {
    "worklet";
    const slot = labelsSV.value[index];
    return slot?.active === 1 ? slot.text : "";
  }, [index]);

  const y = useDerivedValue(() => {
    "worklet";
    const slot = labelsSV.value[index];
    if (!slot || slot.active !== 1 || slot.alpha <= 0.001) {
      return -1000;
    }
    // Snap to pixel to avoid Skia text shimmer on sub-pixel movement.
    return Math.round(slot.y) + 4;
  }, [index]);

  const opacity = useDerivedValue(() => {
    "worklet";
    const slot = labelsSV.value[index];
    if (!slot || slot.active !== 1 || slot.alpha <= 0.001) return 0;
    return clamp(slot.alpha, 0, 1) * revealSV.value;
  }, [index]);

  const color = useDerivedValue(() => {
    "worklet";
    const slot = labelsSV.value[index];
    if (!slot || slot.active !== 1 || slot.alpha <= 0.001) return "transparent";
    return slot.green === 1 ? OB_GREEN_STR : OB_RED_STR;
  }, [index]);

  return (
    <SkiaText
      x={x}
      y={y}
      text={text}
      font={font}
      color={color}
      opacity={opacity}
    />
  );
});

interface WindowControlsProps {
  windows: WindowOption[];
  activeWindowSecs: number;
  onChange: (secs: number) => void;
  styleVariant: WindowStyle;
  isDark: boolean;
}

function ModeToggle({
  mode,
  onModeChange,
  isDark,
  styleVariant,
}: {
  mode: "line" | "candle";
  onModeChange: (mode: "line" | "candle") => void;
  isDark: boolean;
  styleVariant: WindowStyle;
}) {
  const activeColor = isDark ? "rgba(255,255,255,0.7)" : "rgba(0,0,0,0.55)";
  const inactiveColor = isDark ? "rgba(255,255,255,0.25)" : "rgba(0,0,0,0.22)";

  return (
    <View
      style={[
        styles.windowRow,
        styleVariant === "text" ? styles.windowRowText : null,
        styleVariant === "rounded" ? styles.windowRowRounded : null,
        styleVariant !== "text"
          ? {
              backgroundColor: isDark
                ? "rgba(255,255,255,0.03)"
                : "rgba(0,0,0,0.02)",
            }
          : null,
      ]}
    >
      <Pressable
        onPress={() => onModeChange("line")}
        style={[
          styles.modeBtn,
          styleVariant === "rounded" ? styles.modeBtnRounded : null,
        ]}
        hitSlop={4}
      >
        <Canvas style={{ width: 12, height: 12 }}>
          <Path
            path="M1 8.5C2.5 8.5 3 4 5.5 4S7.5 7 8.5 7C9.5 7 10 3.5 11 3.5"
            style="stroke"
            strokeWidth={mode === "line" ? 1.5 : 1.2}
            strokeCap="round"
            color={mode === "line" ? activeColor : inactiveColor}
          />
        </Canvas>
      </Pressable>
      <Pressable
        onPress={() => onModeChange("candle")}
        style={[
          styles.modeBtn,
          styleVariant === "rounded" ? styles.modeBtnRounded : null,
        ]}
        hitSlop={4}
      >
        <Canvas style={{ width: 12, height: 12 }}>
          <Group>
            {/* Left candle wick */}
            <Path
              path="M3.5 1L3.5 11"
              style="stroke"
              strokeWidth={1}
              color={mode === "candle" ? activeColor : inactiveColor}
            />
            {/* Left candle body */}
            <Rect
              x={2}
              y={3}
              width={3}
              height={5}
              color={mode === "candle" ? activeColor : inactiveColor}
            />
            {/* Right candle wick */}
            <Path
              path="M8.5 2L8.5 10"
              style="stroke"
              strokeWidth={1}
              color={mode === "candle" ? activeColor : inactiveColor}
            />
            {/* Right candle body */}
            <Rect
              x={7}
              y={4}
              width={3}
              height={4}
              color={mode === "candle" ? activeColor : inactiveColor}
            />
          </Group>
        </Canvas>
      </Pressable>
    </View>
  );
}

function WindowControls({
  windows,
  activeWindowSecs,
  onChange,
  styleVariant,
  isDark,
}: WindowControlsProps) {
  const [buttonLayouts, setButtonLayouts] = useState<
    Record<number, { x: number; width: number }>
  >({});
  const activeLayout = buttonLayouts[activeWindowSecs];
  const indicatorTargetX = activeLayout?.x ?? 0;
  const indicatorTargetW = activeLayout?.width ?? 0;
  const showIndicator = styleVariant !== "text" && indicatorTargetW > 0;
  const indicatorLeftSV = useDerivedValue(() => {
    "worklet";
    return withTiming(showIndicator ? indicatorTargetX : 0, { duration: 250 });
  }, [indicatorTargetX, showIndicator]);
  const indicatorWidthSV = useDerivedValue(() => {
    "worklet";
    return withTiming(showIndicator ? indicatorTargetW : 0, { duration: 250 });
  }, [indicatorTargetW, showIndicator]);
  const indicatorStyle = useAnimatedStyle(() => ({
    opacity: showIndicator ? 1 : 0,
    width: indicatorWidthSV.value,
    transform: [{ translateX: indicatorLeftSV.value }],
  }));

  return (
    <View
      style={[
        styles.windowRow,
        styleVariant === "text" ? styles.windowRowText : null,
        styleVariant === "rounded" ? styles.windowRowRounded : null,
        styleVariant !== "text"
          ? {
              backgroundColor: isDark
                ? "rgba(255,255,255,0.03)"
                : "rgba(0,0,0,0.02)",
            }
          : null,
      ]}
    >
      {styleVariant !== "text" ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.windowIndicator,
            indicatorStyle,
            {
              top: styleVariant === "rounded" ? 3 : 2,
              bottom: styleVariant === "rounded" ? 3 : 2,
              borderRadius: styleVariant === "rounded" ? 999 : 4,
              backgroundColor: isDark
                ? "rgba(255,255,255,0.06)"
                : "rgba(0,0,0,0.035)",
            },
          ]}
        />
      ) : null}
      {windows.map((w) => {
        const active = w.secs === activeWindowSecs;
        return (
          <Pressable
            key={w.secs}
            onPress={() => onChange(w.secs)}
            onLayout={(event) => {
              const { x, width } = event.nativeEvent.layout;
              setButtonLayouts(
                (prev: Record<number, { x: number; width: number }>) => {
                  const existing = prev[w.secs];
                  if (
                    existing &&
                    Math.abs(existing.x - x) < 0.5 &&
                    Math.abs(existing.width - width) < 0.5
                  ) {
                    return prev;
                  }
                  return {
                    ...prev,
                    [w.secs]: { x, width },
                  };
                },
              );
            }}
            style={[
              styles.windowBtn,
              styleVariant === "rounded" ? styles.windowBtnRounded : null,
              styleVariant === "text" ? styles.windowBtnText : null,
            ]}
          >
            <Text
              style={[
                styles.windowBtnTextLabel,
                {
                  color: active
                    ? isDark
                      ? "rgba(255,255,255,0.7)"
                      : "rgba(0,0,0,0.55)"
                    : isDark
                      ? "rgba(255,255,255,0.25)"
                      : "rgba(0,0,0,0.22)",
                  fontWeight: active ? "600" : "400",
                },
              ]}
            >
              {w.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ── Multi-series memo components ──────────────────────────────────

interface SeriesSlotForRender {
  active: number;
  displayValue: number;
  alpha: number;
  dotX: number;
  dotY: number;
  color: string;
  label: string;
}

interface SeriesLineProps {
  index: number;
  pathSV: SharedValue<import("@shopify/react-native-skia").SkPath>;
  slotsSV: SharedValue<SeriesSlotForRender[]>;
  chartRevealSV: SharedValue<number>;
}

const SeriesLine = memo(function SeriesLine({
  index,
  pathSV,
  slotsSV,
  chartRevealSV,
}: SeriesLineProps) {
  const color = useDerivedValue(() => {
    "worklet";
    return slotsSV.value[index]?.color ?? "#3b82f6";
  }, [index]);

  const opacity = useDerivedValue(() => {
    "worklet";
    const slot = slotsSV.value[index];
    if (!slot || !slot.active) return 0;
    const reveal = chartRevealSV.value;
    // Secondary lines fade in faster during reveal to avoid brightness
    // compounding from overlapping semi-transparent strokes
    const secondaryFade = index > 0 && reveal < 1 ? Math.min(1, reveal * 2) : 1;
    return slot.alpha * reveal * secondaryFade;
  }, [index]);

  return (
    <Path
      path={pathSV}
      style="stroke"
      strokeWidth={2}
      strokeJoin="round"
      strokeCap="round"
      color={color}
      opacity={opacity}
    />
  );
});

interface SeriesDotProps {
  index: number;
  slotsSV: SharedValue<SeriesSlotForRender[]>;
  chartRevealSV: SharedValue<number>;
}

const SeriesDot = memo(function SeriesDot({
  index,
  slotsSV,
  chartRevealSV,
}: SeriesDotProps) {
  const cx = useDerivedValue(() => {
    "worklet";
    return slotsSV.value[index]?.dotX ?? 0;
  }, [index]);

  const cy = useDerivedValue(() => {
    "worklet";
    return slotsSV.value[index]?.dotY ?? 0;
  }, [index]);

  const color = useDerivedValue(() => {
    "worklet";
    return slotsSV.value[index]?.color ?? "#3b82f6";
  }, [index]);

  const opacity = useDerivedValue(() => {
    "worklet";
    const slot = slotsSV.value[index];
    if (!slot || !slot.active) return 0;
    const reveal = chartRevealSV.value;
    if (reveal <= 0.3) return 0;
    const revealFade = reveal >= 1 ? 1 : (reveal - 0.3) / 0.7;
    return slot.alpha * revealFade;
  }, [index]);

  return <Circle cx={cx} cy={cy} r={3} color={color} opacity={opacity} />;
});

interface SeriesEndLabelProps {
  index: number;
  slotsSV: SharedValue<SeriesSlotForRender[]>;
  chartRevealSV: SharedValue<number>;
  font: ReturnType<typeof matchFont>;
}

const SeriesEndLabel = memo(function SeriesEndLabel({
  index,
  slotsSV,
  chartRevealSV,
  font,
}: SeriesEndLabelProps) {
  const text = useDerivedValue(() => {
    "worklet";
    return slotsSV.value[index]?.label ?? "";
  }, [index]);

  const x = useDerivedValue(() => {
    "worklet";
    return (slotsSV.value[index]?.dotX ?? 0) + 6;
  }, [index]);

  const y = useDerivedValue(() => {
    "worklet";
    return (slotsSV.value[index]?.dotY ?? -1000) + 3.5;
  }, [index]);

  const color = useDerivedValue(() => {
    "worklet";
    return slotsSV.value[index]?.color ?? "#3b82f6";
  }, [index]);

  const opacity = useDerivedValue(() => {
    "worklet";
    const slot = slotsSV.value[index];
    if (!slot || !slot.active || !slot.label) return 0;
    const reveal = chartRevealSV.value;
    if (reveal <= 0.3) return 0;
    const revealFade = reveal >= 1 ? 1 : (reveal - 0.3) / 0.7;
    return slot.alpha * revealFade;
  }, [index]);

  return (
    <SkiaText
      x={x}
      y={y}
      text={text}
      font={font}
      color={color}
      opacity={opacity}
    />
  );
});

interface SeriesPulseProps {
  index: number;
  slotsSV: SharedValue<SeriesSlotForRender[]>;
  chartRevealSV: SharedValue<number>;
  pulseRadiusSV: SharedValue<number>;
  pulseOpacitySV: SharedValue<number>;
  pauseProgressSV: SharedValue<number>;
}

const SeriesPulse = memo(function SeriesPulse({
  index,
  slotsSV,
  chartRevealSV,
  pulseRadiusSV,
  pulseOpacitySV,
  pauseProgressSV,
}: SeriesPulseProps) {
  const cx = useDerivedValue(() => {
    "worklet";
    return slotsSV.value[index]?.dotX ?? 0;
  }, [index]);

  const cy = useDerivedValue(() => {
    "worklet";
    return slotsSV.value[index]?.dotY ?? 0;
  }, [index]);

  const color = useDerivedValue(() => {
    "worklet";
    return slotsSV.value[index]?.color ?? "#3b82f6";
  }, [index]);

  const opacity = useDerivedValue(() => {
    "worklet";
    const slot = slotsSV.value[index];
    if (!slot || !slot.active || slot.alpha <= 0.5) return 0;
    const reveal = chartRevealSV.value;
    if (reveal <= 0.6) return 0;
    if (pauseProgressSV.value >= 0.5) return 0;
    return slot.alpha * pulseOpacitySV.value;
  }, [index]);

  return (
    <Circle
      cx={cx}
      cy={cy}
      r={pulseRadiusSV}
      color={color}
      opacity={opacity}
      style="stroke"
      strokeWidth={1.5}
    />
  );
});

interface MultiCrosshairDotsProps {
  index: number;
  hoverXSV: SharedValue<number>;
  multiCrosshairResultSV: SharedValue<
    import("./draw/crosshair").MultiCrosshairResult
  >;
  crosshairOpacitySV: SharedValue<number>;
}

const MultiCrosshairDot = memo(function MultiCrosshairDot({
  index,
  hoverXSV,
  multiCrosshairResultSV,
  crosshairOpacitySV,
}: MultiCrosshairDotsProps) {
  const cy = useDerivedValue(() => {
    "worklet";
    const result = multiCrosshairResultSV.value;
    if (index >= result.entryCount) return -1000;
    return result.entries[index]?.y ?? -1000;
  }, [index]);

  const color = useDerivedValue(() => {
    "worklet";
    const result = multiCrosshairResultSV.value;
    if (index >= result.entryCount) return "#3b82f6";
    return result.entries[index]?.color ?? "#3b82f6";
  }, [index]);

  const opacity = useDerivedValue(() => {
    "worklet";
    const result = multiCrosshairResultSV.value;
    if (index >= result.entryCount) return 0;
    return crosshairOpacitySV.value;
  }, [index]);

  return <Circle cx={hoverXSV} cy={cy} r={4} color={color} opacity={opacity} />;
});

export function Liveline({
  data,
  value,
  theme = "dark",
  color = "#3b82f6",
  window: windowSecsProp = 30,
  grid = true,
  badge = true,
  momentum = true,
  fill = true,
  scrub = true,
  loading = false,
  paused = false,
  emptyText,
  exaggerate = false,
  degen: degenProp,
  badgeTail = true,
  badgeVariant = "default",
  showValue = false,
  showChange = false,
  valueDisplayMode = "latest",
  dataTransition = "none",
  dataTransitionDurationMs,
  dataTransitionKey,
  valueMomentumColor = false,
  windows,
  onWindowChange,
  windowStyle = "default",
  windowPosition = "left",
  tooltipY = 14,
  tooltipOutline = true,
  orderbook,
  referenceLine,
  formatValue = defaultFormatValue,
  formatTime = defaultFormatTime,
  formatValueWorklet,
  formatTimeWorklet,
  timeFormatPreset = "auto",
  axisTimeFormatPreset,
  crosshairTimeFormatPreset,
  formatAxisTimeWorklet,
  formatCrosshairTimeWorklet,
  lerpSpeed = 0.08,
  padding: paddingOverride,
  onHover,
  mode = "line",
  candles: candlesProp,
  candleWidth: candleWidthProp,
  liveCandle: liveCandleProp,
  lineMode: lineModeProp,
  lineData: lineDataProp,
  lineValue: lineValueProp,
  onModeChange,
  renderWindowControls,
  pulse = true,
  series: seriesProp,
  onSeriesToggle,
  seriesToggleCompact = false,
  className,
  style,
}: LivelineProps) {
  void className;
  const emptyLabel = emptyText ?? "No data to display";

  const containerRef = useRef<View>(null);
  const layoutRef = useRef({ width: 0, height: 0 });
  const [, forceLayout] = useState(0);
  const [windowOverride, setWindowOverride] = useState<number | null>(null);
  const [controlsPrimaryWidth, setControlsPrimaryWidth] = useState(0);
  const [controlsSeriesWidth, setControlsSeriesWidth] = useState(0);

  const isDark = theme === "dark";
  const palette = useMemo(() => derivePalette(color, theme), [color, theme]);

  const showMomentum = momentum !== false;
  const momentumOverride =
    typeof momentum === "string" ? (momentum as Momentum) : undefined;

  const degenEnabled = degenProp != null ? degenProp !== false : false;
  const degenOptions: DegenOptions | undefined = degenEnabled
    ? typeof degenProp === "object"
      ? degenProp
      : {}
    : undefined;

  const padding = useMemo<Required<Padding>>(
    () => ({
      top: paddingOverride?.top ?? DEFAULT_PADDING.top,
      right: paddingOverride?.right ?? DEFAULT_PADDING.right,
      bottom: paddingOverride?.bottom ?? DEFAULT_PADDING.bottom,
      left: paddingOverride?.left ?? DEFAULT_PADDING.left,
    }),
    [
      paddingOverride?.bottom,
      paddingOverride?.left,
      paddingOverride?.right,
      paddingOverride?.top,
    ],
  );

  // ── Multi-series state ───────────────────────────────────────────
  const lastSeriesPropRef = useRef(seriesProp);
  if (seriesProp && seriesProp.length > 0) {
    lastSeriesPropRef.current = seriesProp;
  }

  const isMultiSeries = !!seriesProp && seriesProp.length > 0;
  const seriesForToggle = lastSeriesPropRef.current ?? [];
  const showSeriesToggle = seriesForToggle.length > 1;
  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(new Set());

  const handleSeriesToggle = (id: string) => {
    setHiddenSeries((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        onSeriesToggle?.(id, true);
      } else {
        // Prevent hiding last visible series
        const totalSeries = seriesForToggle.length;
        const visibleCount = totalSeries - next.size;
        if (visibleCount <= 1) return prev;
        next.add(id);
        onSeriesToggle?.(id, false);
      }
      return next;
    });
  };

  const controlledWindowSecs = windows?.some((w) => w.secs === windowSecsProp)
    ? windowSecsProp
    : null;
  const fallbackWindow = windows?.[0]?.secs ?? windowSecsProp;
  const activeWindowSecs = windows
    ? (controlledWindowSecs ?? windowOverride ?? fallbackWindow)
    : windowSecsProp;
  const hasData = data.some(
    (p) => Number.isFinite(p?.time) && Number.isFinite(p?.value),
  );
  const axisLabelFont = useMemo(
    () =>
      matchFont({
        fontFamily: "Menlo",
        fontSize: AXIS_FONT_SIZE,
        fontWeight: "400",
      }),
    [],
  );
  const badgeFont = useMemo(
    () =>
      matchFont({
        fontFamily: "Menlo",
        fontSize: 11,
        fontWeight: "400",
      }),
    [],
  );
  const tooltipFont = useMemo(
    () =>
      matchFont({
        fontFamily: "Menlo",
        fontSize: 13,
        fontWeight: "400",
      }),
    [],
  );
  const orderbookFont = useMemo(
    () =>
      matchFont({
        fontFamily: "Menlo",
        fontSize: 13,
        fontWeight: "600",
      }),
    [],
  );
  const referenceFont = useMemo(
    () =>
      matchFont({
        fontFamily: "Menlo",
        fontSize: 11,
        fontWeight: "500",
      }),
    [],
  );
  const seriesEndLabelFont = useMemo(
    () =>
      matchFont({
        fontFamily: "System",
        fontSize: 10,
        fontWeight: "600",
      }),
    [],
  );
  const emptyFont = useMemo(
    () =>
      matchFont({
        fontFamily: "Menlo",
        fontSize: 12,
        fontWeight: "400",
      }),
    [],
  );
  const axisCharWidth = useMemo(
    () => Math.max(5, axisLabelFont.measureText("8").width),
    [axisLabelFont],
  );
  const seriesLabelCharWidth = useMemo(
    () => Math.max(5, seriesEndLabelFont.measureText("8").width),
    [seriesEndLabelFont],
  );
  const badgeCharWidth = useMemo(
    () => Math.max(6, badgeFont.measureText("8").width),
    [badgeFont],
  );
  const tooltipCharWidth = useMemo(
    () => Math.max(6, tooltipFont.measureText("8").width),
    [tooltipFont],
  );
  const tooltipSeparatorWidth = useMemo(
    () => Math.max(10, tooltipFont.measureText("  ·  ").width),
    [tooltipFont],
  );
  const badgeTextBaselineOffset = useMemo(() => {
    const metrics = badgeFont.getMetrics();
    const glyphHeight = Math.max(0, metrics.descent - metrics.ascent);
    const lineSlack = Math.max(0, BADGE_LINE_H - glyphHeight);
    const offset = BADGE_PAD_Y + lineSlack * 0.5 - metrics.ascent;
    return Number.isFinite(offset) ? offset : BADGE_PAD_Y + BADGE_LINE_H * 0.8;
  }, [badgeFont]);

  // Pan/zoom gesture shared values
  const domainOffsetSV = useSharedValue(0);
  const panVelocitySV = useSharedValue(0);
  const isLiveSV = useSharedValue(1);
  const gestureWindowSecsSV = useSharedValue(0);
  const panStartOffsetSV = useSharedValue(0);
  const pinchBaseWindowSV = useSharedValue(30);

  const referenceLabelWidth = Math.max(
    0,
    referenceFont.measureText(referenceLine?.label ?? "").width,
  );
  const layout = layoutRef.current;
  const hasLayout = layout.width > 0 && layout.height > 0;

  const {
    linePathSV,
    fillPathSV,
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
    displayWindowSecsSV,
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
    badgeYSV,
    valueTextSV,
    changeTextSV,
    changeSignSV,
    hoverActiveSV,
    hoverXSV,
    hoverYSV,
    hoverValueTextSV,
    hoverTimeTextSV,
    crosshairOpacitySV,
    scrubAmountSV,
    chartRevealSV,
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
    // Multi-series
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
  } = useLivelineEngine({
    data,
    value,
    windowSecs: activeWindowSecs,
    targetWindowSecs: activeWindowSecs,
    layoutWidth: hasLayout ? layout.width : 1,
    layoutHeight: hasLayout ? layout.height : 1,
    padding,
    showMomentum: isMultiSeries ? false : showMomentum,
    showGrid: grid,
    showBadge: isMultiSeries ? false : badge,
    badgeTail,
    showFill: isMultiSeries ? false : fill,
    showPulse: pulse,
    showLoadingState: loading,
    paused,
    exaggerate,
    lerpSpeed,
    momentumOverride: isMultiSeries ? "flat" : momentumOverride,
    referenceLine,
    orderbook: isMultiSeries ? undefined : orderbook,
    degenOptions: isMultiSeries ? undefined : degenOptions,
    formatValueWorklet,
    formatTimeWorklet,
    timeFormatPreset,
    axisTimeFormatPreset,
    crosshairTimeFormatPreset,
    formatAxisTimeWorklet,
    formatCrosshairTimeWorklet,
    valueDisplayMode,
    dataTransition,
    dataTransitionDurationMs,
    dataTransitionKey,
    valueMomentumColor,
    onHover,
    badgeCharWidth,
    axisCharWidth,
    seriesLabelCharWidth,
    referenceLabelWidth,
    scrub,
    domainOffsetSV,
    panVelocitySV,
    isLiveSV,
    gestureWindowSecsSV,
    mode: isMultiSeries ? "line" : mode,
    candles: isMultiSeries ? undefined : candlesProp,
    candleWidth: isMultiSeries ? undefined : candleWidthProp,
    liveCandle: isMultiSeries ? undefined : liveCandleProp,
    lineMode: isMultiSeries ? undefined : lineModeProp,
    lineData: isMultiSeries ? undefined : lineDataProp,
    lineValue: isMultiSeries ? undefined : lineValueProp,
    // Multi-series
    series: seriesProp,
    isMultiSeries,
    hiddenSeriesIds: hiddenSeries,
  });

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

  const onLayout = ({ nativeEvent }: LayoutChangeEvent) => {
    const { width, height } = nativeEvent.layout;
    if (
      Math.abs(layoutRef.current.width - width) > LAYOUT_EPSILON ||
      Math.abs(layoutRef.current.height - height) > LAYOUT_EPSILON
    ) {
      layoutRef.current = { width, height };
      forceLayout((x) => x + 1);
    }
  };

  const chartRight = layout.width - padding.right;
  const chartBottom = layout.height - padding.bottom;
  const chartHeight = Math.max(0, chartBottom - padding.top);
  const centerX = padding.left + Math.max(0, chartRight - padding.left) * 0.5;
  const centerY = padding.top + chartHeight * 0.5;
  const emptyCenterX = layout.width * 0.5;
  const emptyTextWidth = Math.max(0, emptyFont.measureText(emptyLabel).width);
  const emptyTextX = emptyCenterX - emptyTextWidth * 0.5;
  const emptyTextY = centerY + 4;
  const emptyGapFade = 30;
  const emptyGapLeft = 0;
  const emptyGapWidth = layout.width;
  const emptyGapHeight = chartHeight * LOADING_AMPLITUDE_RATIO * 2 + 2 + 6;
  const referenceLabelX =
    padding.left +
    Math.max(0, chartRight - padding.left) * 0.5 -
    referenceLabelWidth * 0.5;

  const isCandle = mode === "candle";

  const liveOpacitySV = useDerivedValue(
    () =>
      (1 - loadingAlphaSV.value) * (isCandle ? lineModeProgressSV.value : 1),
    [isCandle],
  );
  const emptyOpacitySV = useDerivedValue(
    () => (hasData ? 0 : 1 - loadingAlphaSV.value),
    [hasData],
  );
  const loadingLineOpacitySV = useDerivedValue(
    () => loadingAlphaSV.value * loadingBreathSV.value,
  );
  const emptyLineOpacitySV = useDerivedValue(
    () => emptyOpacitySV.value * loadingBreathSV.value,
  );
  const dotRevealSV = useDerivedValue(() => {
    "worklet";
    const reveal = chartRevealSV.value;
    if (reveal <= 0.3) return 0;
    if (reveal >= 1) return 1;
    return (reveal - 0.3) / 0.7;
  });
  const arrowRevealSV = useDerivedValue(() => {
    "worklet";
    const reveal = chartRevealSV.value;
    if (reveal <= 0.6) return 0;
    if (reveal >= 1) return 1;
    const t = (reveal - 0.6) / 0.4;
    return t * t * (3 - 2 * t);
  });
  // Dim dot/glow when browsing history (isLive=0): 30% base + 70% * isLive
  const liveDimFactorSV = useDerivedValue(() => 0.3 + 0.7 * isLiveSV.value);
  const liveGlowOpacitySV = useDerivedValue(
    () =>
      liveOpacitySV.value *
      dotRevealSV.value *
      liveDimFactorSV.value *
      (isCandle ? lineModeProgressSV.value : 1) *
      (1 - crosshairOpacitySV.value * 0.7),
    [isCandle],
  );
  const liveDotOpacitySV = useDerivedValue(
    () =>
      liveOpacitySV.value *
      dotRevealSV.value *
      liveDimFactorSV.value *
      (isCandle ? lineModeProgressSV.value : 1) *
      (1 - crosshairOpacitySV.value * 0.6),
    [isCandle],
  );
  // Suppress pulse when browsing
  const pulseDrawOpacitySV = useDerivedValue(
    () =>
      pulseOpacitySV.value *
      dotRevealSV.value *
      isLiveSV.value *
      (1 - crosshairOpacitySV.value * 0.7),
  );
  const crosshairLineOpacitySV = useDerivedValue(
    () => crosshairOpacitySV.value * 0.5,
  );
  const hoverDotOpacitySV = useDerivedValue(() => crosshairOpacitySV.value);
  const dashLineOpacitySV = useDerivedValue(
    () => chartRevealSV.value * (1 - crosshairOpacitySV.value * 0.2),
  );
  const liveLineOpacitySV = useDerivedValue(() => liveOpacitySV.value);
  const scrubSplitXSV = useDerivedValue(() =>
    clamp(hoverXSV.value, padding.left, layout.width - padding.right),
  );
  const scrubDimOpacitySV = useDerivedValue(
    () => liveLineOpacitySV.value * (1 - crosshairOpacitySV.value * 0.6),
  );
  const liveFillOpacitySV = useDerivedValue(
    () => liveLineOpacitySV.value * chartRevealSV.value,
  );
  const scrubDimFillOpacitySV = useDerivedValue(
    () => liveFillOpacitySV.value * (1 - crosshairOpacitySV.value * 0.6),
  );
  const emptyTextOpacitySV = useDerivedValue(() => emptyOpacitySV.value * 0.35);
  // Clip line + fill to chart area — during big value jumps the range
  // lerps smoothly so the line may extend beyond the chart bounds.
  // Clipping keeps it tidy while the range catches up (matches web).
  const chartClipRectSV = useDerivedValue(() =>
    rect(
      padding.left - 1,
      padding.top,
      Math.max(0, chartRight - padding.left + 2),
      Math.max(0, chartHeight),
    ),
  );
  const leftClipRectSV = useDerivedValue(() =>
    rect(0, 0, Math.max(0, scrubSplitXSV.value), Math.max(0, layout.height)),
  );
  const rightClipRectSV = useDerivedValue(() =>
    rect(
      scrubSplitXSV.value,
      0,
      Math.max(0, layout.width - scrubSplitXSV.value),
      Math.max(0, layout.height),
    ),
  );
  const badgeOpacitySV = useDerivedValue(() => {
    "worklet";
    const reveal = chartRevealSV.value;
    const revealOpacity =
      reveal <= 0.25 ? 0 : reveal < 0.5 ? (reveal - 0.25) / 0.25 : 1;
    let opacity = revealOpacity * (1 - pauseProgressSV.value);
    // In candle mode, badge only shows during line morph (lineModeProg > 0.5)
    if (isCandle) {
      const lp = lineModeProgressSV.value;
      opacity *= lp > 0.5 ? (lp - 0.5) * 2 : 0;
    }
    return opacity;
  }, [isCandle]);
  const arrowOpacitySV = useDerivedValue(
    () =>
      showMomentum && !isCandle
        ? arrowRevealSV.value * (1 - pauseProgressSV.value)
        : 0,
    [isCandle],
  );
  const chartShakeStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: shakeXSV.value }, { translateY: shakeYSV.value }],
  }));

  // Candle mode opacity: fade candles in/out based on chart reveal + line morph
  // Web: candleAlpha = chartReveal * (1 - lp) where lp = max(lineModeProg, revealLine)
  // We use lineModeProg directly (revealLine is 0 at full reveal)
  const candleOpacitySV = useDerivedValue(() => {
    if (!isCandle) return 0;
    const lp = lineModeProgressSV.value;
    return chartRevealSV.value * (1 - pauseProgressSV.value) * (1 - lp);
  }, [isCandle]);
  // Candle width morph: cross-fade old/new candle paths during width change
  const candleNewOpacitySV = useDerivedValue(() => {
    if (!isCandle) return 0;
    const mt = candleWidthMorphTSV.value;
    return candleOpacitySV.value * (mt >= 0 ? mt : 1);
  }, [isCandle]);
  const candleOldOpacitySV = useDerivedValue(() => {
    if (!isCandle) return 0;
    const mt = candleWidthMorphTSV.value;
    if (mt < 0) return 0;
    return candleOpacitySV.value * (1 - mt);
  }, [isCandle]);
  // Candle scrub dim: right of crosshair dimmed (web: 0.5 max dimming per candle)
  const candleScrubDimOpacitySV = useDerivedValue(() => {
    if (!isCandle) return 0;
    return candleNewOpacitySV.value * (1 - crosshairOpacitySV.value * 0.5);
  }, [isCandle]);
  const candleOldScrubDimOpacitySV = useDerivedValue(() => {
    if (!isCandle) return 0;
    return candleOldOpacitySV.value * (1 - crosshairOpacitySV.value * 0.5);
  }, [isCandle]);
  // Live candle glow pulsing opacity — includes scrub dim since live candle
  // is rightmost and always in the dimmed zone during scrub
  const candleGlowOpacitySV = useDerivedValue(() => {
    if (!isCandle) return 0;
    return (
      candleOpacitySV.value *
      liveBirthAlphaSV.value *
      candleGlowPulseSV.value *
      (1 - crosshairOpacitySV.value * 0.5)
    );
  }, [isCandle]);
  // Close price: candle-colored line fades out during morph
  // Web: closeAlpha * (1-lp) * (1 - scrubDim*0.3) * 0.4
  const closePriceCandleOpacitySV = useDerivedValue(() => {
    if (!isCandle) return 0;
    const lp = lineModeProgressSV.value;
    if (lp > 0.99) return 0;
    return (
      candleOpacitySV.value * (1 - lp) * (1 - scrubAmountSV.value * 0.3) * 0.4
    );
  }, [isCandle]);
  // Close price: accent-colored line fades in during morph
  // Web: closeAlpha * lp * (1 - scrubAmount*0.2)
  const closePriceAccentOpacitySV = useDerivedValue(() => {
    if (!isCandle) return 0;
    const lp = lineModeProgressSV.value;
    if (lp < 0.01) return 0;
    return candleOpacitySV.value * lp * (1 - scrubAmountSV.value * 0.2) * 0.4;
  }, [isCandle]);
  // Live candle glow color: blend between bear (red) and bull (green)
  const candleGlowColorSV = useDerivedValue(() => {
    "worklet";
    if (!isCandle) return BULL_COLOR;
    const { r, g, b } = blendBullBear(liveBullBlendSV.value);
    return `rgb(${r},${g},${b})`;
  }, [isCandle]);
  // Accent color blending: candle colors → palette.line as lineModeProg increases
  // Web: blendToAccent(candleColor, accentColor, lp) per candle
  // Native: blend static bull/bear toward accent since paths are batched
  const { r: acR, g: acG, b: acB } = parseRgb(palette.line);
  const candleBullColorSV = useDerivedValue(() => {
    "worklet";
    if (!isCandle) return BULL_COLOR;
    const lp = lineModeProgressSV.value;
    if (lp < 0.01) return BULL_COLOR;
    return `rgb(${Math.round(BULL_R + (acR - BULL_R) * lp)},${Math.round(BULL_G + (acG - BULL_G) * lp)},${Math.round(BULL_B + (acB - BULL_B) * lp)})`;
  }, [isCandle, acR, acG, acB]);
  const candleBearColorSV = useDerivedValue(() => {
    "worklet";
    if (!isCandle) return BEAR_COLOR;
    const lp = lineModeProgressSV.value;
    if (lp < 0.01) return BEAR_COLOR;
    return `rgb(${Math.round(BEAR_R + (acR - BEAR_R) * lp)},${Math.round(BEAR_G + (acG - BEAR_G) * lp)},${Math.round(BEAR_B + (acB - BEAR_B) * lp)})`;
  }, [isCandle, acR, acG, acB]);

  const neutralBadgeRgb = useMemo(
    () => parseRgb(palette.badgeBg),
    [palette.badgeBg],
  );
  const negativeBadgeRgb = useMemo(
    () => parseRgb(palette.negative),
    [palette.negative],
  );
  const positiveBadgeRgb = useMemo(
    () => parseRgb(palette.positive),
    [palette.positive],
  );
  const hasReferenceLabel = !!referenceLine?.label;

  const badgeRgbCacheSV = useSharedValue(createRgbCache());
  const badgeColorSV = useDerivedValue(() => {
    const mix = badgeColorMixSV.value;
    const from = mix < 0.5 ? negativeBadgeRgb : neutralBadgeRgb;
    const to = mix < 0.5 ? neutralBadgeRgb : positiveBadgeRgb;
    const p = clamp(mix < 0.5 ? mix * 2 : (mix - 0.5) * 2, 0, 1);
    return rgbCached(
      badgeRgbCacheSV.value,
      Math.round(from.r + (to.r - from.r) * p),
      Math.round(from.g + (to.g - from.g) * p),
      Math.round(from.b + (to.b - from.b) * p),
    );
  }, [negativeBadgeRgb, neutralBadgeRgb, positiveBadgeRgb]);

  // Per-chevron stagger: 200ms offset in a 1400ms cycle, matching web cascade.
  const chevronPulse = (cycle: number, index: number): number => {
    "worklet";
    const start = index * 0.2;
    const dur = 0.35;
    const localT = cycle - start;
    const wave =
      localT >= 0 && localT < dur ? Math.sin((localT / dur) * Math.PI) : 0;
    return 0.3 + 0.7 * wave;
  };

  const upChevron0OpacitySV = useDerivedValue(() => {
    return (
      arrowOpacitySV.value *
      arrowUpOpacitySV.value *
      chevronPulse(arrowCycleSV.value, 0)
    );
  });
  const upChevron1OpacitySV = useDerivedValue(() => {
    return (
      arrowOpacitySV.value *
      arrowUpOpacitySV.value *
      chevronPulse(arrowCycleSV.value, 1)
    );
  });
  const downChevron0OpacitySV = useDerivedValue(() => {
    return (
      arrowOpacitySV.value *
      arrowDownOpacitySV.value *
      chevronPulse(arrowCycleSV.value, 0)
    );
  });
  const downChevron1OpacitySV = useDerivedValue(() => {
    return (
      arrowOpacitySV.value *
      arrowDownOpacitySV.value *
      chevronPulse(arrowCycleSV.value, 1)
    );
  });

  const valueOverlayColorSV = useDerivedValue(() => {
    if (!valueMomentumColor) return palette.overlay;
    const dir = momentumDirSV.value;
    if (dir === "up") return palette.positive;
    if (dir === "down") return palette.negative;
    return palette.overlay;
  }, [valueMomentumColor, palette.overlay, palette.positive, palette.negative]);

  const valueOverlayProps = useAnimatedProps(() => {
    "worklet";
    const txt = valueTextSV.value;
    return { text: txt, value: txt } as never;
  });

  const changeOverlayProps = useAnimatedProps(() => {
    "worklet";
    const txt = changeTextSV.value;
    return { text: txt, value: txt } as never;
  });

  const valueOverlayStyle = useAnimatedStyle(() => {
    "worklet";
    return {
      color: valueOverlayColorSV.value,
    };
  });

  const changeOverlayStyle = useAnimatedStyle(() => {
    "worklet";
    const sign = changeSignSV.value;
    return {
      color:
        sign > 0
          ? palette.positive
          : sign < 0
            ? palette.negative
            : palette.overlaySubtle,
    };
  });

  const innerWidth = Math.max(1, layout.width - padding.left - padding.right);

  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        .onBegin((event) => {
          if (scrub) {
            // Scrub mode — crosshair
            hoverActiveSV.value = true;
            hoverXSV.value = event.x;
          } else {
            // Browse mode — kill momentum, snapshot offset
            panVelocitySV.value = 0;
            panStartOffsetSV.value = domainOffsetSV.value;
          }
        })
        .onUpdate((event) => {
          if (scrub) {
            hoverXSV.value = event.x;
          } else {
            // Convert px → seconds: negative translationX = browsing into past
            const secsPerPx = displayWindowSecsSV.value / innerWidth;
            domainOffsetSV.value =
              panStartOffsetSV.value - event.translationX * secsPerPx;
            if (domainOffsetSV.value > 0) domainOffsetSV.value = 0;
          }
        })
        .onFinalize((event) => {
          if (scrub) {
            hoverActiveSV.value = false;
            if (onHover) {
              runOnJS(onHover)(null);
            }
          } else {
            // Store velocity for momentum
            const secsPerPx = displayWindowSecsSV.value / innerWidth;
            panVelocitySV.value = (-event.velocityX * secsPerPx) / 1000;
          }
        }),
    [
      scrub,
      hoverActiveSV,
      hoverXSV,
      onHover,
      panVelocitySV,
      panStartOffsetSV,
      domainOffsetSV,
      displayWindowSecsSV,
      innerWidth,
    ],
  );

  const pinchGesture = useMemo(
    () =>
      Gesture.Pinch()
        .onBegin(() => {
          pinchBaseWindowSV.value = displayWindowSecsSV.value;
        })
        .onUpdate((event) => {
          const newWindow = pinchBaseWindowSV.value / event.scale;
          gestureWindowSecsSV.value = clamp(newWindow, 5, 86400);
        })
        .onEnd(() => {
          // After pinch, sync the closest preset button or deselect
          const finalWindow = gestureWindowSecsSV.value;
          if (windows && windows.length > 0) {
            let closestSecs = windows[0].secs;
            let closestDist = Math.abs(
              Math.log(finalWindow) - Math.log(closestSecs),
            );
            for (let i = 1; i < windows.length; i++) {
              const dist = Math.abs(
                Math.log(finalWindow) - Math.log(windows[i].secs),
              );
              if (dist < closestDist) {
                closestDist = dist;
                closestSecs = windows[i].secs;
              }
            }
            // Snap to preset if within 15% in log-space
            if (closestDist < 0.15) {
              gestureWindowSecsSV.value = closestSecs;
              runOnJS(setWindowOverride)(closestSecs);
            } else {
              runOnJS(setWindowOverride)(null);
            }
          }
        }),
    [pinchBaseWindowSV, displayWindowSecsSV, gestureWindowSecsSV, windows],
  );

  const doubleTapGesture = useMemo(
    () =>
      Gesture.Tap()
        .numberOfTaps(2)
        .onEnd(() => {
          domainOffsetSV.value = 0;
          panVelocitySV.value = 0;
          gestureWindowSecsSV.value = 0;
          isLiveSV.value = 1;
        }),
    [domainOffsetSV, panVelocitySV, gestureWindowSecsSV, isLiveSV],
  );

  const composedGesture = useMemo(
    () =>
      Gesture.Race(
        doubleTapGesture,
        Gesture.Simultaneous(panGesture, pinchGesture),
      ),
    [doubleTapGesture, panGesture, pinchGesture],
  );

  const chartCanvas = hasLayout ? (
    <Animated.View style={[styles.chartSurface, chartShakeStyle]}>
      <Canvas style={styles.canvas}>
        <Group>
          <Path
            path={referencePathSV}
            style="stroke"
            strokeWidth={1}
            color={palette.referenceLine}
          >
            {!hasReferenceLabel ? <DashPathEffect intervals={[4, 4]} /> : null}
          </Path>

          {referenceLine?.label ? (
            <SkiaText
              x={referenceLabelX}
              y={referenceLabelYSV}
              text={referenceLine.label}
              font={referenceFont}
              color={palette.referenceLabelText}
              opacity={referenceLabelOpacitySV}
            />
          ) : null}

          {grid
            ? Array.from({ length: Y_LABEL_SLOTS }, (_, i) => (
                <GridLine
                  key={`gl-${i}`}
                  index={i}
                  slotsSV={gridSlotsSV}
                  left={padding.left}
                  right={chartRight}
                  color={palette.grid}
                />
              ))
            : null}

          {orderbook
            ? Array.from({ length: MAX_ORDERBOOK_LABELS }, (_, i) => (
                <OrderbookLabel
                  key={`ob-${i}`}
                  index={i}
                  labelsSV={orderbookLabelsSV}
                  revealSV={chartRevealSV}
                  left={padding.left + 8}
                  font={orderbookFont}
                />
              ))
            : null}

          <Path
            path={loadingLinePathSV}
            style="stroke"
            strokeWidth={2}
            color={palette.line}
            opacity={loadingLineOpacitySV}
          />

          <Path
            path={loadingLinePathSV}
            style="stroke"
            strokeWidth={2}
            color={palette.gridLabel}
            opacity={emptyLineOpacitySV}
          />

          <Group clip={chartClipRectSV}>
            {!isMultiSeries
              ? scrub
                ? (
                    <>
                      <Group clip={leftClipRectSV}>
                        <Path
                          path={fillPathSV}
                          style="fill"
                          opacity={liveFillOpacitySV}
                        >
                          <LinearGradient
                            start={vec(0, padding.top)}
                            end={vec(0, chartBottom)}
                            colors={[palette.fillTop, palette.fillBottom]}
                          />
                        </Path>
                        <Path
                          path={linePathSV}
                          style="stroke"
                          strokeWidth={2}
                          strokeJoin="round"
                          strokeCap="round"
                          color={palette.line}
                          opacity={liveLineOpacitySV}
                        />
                      </Group>
                      <Group clip={rightClipRectSV}>
                        <Path
                          path={fillPathSV}
                          style="fill"
                          opacity={scrubDimFillOpacitySV}
                        >
                          <LinearGradient
                            start={vec(0, padding.top)}
                            end={vec(0, chartBottom)}
                            colors={[palette.fillTop, palette.fillBottom]}
                          />
                        </Path>
                        <Path
                          path={linePathSV}
                          style="stroke"
                          strokeWidth={2}
                          strokeJoin="round"
                          strokeCap="round"
                          color={palette.line}
                          opacity={scrubDimOpacitySV}
                        />
                      </Group>
                    </>
                  )
                : (
                    <>
                      <Path
                        path={fillPathSV}
                        style="fill"
                        opacity={liveFillOpacitySV}
                      >
                        <LinearGradient
                          start={vec(0, padding.top)}
                          end={vec(0, chartBottom)}
                          colors={[palette.fillTop, palette.fillBottom]}
                        />
                      </Path>
                      <Path
                        path={linePathSV}
                        style="stroke"
                        strokeWidth={2}
                        strokeJoin="round"
                        strokeCap="round"
                        color={palette.line}
                        opacity={liveLineOpacitySV}
                      />
                    </>
                  )
              : null}

            {isCandle ? (
              <>
                {/* Old candle paths (fading out during width morph) */}
                <Path
                  path={oldCandleBullPathSV}
                  style="fill"
                  color={candleBullColorSV}
                  opacity={candleOldOpacitySV}
                />
                <Path
                  path={oldCandleBearPathSV}
                  style="fill"
                  color={candleBearColorSV}
                  opacity={candleOldOpacitySV}
                />
                <Path
                  path={oldCandleBullWickPathSV}
                  style="fill"
                  color={candleBullColorSV}
                  opacity={candleOldOpacitySV}
                />
                <Path
                  path={oldCandleBearWickPathSV}
                  style="fill"
                  color={candleBearColorSV}
                  opacity={candleOldOpacitySV}
                />
                {/* New candle paths */}
                {scrub ? (
                  <>
                    <Group clip={leftClipRectSV}>
                      <Path
                        path={candleBullPathSV}
                        style="fill"
                        color={candleBullColorSV}
                        opacity={candleNewOpacitySV}
                      />
                      <Path
                        path={candleBearPathSV}
                        style="fill"
                        color={candleBearColorSV}
                        opacity={candleNewOpacitySV}
                      />
                      <Path
                        path={candleBullWickPathSV}
                        style="fill"
                        color={candleBullColorSV}
                        opacity={candleNewOpacitySV}
                      />
                      <Path
                        path={candleBearWickPathSV}
                        style="fill"
                        color={candleBearColorSV}
                        opacity={candleNewOpacitySV}
                      />
                    </Group>
                    <Group clip={rightClipRectSV}>
                      <Path
                        path={candleBullPathSV}
                        style="fill"
                        color={candleBullColorSV}
                        opacity={candleScrubDimOpacitySV}
                      />
                      <Path
                        path={candleBearPathSV}
                        style="fill"
                        color={candleBearColorSV}
                        opacity={candleScrubDimOpacitySV}
                      />
                      <Path
                        path={candleBullWickPathSV}
                        style="fill"
                        color={candleBullColorSV}
                        opacity={candleScrubDimOpacitySV}
                      />
                      <Path
                        path={candleBearWickPathSV}
                        style="fill"
                        color={candleBearColorSV}
                        opacity={candleScrubDimOpacitySV}
                      />
                    </Group>
                  </>
                ) : (
                  <>
                    <Path
                      path={candleBullPathSV}
                      style="fill"
                      color={candleBullColorSV}
                      opacity={candleNewOpacitySV}
                    />
                    <Path
                      path={candleBearPathSV}
                      style="fill"
                      color={candleBearColorSV}
                      opacity={candleNewOpacitySV}
                    />
                    <Path
                      path={candleBullWickPathSV}
                      style="fill"
                      color={candleBullColorSV}
                      opacity={candleNewOpacitySV}
                    />
                    <Path
                      path={candleBearWickPathSV}
                      style="fill"
                      color={candleBearColorSV}
                      opacity={candleNewOpacitySV}
                    />
                  </>
                )}
                <Path
                  path={candleLiveGlowPathSV}
                  style="fill"
                  color={candleGlowColorSV}
                  opacity={candleGlowOpacitySV}
                />
                {/* Close price: candle-colored dashed line (fades out during morph) */}
                <Path
                  path={closePricePathSV}
                  style="stroke"
                  strokeWidth={1}
                  color={candleGlowColorSV}
                  opacity={closePriceCandleOpacitySV}
                >
                  <DashPathEffect intervals={[4, 4]} />
                </Path>
                {/* Close price: accent-colored dashed line (fades in during morph) */}
                <Path
                  path={closePricePathSV}
                  style="stroke"
                  strokeWidth={1}
                  color={palette.lineSoft}
                  opacity={closePriceAccentOpacitySV}
                >
                  <DashPathEffect intervals={[4, 4]} />
                </Path>
              </>
            ) : null}

            {isMultiSeries
              ? seriesPathSVs.map((pathSV, i) => (
                  <SeriesLine
                    key={`sl-${i}`}
                    index={i}
                    pathSV={pathSV}
                    slotsSV={seriesSlotsSV}
                    chartRevealSV={chartRevealSV}
                  />
                ))
              : null}
          </Group>

          {!hasData ? (
            <>
              <Rect
                x={emptyGapLeft}
                y={centerY - emptyGapHeight * 0.5}
                width={Math.max(0, emptyGapWidth)}
                height={Math.max(0, emptyGapHeight)}
                opacity={emptyOpacitySV}
                blendMode="dstOut"
              >
                <LinearGradient
                  start={vec(emptyGapLeft, 0)}
                  end={vec(emptyGapLeft + Math.max(1, emptyGapWidth), 0)}
                  colors={["transparent", "black", "black", "transparent"]}
                  positions={[
                    0,
                    Math.min(0.49, emptyGapFade / Math.max(1, emptyGapWidth)),
                    Math.max(
                      0.51,
                      1 - emptyGapFade / Math.max(1, emptyGapWidth),
                    ),
                    1,
                  ]}
                />
              </Rect>
              <SkiaText
                x={emptyTextX}
                y={emptyTextY}
                text={emptyLabel}
                font={emptyFont}
                color={palette.gridLabel}
                opacity={emptyTextOpacitySV}
              />
            </>
          ) : null}

          <Rect
            x={0}
            y={padding.top}
            width={padding.left + 40}
            height={Math.max(0, chartBottom - padding.top)}
            blendMode="dstOut"
          >
            <LinearGradient
              start={vec(padding.left, 0)}
              end={vec(padding.left + 40, 0)}
              colors={["black", "transparent"]}
            />
          </Rect>

          {!isMultiSeries ? (
            <Path
              path={currentLinePathSV}
              style="stroke"
              strokeWidth={1}
              color={palette.lineSoft}
              opacity={dashLineOpacitySV}
            >
              <DashPathEffect intervals={[4, 4]} />
            </Path>
          ) : null}

          <Path
            path={hoverLinePathSV}
            style="stroke"
            strokeWidth={1}
            color={palette.crosshairLine}
            opacity={crosshairLineOpacitySV}
          />

          {isMultiSeries
            ? Array.from({ length: 8 }, (_, i) => (
                <SeriesPulse
                  key={`sp-${i}`}
                  index={i}
                  slotsSV={seriesSlotsSV}
                  chartRevealSV={chartRevealSV}
                  pulseRadiusSV={pulseRadiusSV}
                  pulseOpacitySV={pulseOpacitySV}
                  pauseProgressSV={pauseProgressSV}
                />
              ))
            : null}

          {isMultiSeries
            ? Array.from({ length: 8 }, (_, i) => (
                <SeriesDot
                  key={`sd-${i}`}
                  index={i}
                  slotsSV={seriesSlotsSV}
                  chartRevealSV={chartRevealSV}
                />
              ))
            : null}

          {isMultiSeries
            ? Array.from({ length: 8 }, (_, i) => (
                <SeriesEndLabel
                  key={`sl-${i}`}
                  index={i}
                  slotsSV={seriesSlotsSV}
                  chartRevealSV={chartRevealSV}
                  font={seriesEndLabelFont}
                />
              ))
            : null}

          {isMultiSeries && scrub
            ? Array.from({ length: 8 }, (_, i) => (
                <MultiCrosshairDot
                  key={`mc-${i}`}
                  index={i}
                  hoverXSV={hoverXSV}
                  multiCrosshairResultSV={multiCrosshairResultSV}
                  crosshairOpacitySV={crosshairOpacitySV}
                />
              ))
            : null}

          {!isMultiSeries ? (
            <>
              <Circle
                cx={dotXSV}
                cy={dotYSV}
                r={9}
                color={palette.badgeOuterShadow}
                opacity={liveGlowOpacitySV}
              />

              <Circle
                cx={dotXSV}
                cy={dotYSV}
                r={pulseRadiusSV}
                color={palette.line}
                opacity={pulseDrawOpacitySV}
                style="stroke"
                strokeWidth={1.5}
              />

              <Circle
                cx={dotXSV}
                cy={dotYSV}
                r={6.5}
                color={palette.badgeOuterBg}
                opacity={liveDotOpacitySV}
              />

              <Circle
                cx={dotXSV}
                cy={dotYSV}
                r={3.5}
                color={palette.dot}
                opacity={liveDotOpacitySV}
              />
            </>
          ) : null}

          {!isMultiSeries ? (
            <Circle
              cx={hoverXSV}
              cy={hoverYSV}
              r={4}
              color={palette.dot}
              opacity={hoverDotOpacitySV}
            />
          ) : null}

          {degenEnabled ? (
            <>
              <Path
                path={particlePathHighSV}
                style="fill"
                color={palette.line}
                opacity={0.46}
              />
              <Path
                path={particlePathMidSV}
                style="fill"
                color={palette.line}
                opacity={0.27}
              />
              <Path
                path={particlePathLowSV}
                style="fill"
                color={palette.line}
                opacity={0.09}
              />
            </>
          ) : null}

          {grid
            ? Array.from({ length: Y_LABEL_SLOTS }, (_, i) => (
                <AxisYLabel
                  key={`y-${i}`}
                  index={i}
                  slotsSV={gridSlotsSV}
                  color={palette.gridLabel}
                  x={layout.width - padding.right + 8}
                  font={axisLabelFont}
                />
              ))
            : null}

          {grid
            ? Array.from({ length: X_LABEL_SLOTS }, (_, i) => (
                <AxisXLabel
                  key={`x-${i}`}
                  index={i}
                  slotsSV={timeSlotsSV}
                  color={palette.timeLabel}
                  tickColor={palette.gridLine}
                  bottomY={chartBottom}
                  leftBound={padding.left}
                  rightBound={chartRight}
                  charWidth={axisCharWidth}
                  font={axisLabelFont}
                />
              ))
            : null}

          {badge ? (
            <>
              <Path
                path={badgePathSV}
                style="fill"
                color={
                  badgeVariant === "minimal"
                    ? palette.badgeOuterBg
                    : badgeColorSV
                }
                opacity={badgeOpacitySV}
              />
              <BadgeValueText
                badgeTextSV={badgeTextSV}
                badgeYSV={badgeYSV}
                dotYSV={dotYSV}
                opacitySV={badgeOpacitySV}
                x={layout.width - padding.right + 8}
                baselineOffset={badgeTextBaselineOffset}
                color={
                  badgeVariant === "minimal"
                    ? palette.tooltipText
                    : palette.badgeText
                }
                font={badgeFont}
              />
            </>
          ) : null}

          <Path
            path={arrowUpChevron0SV}
            style="stroke"
            strokeWidth={2.5}
            strokeCap="round"
            strokeJoin="round"
            color={palette.gridLabel}
            opacity={upChevron0OpacitySV}
          />
          <Path
            path={arrowUpChevron1SV}
            style="stroke"
            strokeWidth={2.5}
            strokeCap="round"
            strokeJoin="round"
            color={palette.gridLabel}
            opacity={upChevron1OpacitySV}
          />
          <Path
            path={arrowDownChevron0SV}
            style="stroke"
            strokeWidth={2.5}
            strokeCap="round"
            strokeJoin="round"
            color={palette.gridLabel}
            opacity={downChevron0OpacitySV}
          />
          <Path
            path={arrowDownChevron1SV}
            style="stroke"
            strokeWidth={2.5}
            strokeCap="round"
            strokeJoin="round"
            color={palette.gridLabel}
            opacity={downChevron1OpacitySV}
          />

          {scrub ? (
            isMultiSeries ? (
              <MultiCrosshairTopLabel
                crosshairOpacitySV={crosshairOpacitySV}
                hoverXSV={hoverXSV}
                liveDotXSV={dotXSV}
                multiCrosshairResultSV={multiCrosshairResultSV}
                leftBound={padding.left}
                rightBound={chartRight}
                top={padding.top + tooltipY}
                textColor={palette.overlay}
                outlineColor={palette.tooltipBg}
                tooltipOutline={tooltipOutline}
                charWidth={tooltipCharWidth}
                font={tooltipFont}
              />
            ) : isCandle ? (
              <CandleCrosshairLabel
                crosshairOpacitySV={crosshairOpacitySV}
                lineModeProgressSV={lineModeProgressSV}
                hoverXSV={hoverXSV}
                liveDotXSV={dotXSV}
                oSV={candleCrosshairOSV}
                hSV={candleCrosshairHSV}
                lSV={candleCrosshairLSV}
                cSV={candleCrosshairCSV}
                timeSV={candleCrosshairTimeSV}
                bullSV={candleCrosshairBullSV}
                leftBound={padding.left}
                rightBound={chartRight}
                top={padding.top + tooltipY}
                labelColor={palette.overlaySubtle}
                lineColor={palette.line}
                outlineColor={palette.tooltipBg}
                tooltipOutline={tooltipOutline}
                charWidth={tooltipCharWidth}
                font={tooltipFont}
              />
            ) : (
              <CrosshairTopLabel
                crosshairOpacitySV={crosshairOpacitySV}
                hoverXSV={hoverXSV}
                liveDotXSV={dotXSV}
                hoverValueTextSV={hoverValueTextSV}
                hoverTimeTextSV={hoverTimeTextSV}
                leftBound={padding.left}
                rightBound={chartRight}
                top={padding.top + tooltipY}
                textColor={palette.overlay}
                dividerColor={palette.overlaySubtle}
                outlineColor={palette.tooltipBg}
                tooltipOutline={tooltipOutline}
                charWidth={tooltipCharWidth}
                separatorWidth={tooltipSeparatorWidth}
                font={tooltipFont}
              />
            )
          ) : null}
        </Group>
      </Canvas>
    </Animated.View>
  ) : null;

  const hasControls =
    (windows && windows.length > 0) || onModeChange || showSeriesToggle;

  const handleWindowChange = (secs: number) => {
    setWindowOverride(secs);
    gestureWindowSecsSV.value = 0;
    domainOffsetSV.value = 0;
    panVelocitySV.value = 0;
    isLiveSV.value = 1;
    onWindowChange?.(secs);
  };

  const renderWindowControlsProps: LivelineWindowControlsRenderProps | null =
    windows && windows.length > 0
      ? {
          windows,
          activeWindowSecs,
          onWindowChange: handleWindowChange,
          isDark,
          windowStyle,
          windowPosition,
        }
      : null;

  const shouldOverlayRightControls = windowPosition === "right" && showValue;
  const hasPrimaryControls = (windows && windows.length > 0) || !!onModeChange;
  const controlsAvailableWidth = Math.max(
    0,
    layout.width -
      (windowPosition === "left"
        ? padding.left
        : windowPosition === "right" && !shouldOverlayRightControls
          ? padding.right
          : 0),
  );
  const shouldStackControls =
    hasPrimaryControls &&
    showSeriesToggle &&
    controlsAvailableWidth > 0 &&
    controlsPrimaryWidth > 0 &&
    controlsSeriesWidth > 0 &&
    controlsPrimaryWidth + controlsSeriesWidth + 6 > controlsAvailableWidth;

  const controlsAlignmentStyle =
    windowPosition === "bottom"
      ? { alignSelf: "center" as const }
      : windowPosition === "right"
      ? shouldOverlayRightControls
        ? {
            position: "absolute" as const,
            top: 4,
            right: padding.right,
            zIndex: 2,
          }
        : {
            alignSelf: "flex-end" as const,
            marginRight: padding.right,
          }
      : {
          alignSelf: "flex-start" as const,
          marginLeft: padding.left,
        };

  const controlsPositionStyle =
    shouldOverlayRightControls
      ? null
      : windowPosition === "bottom"
        ? styles.controlsRowBottom
        : styles.controlsRowTop;

  const controlsStackAlignmentStyle = shouldStackControls
    ? windowPosition === "bottom"
      ? { alignItems: "center" as const }
      : windowPosition === "right"
        ? { alignItems: "flex-end" as const }
        : { alignItems: "flex-start" as const }
    : null;

  const primaryControls = hasPrimaryControls ? (
    <View
      style={styles.bottomControlsRow}
      onLayout={(event) => {
        const nextWidth = event.nativeEvent.layout.width;
        setControlsPrimaryWidth((prev) =>
          Math.abs(prev - nextWidth) < LAYOUT_EPSILON ? prev : nextWidth,
        );
      }}
    >
      {renderWindowControlsProps
        ? (renderWindowControls?.(renderWindowControlsProps) ?? (
            <WindowControls
              windows={renderWindowControlsProps.windows}
              activeWindowSecs={renderWindowControlsProps.activeWindowSecs}
              onChange={renderWindowControlsProps.onWindowChange}
              styleVariant={renderWindowControlsProps.windowStyle}
              isDark={renderWindowControlsProps.isDark}
            />
          ))
        : null}
      {onModeChange ? (
        <ModeToggle
          mode={mode}
          onModeChange={onModeChange}
          isDark={isDark}
          styleVariant={windowStyle}
        />
      ) : null}
    </View>
  ) : null;

  const seriesControls = showSeriesToggle ? (
    <View
      onLayout={(event) => {
        const nextWidth = event.nativeEvent.layout.width;
        setControlsSeriesWidth((prev) =>
          Math.abs(prev - nextWidth) < LAYOUT_EPSILON ? prev : nextWidth,
        );
      }}
      pointerEvents={isMultiSeries ? "auto" : "none"}
      style={[
        styles.seriesToggleRow,
        {
          gap: windowStyle === "text" ? 4 : 2,
          backgroundColor:
            windowStyle === "text"
              ? "transparent"
              : isDark
                ? "rgba(255,255,255,0.03)"
                : "rgba(0,0,0,0.02)",
          borderRadius: windowStyle === "rounded" ? 999 : 6,
          padding:
            windowStyle === "text"
              ? 0
              : windowStyle === "rounded"
                ? 3
                : 2,
          opacity: isMultiSeries ? 1 : 0,
        },
      ]}
    >
      {seriesForToggle.map((s) => {
        const hidden = hiddenSeries.has(s.id);
        const labelText = s.label ?? s.id;
        const compactDotSize = seriesToggleCompact ? 8 : 6;
        return (
          <Pressable
            key={s.id}
            style={[
              styles.seriesChip,
              {
                opacity: hidden ? 0.4 : 1,
                paddingHorizontal: seriesToggleCompact
                  ? windowStyle === "text"
                    ? 4
                    : 7
                  : windowStyle === "text"
                    ? 6
                    : 8,
                paddingVertical: seriesToggleCompact
                  ? windowStyle === "text"
                    ? 2
                    : 5
                  : windowStyle === "text"
                    ? 2
                    : 3,
                borderRadius: windowStyle === "rounded" ? 999 : 4,
                backgroundColor: hidden
                  ? "transparent"
                  : windowStyle === "text"
                    ? "transparent"
                    : isDark
                      ? "rgba(255,255,255,0.06)"
                      : "rgba(0,0,0,0.035)",
                gap: seriesToggleCompact ? 0 : 4,
              },
            ]}
            onPress={() => handleSeriesToggle(s.id)}
          >
            <View
              style={[
                styles.seriesChipDot,
                {
                  width: compactDotSize,
                  height: compactDotSize,
                  borderRadius: compactDotSize / 2,
                  backgroundColor: s.color,
                  opacity: hidden ? 0.4 : 1,
                },
              ]}
            />
            {!seriesToggleCompact ? (
              <Text
                style={[
                  styles.seriesChipLabel,
                  {
                    color: isDark
                      ? "rgba(255,255,255,0.7)"
                      : "rgba(0,0,0,0.6)",
                  },
                ]}
              >
                {labelText}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  ) : null;

  const controls = hasControls ? (
    <View
      style={[
        styles.controlsRow,
        controlsPositionStyle,
        controlsAlignmentStyle,
        shouldStackControls ? styles.controlsRowStacked : null,
        controlsStackAlignmentStyle,
      ]}
    >
      {shouldStackControls ? (
        <>
          {seriesControls}
          {primaryControls}
        </>
      ) : (
        <>
          {primaryControls}
          {seriesControls}
        </>
      )}
    </View>
  ) : null;

  const valueDisplay = showValue ? (
    <AnimatedTextInput
      editable={false}
      multiline={false}
      pointerEvents="none"
      underlineColorAndroid="transparent"
      style={[
        styles.valueOverlay,
        { paddingLeft: padding.left },
        showChange ? styles.valueOverlayWithChange : null,
        valueOverlayStyle,
      ]}
      animatedProps={valueOverlayProps}
    />
  ) : null;

  const changeDisplay = showChange ? (
    <AnimatedTextInput
      editable={false}
      multiline={false}
      pointerEvents="none"
      underlineColorAndroid="transparent"
      style={[styles.changeOverlay, { paddingLeft: padding.left }, changeOverlayStyle]}
      animatedProps={changeOverlayProps}
    />
  ) : null;

  return (
    <View ref={containerRef} style={[styles.container, style]}>
      {valueDisplay}
      {changeDisplay}
      {windowPosition === "bottom" ? null : controls}

      <View style={styles.chartFrame} onLayout={onLayout}>
        {chartCanvas ? (
          <GestureDetector gesture={composedGesture}>{chartCanvas}</GestureDetector>
        ) : null}
      </View>

      {windowPosition === "bottom" ? controls : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: "100%",
    height: "100%",
    position: "relative",
  },
  chartSurface: {
    ...StyleSheet.absoluteFillObject,
  },
  canvas: {
    ...StyleSheet.absoluteFillObject,
  },
  chartFrame: {
    flex: 1,
    position: "relative",
  },
  controlsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  controlsRowStacked: {
    flexDirection: "column",
  },
  controlsRowTop: {
    marginBottom: 6,
  },
  controlsRowBottom: {
    marginTop: 6,
  },
  valueOverlay: {
    fontFamily: "System",
    fontSize: 20,
    fontWeight: "500",
    letterSpacing: -0.2,
    lineHeight: 24,
    marginBottom: 8,
    paddingTop: 4,
    includeFontPadding: false,
  },
  valueOverlayWithChange: {
    marginBottom: 2,
  },
  changeOverlay: {
    fontFamily: "System",
    fontSize: 12,
    fontWeight: "500",
    letterSpacing: -0.1,
    lineHeight: 16,
    marginBottom: 8,
    includeFontPadding: false,
  },
  windowRow: {
    position: "relative",
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 6,
    gap: 2,
    padding: 2,
  },
  windowRowRounded: {
    borderRadius: 999,
    padding: 3,
  },
  windowRowText: {
    backgroundColor: "transparent",
    padding: 0,
    gap: 4,
  },
  windowBtn: {
    zIndex: 1,
    borderRadius: 4,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  windowIndicator: {
    position: "absolute",
    left: 0,
  },
  windowBtnRounded: {
    borderRadius: 999,
  },
  windowBtnText: {
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  windowBtnTextLabel: {
    fontFamily: "System",
    fontSize: 11,
    lineHeight: 16,
  },
  modeBtn: {
    zIndex: 1,
    borderRadius: 4,
    paddingHorizontal: 7,
    paddingVertical: 5,
  },
  modeBtnRounded: {
    borderRadius: 999,
  },
  bottomControlsRow: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 6,
  },
  seriesToggleRow: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 8,
  },
  seriesChip: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    zIndex: 1,
  },
  seriesChipDot: {
    flexShrink: 0,
  },
  seriesChipLabel: {
    fontFamily: "System",
    fontSize: 11,
    fontWeight: "500" as const,
    lineHeight: 16,
  },
});
