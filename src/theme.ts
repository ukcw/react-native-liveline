import type { HSL, LivelineSeries, Palette, RGB } from "./types";

const clamp = (n: number, min: number, max: number) =>
  Math.min(max, Math.max(min, n));

const hexToRgb = (hex: string): RGB | null => {
  const v = hex.replace("#", "").trim();
  const isShort = v.length === 3;
  const isLong = v.length === 6;
  if (!isShort && !isLong) return null;

  const full = isShort ? `${v[0]}${v[0]}${v[1]}${v[1]}${v[2]}${v[2]}` : v;
  const int = Number.parseInt(full, 16);
  if (Number.isNaN(int)) return null;

  return {
    r: (int >> 16) & 255,
    g: (int >> 8) & 255,
    b: int & 255,
  };
};

const rgbToHsl = ({ r, g, b }: RGB): HSL => {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

    switch (max) {
      case rn:
        h = (gn - bn) / d + (gn < bn ? 6 : 0);
        break;
      case gn:
        h = (bn - rn) / d + 2;
        break;
      default:
        h = (rn - gn) / d + 4;
        break;
    }

    h /= 6;
  }

  return { h: h * 360, s: s * 100, l: l * 100 };
};

const hslToRgb = ({ h, s, l }: HSL): RGB => {
  const hn = ((h % 360) + 360) % 360;
  const sn = clamp(s, 0, 100) / 100;
  const ln = clamp(l, 0, 100) / 100;

  if (sn === 0) {
    const v = Math.round(ln * 255);
    return { r: v, g: v, b: v };
  }

  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const x = c * (1 - Math.abs(((hn / 60) % 2) - 1));
  const m = ln - c / 2;

  let r = 0;
  let g = 0;
  let b = 0;
  if (hn < 60) {
    r = c;
    g = x;
  } else if (hn < 120) {
    r = x;
    g = c;
  } else if (hn < 180) {
    g = c;
    b = x;
  } else if (hn < 240) {
    g = x;
    b = c;
  } else if (hn < 300) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }

  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
};

const parseColorToHsl = (input: string): HSL => {
  const color = input.trim();
  if (color.startsWith("#")) {
    const rgb = hexToRgb(color);
    if (rgb) return rgbToHsl(rgb);
  }

  const rgbMatch = color.match(
    /^rgba?\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)(?:,\s*(\d+(?:\.\d+)?))?\)$/i,
  );
  if (rgbMatch) {
    return rgbToHsl({
      r: Number(rgbMatch[1]),
      g: Number(rgbMatch[2]),
      b: Number(rgbMatch[3]),
    });
  }

  const hslMatch = color.match(
    /^hsla?\((\-?\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)%,\s*(\d+(?:\.\d+)?)%(?:,\s*(\d+(?:\.\d+)?))?\)$/i,
  );
  if (hslMatch) {
    return {
      h: Number(hslMatch[1]),
      s: Number(hslMatch[2]),
      l: Number(hslMatch[3]),
    };
  }

  return rgbToHsl({ r: 59, g: 130, b: 246 });
};

const rgba = (rgb: RGB, alpha: number) =>
  `rgba(${Math.round(rgb.r)}, ${Math.round(rgb.g)}, ${Math.round(rgb.b)}, ${alpha})`;

export const derivePalette = (
  baseColor: string,
  theme: "light" | "dark",
): Palette => {
  const rgb = hslToRgb(parseColorToHsl(baseColor));
  const isDark = theme === "dark";

  return {
    line: baseColor,
    lineSoft: rgba(rgb, 0.4),
    fillTop: rgba(rgb, isDark ? 0.12 : 0.08),
    fillBottom: rgba(rgb, 0),
    dot: baseColor,
    glow: rgba(rgb, 0.12),
    grid: isDark ? "rgba(255, 255, 255, 0.06)" : "rgba(0, 0, 0, 0.06)",
    gridLine: isDark ? "rgba(255, 255, 255, 0.06)" : "rgba(0, 0, 0, 0.06)",
    label: isDark ? "rgba(255, 255, 255, 0.4)" : "rgba(0, 0, 0, 0.35)",
    gridLabel: isDark ? "rgba(255, 255, 255, 0.4)" : "rgba(0, 0, 0, 0.35)",
    timeLabel: isDark ? "rgba(255, 255, 255, 0.35)" : "rgba(0, 0, 0, 0.3)",
    tooltipBg: isDark ? "rgba(30, 30, 30, 0.95)" : "rgba(255, 255, 255, 0.95)",
    tooltipText: isDark ? "#e5e5e5" : "#1a1a1a",
    tooltipBorder: isDark ? "rgba(255, 255, 255, 0.1)" : "rgba(0, 0, 0, 0.08)",
    crosshairLine: isDark ? "rgba(255, 255, 255, 0.2)" : "rgba(0, 0, 0, 0.12)",
    badgeOuterBg: isDark
      ? "rgba(40, 40, 40, 0.95)"
      : "rgba(255, 255, 255, 0.95)",
    badgeOuterShadow: isDark ? "rgba(0, 0, 0, 0.4)" : "rgba(0, 0, 0, 0.15)",
    badgeBg: baseColor,
    badgeText: "#ffffff",
    positive: "rgb(34,197,94)",
    negative: "rgb(239,68,68)",
    neutral: baseColor,
    overlay: isDark ? "rgba(255,255,255,0.85)" : "#111111",
    overlaySubtle: isDark ? "rgba(255, 255, 255, 0.35)" : "rgba(0, 0, 0, 0.3)",
    referenceLine: isDark ? "rgba(255, 255, 255, 0.15)" : "rgba(0, 0, 0, 0.12)",
    referenceLabelBg: isDark
      ? "rgba(40, 40, 40, 0.95)"
      : "rgba(255, 255, 255, 0.95)",
    referenceLabelText: isDark
      ? "rgba(255, 255, 255, 0.45)"
      : "rgba(0, 0, 0, 0.4)",
  };
};

export const SERIES_COLORS = [
  "#3b82f6", // blue
  "#ef4444", // red
  "#22c55e", // green
  "#f59e0b", // amber
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#06b6d4", // cyan
  "#f97316", // orange
];

export function resolveSeriesPalettes(
  series: LivelineSeries[],
  mode: "light" | "dark",
): Map<string, Palette> {
  const map = new Map<string, Palette>();
  for (let i = 0; i < series.length; i++) {
    const s = series[i];
    map.set(s.id, derivePalette(s.color, mode));
  }
  return map;
}
