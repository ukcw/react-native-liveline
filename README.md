# React Native Liveline

Real-time animated charts for React Native. Line, candlestick, and multi-series modes, rendered with Skia and driven by Reanimated worklets.

## Features

- 60fps/120fps-friendly animation pipeline on the UI thread
- Line + candlestick + multi-series chart modes
- Crosshair scrubbing, hover callbacks, and smart time/grid labels
- Momentum visuals (pulse dot, arrows), degen particles, and orderbook overlays
- Loading, paused, and empty states with transition choreography
- Fully typed API with rich customization options

## Installation

```bash
# npm
npm install react-native-liveline @shopify/react-native-skia react-native-reanimated react-native-gesture-handler

# bun
bun add react-native-liveline @shopify/react-native-skia react-native-reanimated react-native-gesture-handler

# expo
npx expo install react-native-liveline @shopify/react-native-skia react-native-reanimated react-native-gesture-handler
```

## Compatibility

| Package | Supported version |
| --- | --- |
| `react` | `>=18` |
| `react-native` | `>=0.79` |
| `react-native-reanimated` | `>=3.0.0` |
| `react-native-gesture-handler` | `>=2.0.0` |
| `@shopify/react-native-skia` | `>=2.0.0` |

## Development

```bash
bun install
bun run typecheck
```

## Example App

This repo includes an Expo demo app at `example/` that mirrors the app repo's Liveline dev screen.

```bash
cd example
bun install
npx expo install react-native-gesture-handler react-native-reanimated @shopify/react-native-skia react-native-safe-area-context
bun run start
```

### Required setup

`react-native-reanimated` requires its Babel plugin. In `babel.config.js`:

```js
module.exports = {
  presets: ["babel-preset-expo"],
  plugins: ["react-native-reanimated/plugin"],
};
```

Wrap your app root with `GestureHandlerRootView` per `react-native-gesture-handler` setup docs.

## Quick start

```tsx
import { useMemo, useState } from "react";
import { View } from "react-native";
import { Liveline, type LivelinePoint } from "react-native-liveline";

export function ChartCard() {
  const [value] = useState(104_250);

  const data = useMemo<LivelinePoint[]>(() => {
    const now = Math.floor(Date.now() / 1000);
    return Array.from({ length: 180 }, (_, i) => ({
      time: now - (179 - i),
      value: 103_900 + Math.sin(i / 10) * 220 + i * 0.4,
    }));
  }, []);

  return (
    <View style={{ height: 280 }}>
      <Liveline data={data} value={value} color="#3b82f6" theme="dark" />
    </View>
  );
}
```

The chart fills its parent container. Give the parent an explicit height.

## Props

### Data

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `data` | `LivelinePoint[]` | required | Time-series points `{ time, value }` in unix seconds |
| `value` | `number` | required | Latest value used for smooth interpolation |

### Appearance

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `theme` | `"light" \| "dark"` | `"dark"` | Color theme |
| `color` | `string` | `"#3b82f6"` | Accent color used to derive palette |
| `grid` | `boolean` | `true` | Show Y-axis grid + labels |
| `badge` | `boolean` | `true` | Show live value badge |
| `badgeVariant` | `"default" \| "minimal"` | `"default"` | Badge visual style |
| `badgeTail` | `boolean` | `true` | Show badge tail notch |
| `fill` | `boolean` | `true` | Gradient fill under line |
| `pulse` | `boolean` | `true` | Show pulse ring on live dot |

### Behavior

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `momentum` | `boolean \| "up" \| "down" \| "flat"` | `true` | Momentum-driven visual cues |
| `scrub` | `boolean` | `true` | Enable crosshair scrubbing |
| `loading` | `boolean` | `false` | Loading animation mode |
| `paused` | `boolean` | `false` | Freeze chart progression |
| `emptyText` | `string` | `"No data to display"` | Empty-state copy |
| `exaggerate` | `boolean` | `false` | Tighten Y-range to emphasize small moves |
| `showValue` | `boolean` | `false` | Show large top value readout |
| `showChange` | `boolean` | `false` | Show value delta readout |
| `valueMomentumColor` | `boolean` | `false` | Tint value text by momentum |
| `degen` | `boolean \| DegenOptions` | `false` | Particles + shake effects |

