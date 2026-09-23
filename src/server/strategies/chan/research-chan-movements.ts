import { structureBarBytes } from "~/lib/research/methods/wyckoff/research-wyckoff";
import type { Bar } from "~/lib/domain";
import type { CzscResult, CzscFamily } from "~/lib/research/methods/chan/czsc";
import type { ChanAnchor } from "~/lib/research/methods/chan/czsc-movements";
import { chanAnchorDateCodes } from "~/lib/research/methods/chan/czsc-movements";
import type { ResearchEvent, ResearchSpec } from "~/lib/research/strategy-research";
import type { ResearchStructureObservation } from "~/lib/research/technical/research-structure-events";
import { chanAnchorVersions } from "~/lib/research/methods/chan/research-chan-recursive";
import { chanNativeCandidates } from "~/lib/research/methods/chan/research-chan-native";
import {
  chanC4Presets,
  chanC4Boundary,
  chanC4Trend,
  chanC4Decomposition,
  chanC4MonthlyBottom,
  chanC4SmallTurn,
  chanC4Observations,
  chanMovementKey,
} from "~/lib/research/methods/chan/research-chan-movements";
import { researchChanMonthlyInput } from "./research-chan-monthly";

type Signal = CzscFamily["signals"][number];
type Verdict = ReturnType<typeof chanC4Trend>;
const missing = (reason: string): Verdict => ({
  status: "missing",
  action: "observe",
  reason,
  evidence: null,
});

/** Resolve only explicit association/member/successor references in this snapshot. */
export function chanC4SmallTurnFromSignal(
  result: CzscResult,
  bars: readonly Bar[],
  config: 0 | 1100,
  signal: Signal,
): Verdict {
  const family = result.families.find((f) => f.config === config),
    table = family?.native?.recursiveMovements;
  if (!table || !family || signal.kind !== 3)
    return missing("小转大缺当前前缀三买必要条件");
  const movement = (s: Signal | undefined) =>
    table.movements.find(
      (m) =>
        m.id ===
        table.associations.find(
          (a) =>
            a.status === "verified" && a.structureId === s?.structure?.trendId,
        )?.movementId,
    );
  const trend = movement(signal),
    meta = signal.structure;
  const point = (id: number | undefined) => family.points[(id ?? 0) - 1];
  const leave = point(meta?.leavePointId),
    retest = point(meta?.retestPointId);
  const last = table.centers.find((c) => c.id === trend?.centerIds.at(-1));
  const association = table.associations.find(
    (a) => a.status === "verified" && a.structureId === meta?.trendId,
  );
  const old = family.native!.trends.find(
    (t) => t.id === association?.structureId,
  );
  const linkedCenter =
    old && association
      ? association.centerIds[old.memberCenterIds.indexOf(signal.centerId!)]
      : undefined;
  const refs = table.movements.filter(
    (m) =>
      m.level === (trend?.level ?? 0) - 1 &&
      m.start === leave?.index &&
      m.end === retest?.index,
  );
  if (
    !trend ||
    !last ||
    last.id !== linkedCenter ||
    refs.length !== 1 ||
    !chanNativeCandidates(
      "chan-third-native",
      result,
      bars,
      config,
    ).signals.includes(signal)
  )
    return missing(
      "缺108最后中枢关联与原三买回试段两端完全一致引用；不以时间包含猜测",
    );
  const reference = refs[0]!;
  let answer: Verdict = missing("缺已关联小级别顶背驰及其显式后继下跌");
  for (const top of family.signals.filter((s) => s.kind === -1)) {
    const small = movement(top);
    if (!small || small.level >= trend.level || small.start < reference.end)
      continue;
    const necessary = chanC4Trend(result, bars, config, top);
    const down = table.movements.find((m) => m.id === small.successorId);
    if (!down) continue;
    answer = chanC4SmallTurn(table, {
      trendId: trend.id,
      referenceId: reference.id,
      downId: down.id,
      thirdBuyMovementId: reference.id,
      smallDivergenceMovementId: small.id,
      ...(down.successorId ? { pullbackId: down.successorId } : {}),
      necessary,
    });
    if (answer.status === "matched" && answer.action === "exit")
      return {
        ...answer,
        evidence: {
          details: answer.evidence,
          referenceIds: [
            trend.id,
            reference.id,
            small.id,
            down.id,
            down.successorId,
          ],
        },
      };
  }
  return answer;
}

