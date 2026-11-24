"use client";

import { useEffect, useRef } from "react";
import { cnChartPeriodSchema, type ChartPeriod } from "~/lib/chart/chart-view";

/** Whether a key event belongs to a text field or an open popup, where
 * page-level terminal keys must not fire. */
export function isTypingTarget(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  return !!element?.closest?.(
    "input, textarea, select, [contenteditable=true], [role=dialog], [role=listbox], [role=combobox], [role=menu]",
  );
}

/** TDX keyboard-sprite period codes (日 D, 周 W, 月 MO, M5/M15/M3/M6 for
 * 5/15/30/60 minutes), matched case-insensitively and exactly. */
export const periodCodes: Record<string, ChartPeriod> = {
  D: "day",
  W: "week",
  MO: "month",
  M5: "5m",
  M15: "15m",
  M3: "30m",
  M6: "60m",
};
export function periodFromCode(query: string) {
  return periodCodes[query.trim().toUpperCase()] ?? null;
}

/** F8 cycles the chart period, as in TDX. */
export function nextPeriod(
  period: ChartPeriod,
  all: readonly ChartPeriod[] = cnChartPeriodSchema.options,
) {
  if (!all.length) return period;
  return all[(all.indexOf(period) + 1) % all.length]!;
}

export function usePeriodHotkey(
  period: ChartPeriod,
  setPeriod: (period: ChartPeriod) => void,
  disabled = false,
  allowed: readonly ChartPeriod[] = cnChartPeriodSchema.options,
) {
  const latest = useRef({ period, setPeriod, disabled, allowed });
  latest.current = { period, setPeriod, disabled, allowed };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const { period, setPeriod, disabled, allowed } = latest.current;
      if (
        event.key !== "F8" ||
        disabled ||
        event.defaultPrevented ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        isTypingTarget(event.target)
      )
        return;
      event.preventDefault();
      setPeriod(nextPeriod(period, allowed));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export function useTradeReviewHotkeys(
  step: (direction: -1 | 1) => void,
  enabled: boolean,
) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (
        (event.key !== "[" && event.key !== "]") ||
        event.defaultPrevented ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        isTypingTarget(event.target)
      )
        return;
      event.preventDefault();
      step(event.key === "[" ? -1 : 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, step]);
}
