import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { runOnJS } from "react-native-reanimated";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import {
  Liveline,
  type CandlePoint,
  type HoverPoint,
  type LivelinePoint,
  type WindowOption,
} from "react-native-liveline";

interface FeedState {
  points: LivelinePoint[];
  value: number;
  tick: number;
  anchor: number;
}

interface ScenarioProfile {
  driftBps: number;
  volatilityBps: number;
  meanRevert: number;
  spikeChance: number;
  spikeBps: number;
}

const CRYPTO_WINDOWS: WindowOption[] = [
  { label: "30s", secs: 30 },
  { label: "1m", secs: 60 },
  { label: "5m", secs: 300 },
];

const CRYPTO_PROFILE: ScenarioProfile = {
  driftBps: 0.45,
  volatilityBps: 28,
  meanRevert: 0.02,
  spikeChance: 0.018,
  spikeBps: 65,
};

const CANDLE_WIDTH_SECS = 15;

function seededNoise(seed: number) {
  const raw = Math.sin(seed * 12.9898) * 43758.5453;
  return raw - Math.floor(raw);
}

function evolveValue(
  current: number,
  tick: number,
  profile: ScenarioProfile,
  anchor: number,
) {
  const driftUnit = anchor / 10_000;
  const randomDrift =
    (seededNoise(tick * 1.37) * 2 - 1) * profile.volatilityBps * driftUnit;
  const trendDrift = profile.driftBps * driftUnit;
  const meanReversion = (anchor - current) * profile.meanRevert;
  const shouldSpike = seededNoise(tick * 2.91) < profile.spikeChance;
  const spike = shouldSpike
    ? (seededNoise(tick * 4.23) * 2 - 1) * profile.spikeBps * driftUnit
    : 0;

  return Math.max(
    1,
    current + trendDrift + randomDrift + meanReversion + spike,
  );
}

function createSeedFeed(
  profile: ScenarioProfile,
  startValue = 104_250,
  historySecs = 15 * 60,
): FeedState {
  const now = Date.now();
  let value = startValue;

  const points: LivelinePoint[] = [];

  for (let i = historySecs; i >= 0; i -= 1) {
    const tick = historySecs - i;
    value = evolveValue(value, tick, profile, startValue);
    points.push({
      time: Math.floor((now - i * 1000) / 1000),
      value,
    });
  }

  return {
    points,
    value,
    tick: historySecs,
    anchor: startValue,
  };
}

function advanceFeed(prev: FeedState, profile: ScenarioProfile): FeedState {
  const nextTick = prev.tick + 1;
  const nextValue = evolveValue(prev.value, nextTick, profile, prev.anchor);
  const nextTime = Math.floor(Date.now() / 1000);
  const nextPoint: LivelinePoint = { time: nextTime, value: nextValue };

  const last = prev.points[prev.points.length - 1];
  const points =
    last && last.time === nextPoint.time
      ? [...prev.points.slice(0, -1), nextPoint]
      : [...prev.points, nextPoint];

  return {
    points: points.slice(-1200),
    value: nextValue,
    tick: nextTick,
    anchor: prev.anchor,
  };
}

function nearestPointIndex(points: LivelinePoint[], timeSec: number): number {
  const n = points.length;
  if (n === 0) return -1;
  let lo = 0;
  let hi = n - 1;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = points[mid]?.time ?? 0;
    if (t === timeSec) return mid;
    if (t < timeSec) lo = mid + 1;
    else hi = mid - 1;
  }

  const leftIdx = Math.max(0, Math.min(n - 1, hi));
  const rightIdx = Math.max(0, Math.min(n - 1, lo));
  const leftDist = Math.abs((points[leftIdx]?.time ?? 0) - timeSec);
  const rightDist = Math.abs((points[rightIdx]?.time ?? 0) - timeSec);
  return rightDist < leftDist ? rightIdx : leftIdx;
}