/** One prefix observer for all nine presets; the existing portfolio owns fills/T+1. */
export async function researchChanMovements(
  symbol: string,
  daily: readonly Bar[],
  minutes: readonly Bar[] | undefined,
  spec: ResearchSpec,
  czsc: (bars: readonly Bar[], anchor?: ChanAnchor) => Promise<CzscResult>,
  calendar: readonly string[],
  cancelled: () => boolean,
  progress: (date: string) => void,
  record?: (row: ResearchStructureObservation) => void,
) {
  const preset = chanC4Presets.find((p) => p.id === spec.strategy)!;
  const anchor = preset.anchor as ChanAnchor,
    version = chanAnchorVersions[anchor];
  if (anchor === 2 && (spec.start < "2000-01-04" || spec.end > "2022-11-30"))
    throw new Error("五分钟锚窗口须为2000-01-04..2022-11-30");
  if (anchor === 2 && !minutes?.length)
    throw new Error("待数据：缺真实五分钟锚输入");
  const source = (anchor === 2 ? minutes! : daily).filter(
    (b) => b.date.slice(0, 10) <= spec.end,
  );
  if (!source.length) return [];
  if (anchor !== 3)
    chanAnchorDateCodes(
      source.map((b) => b.date),
      anchor,
    );
  if (anchor === 2) {
    for (const b of daily.filter(
      (b) => b.date >= source[0]!.date.slice(0, 10) && b.date <= spec.end,
    )) {
      const rows = source.filter((m) => m.date.slice(0, 10) === b.date);
      if (rows.length !== 48) throw new Error("五分钟缺bar/缺日，不压缩递归");
      const values = {
        open: rows[0]!.open,
        close: rows.at(-1)!.close,
        high: Math.max(...rows.map((r) => r.high)),
        low: Math.min(...rows.map((r) => r.low)),
        volume: rows.reduce((s, r) => s + r.volume, 0),
      };
      if (
        (Object.keys(values) as (keyof typeof values)[]).some(
          (k) =>
            Math.abs(values[k] - b[k]) > 1e-8 * Math.max(1, Math.abs(b[k])),
        )
      )
        throw new Error("五分钟与日线量价口径不一致");
    }
  }
  const events: ResearchEvent[] = [],
    used = new Set<string>();
  let ledger: ReturnType<typeof chanC4Observations> | undefined,
    identity = "",
    lastMonthly = "";
  let monthlyCache: { bytes: string; result: CzscResult } | undefined;
  // This is signal-state, not assumed filled holdings. Execution remains in the shared book.
  let origin: { key: string; divergence: Verdict } | undefined;
  for (let i = 0; i < source.length; i++) {
    if (cancelled()) throw new Error("研究已取消");
    const at = source[i]!.date,
      day = at.slice(0, 10);
    let prefix = source.slice(0, i + 1),
      result: CzscResult | undefined,
      reason: string | null = null;
    if (
      prefix.some(
        (b) =>
          ![b.open, b.high, b.low, b.close, b.volume].every(Number.isFinite) ||
          b.low <= 0 ||
          b.volume < 0 ||
          b.low > Math.min(b.open, b.close) ||
          b.high < Math.max(b.open, b.close),
      )
    )
      reason = "非法OHLC/量，完整前缀不可用";
    if (
      calendar.some(
        (d) =>
          d >= daily[0]!.date && d <= day && !daily.some((b) => b.date === d),
      )
    )
      reason = "缺日，不能压缩后递归";
    if (!reason && anchor === 3) {
      const row = spec.wyckoffStructureInputs?.find(
        (r) => r.symbol === symbol && r.date === day,
      );
      if (
        !row ||
        row.stock.symbol !== symbol ||
        Date.parse(row.availableAt) > Date.parse(`${day}T15:05:00+08:00`) ||
        Date.parse(row.availableAt) < Date.parse(`${day}T15:00:00+08:00`) ||
        structureBarBytes(row.stock.bars.filter((b) => b.date <= day)) !==
          structureBarBytes(prefix)
      )
        reason = "待数据：缺当日可知且与研究日线一致的月线原始证据/日历";
      else {
        const input = await researchChanMonthlyInput(
          row.stock,
          row.calendar,
          day,
          async (monthly, a) => {
            if (monthly.at(-1)?.date === lastMonthly && monthlyCache) {
              if (structureBarBytes(monthly) !== monthlyCache.bytes)
                throw new Error("已观察月线输入修订，不得静默回填");
              return monthlyCache.result;
            }
            return czsc(monthly, a);
          },
        );
        if (input.status === "missing") reason = input.reason;
        else {
          prefix = input.aggregate.bars;
          if (prefix.at(-1)!.date === lastMonthly) continue;
          lastMonthly = prefix.at(-1)!.date;
          result = input.result;
          monthlyCache = { bytes: structureBarBytes(prefix), result };
        }
      }
    } else if (!reason) result = await czsc(prefix, anchor);
    if (reason || !result) {
      record?.({
        symbol,
        date: at,
        warmup: day < spec.start,
        reason: reason ?? "缺原生结果",
        events: [],
        values: {
          anchor: version.name,
          comparisonTable: version.name,
          boundary: chanC4Boundary,
        },
      });
      continue;
    }
    const current = `${result.sourceCommit}/${result.hash}`;
    if (identity && current !== identity)
      throw new Error("回放期间DLL版本变化");
    identity = current;
    ledger ??= chanC4Observations(`${symbol}/${current}/${source[0]!.date}`);
    const family = result.families.find((f) => f.config === spec.czscConfig),
      table = family?.native?.recursiveMovements;
    if (!table || table.anchor !== anchor || table.config !== spec.czscConfig)
      throw new Error("结构缺口：缺100–108显式锚表");
    const observations = ledger(prefix, table, at);
    const valid = (id: number) =>
      observations.find(
        (o) => o.evidence?.id === id && o.state === "confirmed",
      );
    const key = (id: number) => {
      const m = table.movements.find((m) => m.id === id);
      return m ? chanMovementKey(table, m, prefix) : null;
    };
    const decisions: {
      verdict: Verdict;
      key: string;
      endpoint: string;
      origin?: { key: string; divergence: Verdict };
    }[] = [];
    const mapped = (s: Signal) =>
      table.associations.find(
        (a) =>
          a.structureId === s.structure?.trendId && a.status === "verified",
      );
    const held = origin
      ? table.movements.find((m) => key(m.id) === origin!.key)
      : undefined;
    if (origin && (!held || !valid(held.id)))
      reason = "来源走势已修订/消失，冻结原确认，不猜旧ID或撤销已有退出";
    if (
      held &&
      valid(held.id) &&
      (preset.method === "CH08" || preset.method === "CH09")
    ) {
      const v = chanC4Decomposition(
        preset.method,
        table,
        preset.level,
        origin!.divergence,
        held.id,
        held.id,
      );
      // Revised successors cannot confirm a new exit.
      const exit =
        v.action === "exit"
          ? (v.evidence as { id: number; end: number })
          : null;
      if (!exit || valid(exit.id))
        decisions.push({
          verdict: v,
          key: `${origin!.key}:exit`,
          endpoint: exit ? prefix[exit.end]!.date : at,
        });
    }
    if (held && valid(held.id) && preset.method === "CH13") {
      const third = chanNativeCandidates(
        "chan-hold-cash-native",
        result,
        prefix,
        spec.czscConfig,
      )
        .signals.filter((s) => Math.abs(s.kind) === 3)
        .find((s) => mapped(s)?.movementId === held.successorId);
      if (third) {
        const a = mapped(third)!,
          old = family!.native!.trends.find((t) => t.id === a.structureId);
        const centerId = old
          ? a.centerIds[old.memberCenterIds.indexOf(third.centerId!)]
          : undefined;
        if (centerId)
          decisions.push({
            verdict: chanC4MonthlyBottom(
              table,
              held.id,
              {
                ...origin!.divergence,
                proof: { anchor, config: table.config, movementId: held.id },
              },
              {
                movementId: a.movementId,
                centerId,
                kind: third.kind as 3 | -3,
              },
            ),
            key: `${origin!.key}:third`,
            endpoint: third.date,
          });
      }
    }
    for (const signal of family!.signals) {
      const association = mapped(signal),
        m = table.movements.find((m) => m.id === association?.movementId);
      if (preset.method === "CH18-small-to-large") {
        if (signal.kind !== 3) continue;
        if (m && m.level !== preset.level) continue;
        const v = chanC4SmallTurnFromSignal(
          result,
          prefix,
          spec.czscConfig,
          signal,
        );
        const refs =
          (v.evidence as { referenceIds?: number[] } | null)?.referenceIds ??
          [];
        if (
          !refs.some((id) =>
            observations.some(
              (o) => o.evidence?.id === id && o.state === "revised",
            ),
          )
        )
          decisions.push({
            verdict: v,
            key: `small:${signal.date}`,
            endpoint: signal.date,
          });
        if (
          m &&
          valid(m.id) &&
          chanNativeCandidates(
            "chan-third-native",
            result,
            prefix,
            spec.czscConfig,
          ).signals.includes(signal)
        )
          decisions.push({
            verdict: {
              status: "matched",
              action: "enter",
              reason: "已关联三买入场基线，小转大只控制退出",
              evidence: signal,
            },
            key: `third:${signal.date}`,
            endpoint: signal.date,
          });
        continue;
      }
      if (Math.abs(signal.kind) !== 1) continue;
      let v = chanC4Trend(result, prefix, spec.czscConfig, signal);
      if (!m || m.level !== preset.level || !valid(m.id)) {
        if (v.status === "missing") reason = v.reason;
        continue;
      }
      if (preset.method === "CH08" || preset.method === "CH09")
        v = chanC4Decomposition(preset.method, table, preset.level, v, m.id);
      if (preset.method === "CH13") v = chanC4MonthlyBottom(table, m.id, v);
      decisions.push({
        verdict: v,
        key: `${key(m.id)}:${v.action}`,
        endpoint: signal.date,
        ...(v.action === "enter"
          ? {
              origin: {
                key: key(m.id)!,
                divergence: chanC4Trend(
                  result,
                  prefix,
                  spec.czscConfig,
                  signal,
                ),
              },
            }
          : {}),
      });
    }
    record?.({
      symbol,
      date: at,
      warmup: day < spec.start,
      reason,
      events: observations.map((o) => ({
        key: o.key,
        kind: o.state === "revised" ? "revision" : "movement",
        candidateAt: o.candidateAt,
        confirmedAt: o.confirmedAt,
        observedAt: o.observedAt,
        state: o.state === "revised" ? "cancelled" : o.state,
        reason:
          o.state === "revised"
            ? "当前证据修订；原confirmedAt保留"
            : "当前前缀首见",
        facts: o,
      })),
      values: {
        anchor: version.name,
        comparisonTable: version.name,
        decisions,
        associations: table.associations,
        boundary: chanC4Boundary,
      },
    });
    for (const d of decisions) {
      if (
        d.verdict.status !== "matched" ||
        !["enter", "exit"].includes(d.verdict.action)
      )
        continue;
      const eventKey = `${version.name}:${preset.rule}:${d.key}`;
      if (used.has(eventKey)) continue;
      used.add(eventKey); // Warmup signals are consumed, never backfilled.
      if (d.verdict.action === "exit") origin = undefined;
      else if (d.origin && !origin) origin = d.origin;
      if (
        day < spec.start ||
        !daily.some((b) => b.date === day) ||
        source[i]!.volume <= 0
      )
        continue;
      events.push({
        symbol,
        key: eventKey,
        observedDate: day,
        endpointDate: d.endpoint.slice(0, 10),
        historyStart: daily[0]!.date,
        strategyVersion: `${spec.strategy}-engineering-1/${current}`,
        partition: day >= spec.validationStart ? "validation" : "development",
        ...(d.verdict.action === "exit" ? { side: "exit" as const } : {}),
        evidence: JSON.stringify({
          confirmedAt: at,
          anchor: version,
          comparisonTable: version.name,
          decision: d.verdict,
          observations,
          boundary: chanC4Boundary,
        }),
      });
    }
    progress(day);
  }
  return events;
}
