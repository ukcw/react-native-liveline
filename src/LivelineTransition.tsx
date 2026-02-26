import { useState, useEffect, useRef, type ReactElement } from "react";
import { View, type ViewStyle } from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  Easing,
} from "react-native-reanimated";

export interface LivelineTransitionProps {
  /** Key of the active child to display. Must match a child's `key` prop. */
  active: string;
  /** Chart elements with unique `key` props */
  children: ReactElement | ReactElement[];
  /** Cross-fade duration in ms (default 300) */
  duration?: number;
  style?: ViewStyle;
}

/**
 * Cross-fade between chart components (e.g. line ↔ candlestick).
 * Children must have unique `key` props matching possible `active` values.
 *
 * @example
 * ```tsx
 * <LivelineTransition active={chartType}>
 *   <Liveline key="line" data={data} value={value} />
 *   <Liveline key="candle" mode="candle" candles={candles} candleWidth={5} data={data} value={value} />
 * </LivelineTransition>
 * ```
 */
export function LivelineTransition({
  active,
  children,
  duration = 300,
  style,
}: LivelineTransitionProps) {
  const childArray = Array.isArray(children) ? children : [children];

  const [mounted, setMounted] = useState<Set<string>>(() => new Set([active]));
  const prevRef = useRef(active);

  useEffect(() => {
    if (active === prevRef.current) return;
    prevRef.current = active;
    setMounted((prev) => new Set([...prev, active]));

    const timer = setTimeout(() => {
      setMounted((prev) => {
        const next = new Set(prev);
        for (const k of next) {
          if (k !== active) next.delete(k);
        }
        return next;
      });
    }, duration + 50);

    return () => clearTimeout(timer);
  }, [active, duration]);

  return (
    <View
      style={[{ position: "relative", width: "100%", height: "100%" }, style]}
    >
      {childArray.map((child) => {
        const key = String(child.key ?? "");
        if (!mounted.has(key)) return null;
        return (
          <TransitionSlot
            key={key}
            isActive={key === active}
            duration={duration}
          >
            {child}
          </TransitionSlot>
        );
      })}
    </View>
  );
}

function TransitionSlot({
  isActive,
  duration,
  children,
}: {
  isActive: boolean;
  duration: number;
  children: ReactElement;
}) {
  const opacity = useSharedValue(isActive ? 1 : 0);

  useEffect(() => {
    opacity.value = withTiming(isActive ? 1 : 0, {
      duration,
      easing: Easing.ease,
    });
  }, [isActive, duration]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  return (
    <Animated.View
      style={[
        {
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
        },
        animatedStyle,
      ]}
      pointerEvents={isActive ? "auto" : "none"}
    >
      {children}
    </Animated.View>
  );
}