function formatChartValue(v: number): string {
  if (!Number.isFinite(v)) return "0.00";
  return v.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatChartValueWorklet(v: number): string {
  "worklet";
  if (!Number.isFinite(v)) return "0.00";
  return v.toFixed(2);
}

function deriveCandles(
  points: LivelinePoint[],
  candleWidthSecs: number,
): { candles: CandlePoint[]; liveCandle?: CandlePoint } {
  if (points.length === 0) {
    return { candles: [] };
  }

  const candles: CandlePoint[] = [];
  let current: CandlePoint | undefined;

  for (const point of points) {
    const bucket = Math.floor(point.time / candleWidthSecs) * candleWidthSecs;

    if (!current || current.time !== bucket) {
      if (current) candles.push(current);
      current = {
        time: bucket,
        open: point.value,
        high: point.value,
        low: point.value,
        close: point.value,
      };
      continue;
    }

    current.high = Math.max(current.high, point.value);
    current.low = Math.min(current.low, point.value);
    current.close = point.value;
  }

  return {
    candles: candles.slice(-320),
    liveCandle: current,
  };
}

export default function App() {
  const [cryptoWindowSecs, setCryptoWindowSecs] = useState(
    CRYPTO_WINDOWS[0].secs,
  );
  const [lineMode, setLineMode] = useState(true);
  const scrubStateRef = useRef({
    lastPointIndex: -1,
  });

  const [feed, setFeed] = useState<FeedState>(() =>
    createSeedFeed(CRYPTO_PROFILE),
  );
  const pointsRef = useRef<LivelinePoint[]>(feed.points);

  useEffect(() => {
    const timer = setInterval(() => {
      setFeed((prev) => advanceFeed(prev, CRYPTO_PROFILE));
    }, 1000);

    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    pointsRef.current = feed.points;
  }, [feed.points]);

  const candleData = useMemo(
    () => deriveCandles(feed.points, CANDLE_WIDTH_SECS),
    [feed.points],
  );

  const handleHover = useCallback(
    (point: HoverPoint | null) => {
      if (Platform.OS !== "ios" && Platform.OS !== "android") return;
      const state = scrubStateRef.current;
      if (point == null) {
        state.lastPointIndex = -1;
        return;
      }

      const nextPointIndex = nearestPointIndex(pointsRef.current, point.time);
      if (nextPointIndex !== state.lastPointIndex) {
        state.lastPointIndex = nextPointIndex;
        void Haptics.selectionAsync();
      }
    },
    [],
  );

  const handleHoverWorklet = useCallback((point: HoverPoint | null) => {
    "worklet";
    runOnJS(handleHover)(point);
  }, [handleHover]);

  const handleModeChange = useCallback((nextMode: "line" | "candle") => {
    setLineMode(nextMode === "line");
  }, []);

  return (
    <SafeAreaProvider>
      <GestureHandlerRootView style={styles.flex}>
        <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
          <View style={styles.chartWrap}>
            <Liveline
              data={feed.points}
              value={feed.value}
              mode="candle"
              candles={candleData.candles}
              liveCandle={candleData.liveCandle}
              candleWidth={CANDLE_WIDTH_SECS}
              lineMode={lineMode}
              lineData={feed.points}
              lineValue={feed.value}
              onModeChange={handleModeChange}
              theme="light"
              color="#2563eb"
              momentum
              degen={{ shake: 1, particles: 20 }}
              badge
              pulse
              grid
              fill
              scrub
              exaggerate
              showValue
              showChange
              valueDisplayMode="latest"
              valueMomentumColor
              window={cryptoWindowSecs}
              windows={CRYPTO_WINDOWS}
              onWindowChange={setCryptoWindowSecs}
              windowStyle="rounded"
              timeFormatPreset="auto"
              formatValue={formatChartValue}
              formatValueWorklet={formatChartValueWorklet}
              onHoverWorklet={handleHoverWorklet}
              style={styles.chart}
            />
          </View>
        </SafeAreaView>
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  container: {
    flex: 1,
    backgroundColor: "#f8fafc",
  },
  chartWrap: {
    flex: 1,
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 16,
  },
  chart: {
    flex: 1,
    width: "100%",
  },
});
