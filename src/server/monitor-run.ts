import type { Monitor } from "~/lib/domain";

/** Configuration identity is separate from the mutable per-symbol baseline. */
export function sameMonitorRun(
  expected: Monitor,
  current: Monitor | undefined,
): current is Monitor {
  return Boolean(
    current &&
    current.enabled &&
    expected.enabled &&
    current.id === expected.id &&
    current.createdAt === expected.createdAt &&
    current.revision === expected.revision &&
    current.period === expected.period &&
    current.source === expected.source &&
    JSON.stringify(current.symbols) === JSON.stringify(expected.symbols) &&
    JSON.stringify(current.strategy) === JSON.stringify(expected.strategy),
  );
}
export function sameMonitorBaseline(expected: Monitor, current: Monitor) {
  return JSON.stringify(current.states) === JSON.stringify(expected.states);
}