### Time controls

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `window` | `number` | `30` | Visible time window in seconds |
| `windows` | `WindowOption[]` | — | Preset window buttons |
| `onWindowChange` | `(secs: number) => void` | — | Window selection callback |
| `windowStyle` | `"default" \| "rounded" \| "text"` | `"default"` | Control visual style |
| `windowPosition` | `"left" \| "right" \| "bottom"` | `"right"` | Control placement |
| `renderWindowControls` | `(props) => ReactNode` | — | Custom control renderer |

### Candlestick mode

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | `"line" \| "candle"` | `"line"` | Chart mode |
| `candles` | `CandlePoint[]` | — | Committed OHLC candles |
| `candleWidth` | `number` | — | Candle width in seconds |
| `liveCandle` | `CandlePoint` | — | Current in-progress candle |
| `lineMode` | `boolean` | `false` | Morph candles into line view |
| `lineData` | `LivelinePoint[]` | — | Tick data for line morph density |
| `lineValue` | `number` | — | Live tick value for line morph |
| `onModeChange` | `(mode) => void` | — | Built-in line/candle toggle callback |

### Multi-series mode

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `series` | `LivelineSeries[]` | — | Multiple lines drawn on shared axes |
| `onSeriesToggle` | `(id: string, visible: boolean) => void` | — | Series visibility callback |
| `seriesToggleCompact` | `boolean` | `false` | Compact toggle chips |

### Advanced

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `tooltipY` | `number` | `14` | Crosshair tooltip vertical offset |
| `tooltipOutline` | `boolean` | `true` | Stroke outline on tooltip text |
| `orderbook` | `OrderbookData` | — | Bid/ask depth overlay |
| `referenceLine` | `ReferenceLine` | — | Horizontal reference marker |
| `formatValue` | `(v: number) => string` | `v.toFixed(2)` | JS-thread value formatter |
| `formatValueWorklet` | `(v: number) => string` | — | UI-thread value formatter |
| `formatTimeWorklet` | `(tMs: number) => string` | — | Legacy UI-thread time formatter |
| `timeFormatPreset` | `TimeFormatPreset` | `"auto"` | Global time preset |
| `axisTimeFormatPreset` | `TimeFormatPreset` | `"auto"` | Axis-only time preset |
| `crosshairTimeFormatPreset` | `TimeFormatPreset` | `"auto"` | Crosshair-only time preset |
| `formatAxisTimeWorklet` | `(tMs, windowSecs, intervalSecs) => string` | — | Axis formatter override |
| `formatCrosshairTimeWorklet` | `(tMs, windowSecs) => string` | — | Crosshair formatter override |
| `lerpSpeed` | `number` | `0.08` | Interpolation speed |
| `padding` | `Padding` | `{ top: 12, right: 80, bottom: 28, left: 12 }` | Chart padding override |
| `onHoverWorklet` | `(point: HoverPoint \| null) => void` | — | UI-thread crosshair hover callback (worklet) |
| `style` | `StyleProp<ViewStyle>` | — | Container style |

## Examples

### Basic line chart

```tsx
<Liveline data={data} value={value} color="#3b82f6" theme="dark" />
```

### Candlestick with mode toggle

```tsx
<Liveline
  mode="candle"
  data={ticks}
  value={latestTick}
  candles={candles}
  liveCandle={liveCandle}
  candleWidth={60}
  lineMode={showLine}
  lineData={ticks}
  lineValue={latestTick}
  onModeChange={(mode) => setShowLine(mode === "line")}
/>
```

### Multi-series

```tsx
<Liveline
  data={[]}
  value={0}
  series={[
    { id: "yes", data: yesData, value: yesValue, color: "#3b82f6", label: "Yes" },
    { id: "no", data: noData, value: noValue, color: "#ef4444", label: "No" },
  ]}
  onSeriesToggle={(id, visible) => console.log(id, visible)}
/>
```

## Attribution

This package is a React Native implementation inspired by the original web `liveline` project by Benji Taylor.

## License

MIT
