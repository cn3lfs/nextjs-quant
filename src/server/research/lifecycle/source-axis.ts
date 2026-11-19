import { type StrategyObjectInput } from "trading-strategies";

import {
  type LifecycleSourceKey,
  type LifecycleFamilyAxis,
} from "./source-types";
import { contentHash } from "./source-artifacts";

export const dayMs = 86400000;
export const dayAfter = (date: string, count = 1) =>
  new Date(Date.parse(date) + count * dayMs).toISOString().slice(0, 10);
export const naturalDays = (start: string, end: string) =>
  Array.from(
    {
      length: Math.max(
        0,
        Math.round((Date.parse(end) - Date.parse(start)) / dayMs) + 1,
      ),
    },
    (_, i) => dayAfter(start, i),
  );
type RegistrationMain = {
  id: string;
  family: string;
  strategy: StrategyObjectInput;
  detector?: { years: number; minimumBars: number };
};
export type Registration = {
  main: RegistrationMain[];
  neighbors: {
    parent: string;
    family: string;
    patch: Record<string, number | number[]>;
  }[];
  families: { family: string }[];
  rankSource: { periods: number[] };
  axes: { cnSwing: { start: string; end: string }; crypto: { end: string } };
  resources: { mutableOutputRoot: string };
};
export function familyWarmup(config: Registration, family: string) {
  const rows = config.main.filter((m) => m.family === family);
  let days = 61;
  for (const row of rows) {
    const values: number[] = [61];
    const scan = (value: unknown, key = "") => {
      if (Array.isArray(value)) {
        if (key === "periods")
          values.push(
            ...value
              .filter((n): n is number => typeof n === "number")
              .map((n) => n + 1),
          );
        else value.forEach((v) => scan(v, key));
      } else if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) scan(v, k);
      } else if (
        typeof value === "number" &&
        [
          "slow",
          "fast",
          "lookback",
          "atrPeriod",
          "period",
          "N1",
          "minimumBars",
        ].includes(key)
      )
        values.push(key === "minimumBars" ? value : value + 1);
    };
    scan(row.strategy);
    scan(row.detector);
    for (const neighbor of config.neighbors.filter((n) => n.parent === row.id))
      for (const [key, value] of Object.entries(neighbor.patch))
        scan(value, key.split(".").at(-1));
    const bars = Math.max(...values),
      technicalDays = row.strategy.period === "4h" ? Math.ceil(bars / 6) : bars;
    days = Math.max(days, technicalDays);
  }
  return days;
}

export function axis(
  dailyAxis: string[],
  sourceKeys: LifecycleSourceKey[],
  warmupBars: number,
  warmupStart: string | null,
  missing: string[],
  firstSignal?: string,
  targetThrough = dailyAxis.at(-1) ?? null,
): LifecycleFamilyAxis {
  const evidence = {
    dailyAxis,
    sourceKeys,
    warmupBars,
    warmupStart,
    missing,
    firstSignal,
    targetThrough,
    valuationThrough: dailyAxis.at(-1) ?? null,
  };
  return { ...evidence, axisHash: contentHash(evidence) };
}
