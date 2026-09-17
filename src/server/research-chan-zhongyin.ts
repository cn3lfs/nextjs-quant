import type { Bar } from "~/lib/domain";
import type { CzscResult } from "~/lib/czsc";
import type { ResearchEvent, ResearchSpec } from "~/lib/strategy-research";
import type { ResearchStructureObservation } from "~/lib/research-structure-events";
import {
  chanRecursiveObservations,
  chanAnchorVersions,
} from "~/lib/research-chan-recursive";
import {
  chanNativeCandidates,
  isChanFiveMinute,
  chanZhongyinBoundary,
} from "~/lib/research-chan-native";

export async function researchChanZhongyin(
  symbol: string,
  daily: readonly Bar[],
  minutes: readonly Bar[] | undefined,
  spec: ResearchSpec,
  czsc: (bars: readonly Bar[], anchor?: 1 | 2) => Promise<CzscResult>,
  cancelled: () => boolean,
  progress: (date: string) => void,
  record?: (row: ResearchStructureObservation) => void,
) {
  const five = isChanFiveMinute(spec.strategy),
    anchor = five ? 2 : 1,
    version = chanAnchorVersions[anchor],
    variant = spec.strategy.includes("-boll-") ? 2 : 1;
  if (five && (spec.start < version.start! || spec.end > version.end!))
    throw new Error("五分钟锚窗口须为2000-01-04..2022-11-30，禁止混用日线区间");
  if (five && !minutes?.length)
    throw new Error("待数据：缺少真实五分钟锚输入，不能用日线代替");
  const bars = (five ? minutes! : daily).filter(
    (b) => b.date.slice(0, 10) <= spec.end,
  );
  if (
    bars.some(
      (b, i) =>
        !Number.isFinite(Date.parse(b.date)) ||
        (i > 0 && b.date <= bars[i - 1]!.date) ||
        (five
          ? !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+08:00$/.test(b.date) ||
            b.date.slice(0, 10) < version.start! ||
            b.date.slice(0, 10) > version.end!
          : b.date.length !== 10),
    )
  )
    throw new Error("显式锚输入周期或顺序错误");
  if (five && bars.length) {
    const firstDay = bars[0]!.date.slice(0, 10);
    for (const dayBar of daily.filter(
      (b) => b.date >= firstDay && b.date <= spec.end,
    )) {
      const dayBars = bars.filter((b) => b.date.slice(0, 10) === dayBar.date);
      const expected = Array.from({ length: 48 }, (_, i) => {
        const m = i < 24 ? 575 + i * 5 : 785 + (i - 24) * 5;
        return `${dayBar.date}T${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}:00+08:00`;
      });
      if (
        dayBars.length !== 48 ||
        dayBars.some((b, i) => b.date !== expected[i])
      )
        throw new Error("待数据：五分钟缺bar/缺日，不能压缩后递归");
      const aggregate = {
        open: dayBars[0]!.open,
        close: dayBars.at(-1)!.close,
        high: Math.max(...dayBars.map((b) => b.high)),
        low: Math.min(...dayBars.map((b) => b.low)),
        volume: dayBars.reduce((a, b) => a + b.volume, 0),
      };
      if (
        (Object.keys(aggregate) as (keyof typeof aggregate)[]).some(
          (k) =>
            Math.abs(aggregate[k] - dayBar[k]) >
            1e-8 * Math.max(1, Math.abs(dayBar[k])),
        )
      )
        throw new Error("待数据：五分钟与日线量价口径不一致");
    }
  }
  const events: ResearchEvent[] = [],
    seen = new Set<string>();
  let identity = "",
    ledger: ReturnType<typeof chanRecursiveObservations> | undefined;
  // Retain all source history. Never substitute a sliding window or final structures.
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]!,
      day = bar.date.slice(0, 10);
    if (day > spec.end) break;
    if (cancelled()) throw new Error("研究已取消");
    const prefix = bars.slice(0, i + 1),
      result = await czsc(prefix, anchor);
    const current = `${result.sourceCommit}/${result.hash}`;
    if (identity && identity !== current)
      throw new Error("回放期间DLL版本变化");
    identity = current;
    ledger ??= chanRecursiveObservations(
      `${symbol}/${current}/${bars[0]!.date}`,
    );
    const table = result.families.find((f) => f.config === spec.czscConfig)
      ?.native?.recursive;
    if (!table || table.anchor !== anchor || table.config !== spec.czscConfig)
      throw new Error("结构缺口：显式锚93–99递归表缺失");
    const observations = ledger.observe(prefix, table);
    const ended = observations.some(
      (e) =>
        e.facts.level === 0 &&
        e.kind ===
          (variant === 1 ? "zhongyin-structural-end" : "zhongyin-boll20-end"),
    );
    const found = chanNativeCandidates(
      "chan-hold-cash-native",
      result,
      prefix,
      spec.czscConfig,
    );
    const fresh = found.signals
      .filter((p) => Math.abs(p.kind) === 3)
      .filter((p) => {
        const key = `${p.date}:${p.kind}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    record?.({
      symbol,
      date: bar.date,
      warmup: day < spec.start,
      reason: found.gaps.length ? found.gaps.join("；") : null,
      events: observations,
      values: {
        anchor: version.name,
        variant,
        comparisonTable: `${version.name}/zhongyin-${variant}`,
        unavailableTransitions: table.transitions.filter(
          (t) => t.variant === variant && !t.available,
        ),
        boundary: chanZhongyinBoundary,
      },
    });
    if (
      day < spec.start ||
      found.gaps.length ||
      !daily.some((b) => b.date === day)
    )
      continue;
    if (
      ![bar.open, bar.high, bar.low, bar.close, bar.volume].every(
        (v) => Number.isFinite(v) && v > 0,
      ) ||
      bar.low > Math.min(bar.open, bar.close) ||
      bar.high < Math.max(bar.open, bar.close)
    )
      continue;
    for (const point of fresh) {
      if (point.kind > 0 && !ended) continue;
      events.push({
        symbol,
        key: `${version.name}:${variant}:${point.date}:${point.kind}`,
        observedDate: day,
        endpointDate: point.date.slice(0, 10),
        strategyVersion: `${spec.strategy}-engineering-1/${current}`,
        partition: day >= spec.validationStart ? "validation" : "development",
        ...(point.kind < 0 ? { side: "exit" as const } : {}),
        evidence: JSON.stringify({
          point,
          confirmedAt: bar.date,
          observations,
          anchor: version,
          variant,
          boundary: chanZhongyinBoundary,
        }),
      });
    }
    progress(day);
  }
  return events;
}
