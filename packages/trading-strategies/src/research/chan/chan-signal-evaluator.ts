import type { Bar } from "trading-strategy-core/bars";
import {
  CZSC_CTX,
  type CzscCenter,
  type CzscFamily,
  type CzscResult,
} from "./czsc.js";

export const chanSignalCodes = [
  "1B",
  "1S",
  "P1B",
  "P1S",
  "2B",
  "2S",
  "L2B",
  "L2S",
  "3B",
  "3S",
  "STB",
  "STS",
  "NB",
  "NS",
  "ZYB",
  "ZYS",
  "KB",
  "KS",
] as const;
export type ChanSignalCode = (typeof chanSignalCodes)[number];
type Direction = "long" | "short";

const kinds = {
  "1": ["趋势背驰一", "1"],
  P1: ["盘整背驰类一", "盘背1"],
  "2": ["二", "2"],
  L2: ["二三重合", "2+3"],
  "3": ["三", "3"],
  ST: ["小转大", "小转大"],
  N: ["区间套", "区间套"],
  ZY: ["中阴转折", "中阴"],
  K: ["均线吻", "均线吻"],
} as const;
type Kind = keyof typeof kinds;
function metadata(code: ChanSignalCode) {
  const kind = code.slice(0, -1) as Kind;
  const direction: Direction = code.endsWith("B") ? "long" : "short";
  const suffix = direction === "long" ? "买" : "卖";
  return {
    direction,
    label: kinds[kind][0] + suffix,
    shortLabel: kinds[kind][1] + suffix,
  };
}
export const chanSignalMetadata = Object.fromEntries(
  chanSignalCodes.map((code) => [code, metadata(code)]),
) as Record<ChanSignalCode, ReturnType<typeof metadata>>;

export interface ChanClassifiedSignal {
  key: string;
  code: ChanSignalCode;
  label: string;
  shortLabel: string;
  direction: Direction;
  config: 0 | 1100;
  index: number;
  date: string;
  confirmedAt: number;
  price: number;
  stopPrice: number | null;
  targetPrice: number | null;
  quality: 1 | 2;
  center: CzscCenter | null;
  summary: string;
}

function nativeKind(s: CzscFamily["signals"][number]): Kind | undefined {
  const flags = s.structure?.contextFlags ?? 0;
  switch (Math.abs(s.kind)) {
    case 1:
      return s.divergence?.semantic === 2 ? "P1" : "1";
    case 2:
      return flags & CZSC_CTX.overlap ? "L2" : "2";
    case 3:
      if (flags & CZSC_CTX.overlap) return "L2";
      return flags & CZSC_CTX.smallTurn || s.divergence?.semantic === 3
        ? "ST"
        : "3";
  }
}
const revoked = (s: CzscFamily["signals"][number]) => (s.revokedAt ?? -1) >= 0;
function knownPoint(p: CzscFamily["points"][number], at: number) {
  const confirmed = p.confirmedAt ?? p.index;
  return confirmed >= p.index && confirmed <= at;
}

type Evidence = {
  kind: Kind;
  sign: number;
  index: number;
  confirmedAt: number;
  price?: number;
  stop?: number;
  centerId?: number;
  quality?: number;
  reason: string;
};
type Confirmation = {
  source: "third" | "breakout";
  index: number;
  sign: number;
  at: number;
  stop?: number;
  centerId?: number;
};

function maEvidence(
  family: CzscFamily,
  bars: readonly Bar[],
  through: number,
  emit: (e: Evidence) => void,
) {
  const rows = family.diagnostics?.ma ?? [];
  let trend = 0,
    kissCount = 0,
    fired = false;
  type Area = { sign: number; sum: number; extreme: number };
  let area: Area | null = null;
  const completed = new Map<number, Area>();
  for (const [offset, row] of rows.entries()) {
    if (row.index > through) break;
    const bar = bars[row.index],
      prev = rows[offset - 1];
    if (!bar || !Number.isFinite(row.difference)) continue;
    const contiguous = prev?.index === row.index - 1;
    if (!contiguous) {
      trend = 0;
      area = null;
      completed.clear();
    }
    const sign = Math.sign(row.difference);
    const eligibleKiss = (kiss: number) => kiss === 2 || kiss === 3;
    if (trend !== sign || !contiguous) {
      trend = sign;
      kissCount = 0;
      fired = false;
    }
    if (
      eligibleKiss(row.kiss) &&
      (!contiguous ||
        !prev ||
        !eligibleKiss(prev.kiss) ||
        Math.sign(prev.difference) !== sign)
    )
      kissCount++;
    const effective =
      contiguous && prev && prev.volumeKiss !== 4 && row.volumeKiss !== 4;
    const event = (direction: number, reason: string) =>
      emit({
        kind: "K",
        sign: direction,
        index: row.index,
        confirmedAt: row.index,
        price: bar.close,
        stop: direction > 0 ? bar.low : bar.high,
        reason,
      });
    if (
      effective &&
      !fired &&
      sign &&
      Math.sign(prev.difference) === sign &&
      kissCount === 1 &&
      eligibleKiss(prev.kiss) &&
      (row.kiss === 0 || sign * (row.difference - prev.difference) > 0)
    ) {
      event(sign, "首次唇吻或湿吻后均线重新张口");
      fired = true;
    }
    if (area && (row.kiss !== 0 || sign !== area.sign)) {
      const earlier = completed.get(area.sign);
      if (
        effective &&
        earlier &&
        area.sum < earlier.sum &&
        (area.extreme - earlier.extreme) * area.sign > 0
      )
        event(-area.sign, "同向两段均线差面积缩小且价格创新极值后转折");
      completed.set(area.sign, area);
      area = null;
    }
    if (row.kiss === 0 && sign) {
      const extreme: number = sign > 0 ? bar.high : bar.low;
      if (!area) area = { sign, sum: 0, extreme };
      area.sum += Math.abs(row.difference);
      area.extreme =
        sign > 0
          ? Math.max(extreme, area.extreme)
          : Math.min(extreme, area.extreme);
    }
  }
}

export function classifyCzscSignals(
  result: CzscResult,
  bars: readonly Bar[],
  options: { asOfIndex?: number; includeMaKiss?: boolean } = {},
): ChanClassifiedSignal[] {
  const through = Math.min(
    options.asOfIndex ?? bars.length - 1,
    bars.length - 1,
  );
  const signals = new Map<string, ChanClassifiedSignal>();
  for (const family of result.families) {
    const points = new Map(family.points.map((p) => [p.index, p]));
    const confirmations: Confirmation[] = [];
    const codeOf = (kind: Kind, sign: number): ChanSignalCode =>
      `${kind}${sign > 0 ? "B" : "S"}`;
    const keyOf = (code: ChanSignalCode, index: number) =>
      `${family.config}:${code}:${bars[index]?.date}`;
    const revokedIndices = new Set(
      family.signals.filter(revoked).map((s) => s.index),
    );
    const blocked = new Set(
      family.signals.filter(revoked).flatMap((s) => {
        const kind = nativeKind(s);
        return kind ? [keyOf(codeOf(kind, s.kind), s.index)] : [];
      }),
    );
    const emit = (e: Evidence) => {
      const bar = bars[e.index];
      if (
        !bar ||
        !e.sign ||
        e.index > through ||
        e.confirmedAt > through ||
        e.confirmedAt < e.index
      )
        return;
      const code = codeOf(e.kind, e.sign),
        key = keyOf(code, e.index);
      if (blocked.has(key)) return;
      const old = signals.get(key);
      if (
        old &&
        old.confirmedAt >= 0 &&
        (e.confirmedAt < 0 || old.confirmedAt <= e.confirmedAt)
      )
        return;
      const info = chanSignalMetadata[code];
      const prefix = ["N", "ZY", "K"].includes(e.kind)
        ? ""
        : family.config === 0
          ? "笔"
          : "段";
      const price = e.price ?? (e.sign > 0 ? bar.low : bar.high);
      const candidate = family.centers[(e.centerId ?? 0) - 1];
      // A later extension can change the center's extremes and end date.
      const center =
        candidate &&
        candidate.end <= e.confirmedAt &&
        (candidate.confirmedAt ?? candidate.end) >= 0 &&
        (candidate.confirmedAt ?? candidate.end) <= e.confirmedAt
          ? candidate
          : null;
      const targets = center
        ? [center.ZD, center.ZG, center.DD, center.GG]
            .filter(
              (v) => v > 0 && Number.isFinite(v) && (v - price) * e.sign > 0,
            )
            .sort((a, b) => Math.abs(a - price) - Math.abs(b - price))
        : [];
      const stop = e.stop ?? price;
      const shortLabel = prefix + info.shortLabel;
      signals.set(key, {
        key,
        code,
        ...info,
        shortLabel,
        config: family.config,
        index: e.index,
        date: bar.date,
        confirmedAt: e.confirmedAt,
        price,
        stopPrice: Number.isFinite(stop) && stop > 0 ? stop : null,
        targetPrice: targets[0] ?? null,
        quality: e.quality === 2 ? 2 : 1,
        center,
        summary: `${shortLabel}，${e.reason}`,
      });
    };

    for (const s of family.signals) {
      const kind = nativeKind(s),
        at = s.confirmedAt ?? s.index;
      const point = points.get(s.index);
      if (!kind || revoked(s) || (point && !knownPoint(point, at))) continue;
      const sign = Math.sign(s.kind);
      emit({
        kind,
        sign,
        index: s.index,
        confirmedAt: at,
        price: point?.price,
        stop: s.stop,
        centerId: s.centerId,
        quality: s.quality,
        reason: "原生买卖点",
      });
      if (Math.abs(s.kind) === 3 && at >= s.index && at <= through)
        confirmations.push({
          source: "third",
          sign,
          index: s.index,
          at,
          stop: s.stop,
          centerId: s.centerId,
        });
    }
    for (const b of family.breakouts ?? []) {
      const ordinal = b.leavePointId;
      const leave = family.points[ordinal - 1],
        turn = family.points[ordinal];
      if (ordinal < 1 || !leave) continue;
      if (
        b.confirmedAt !== undefined &&
        b.confirmedAt >= leave.index &&
        b.confirmedAt <= through
      )
        confirmations.push({
          source: "breakout",
          sign: b.direction,
          index: b.confirmedAt,
          at: b.confirmedAt,
          centerId: b.centerId,
        });
      if (!turn || b.divergence?.semantic !== 2 || !(b.divergence.flags & 16))
        continue;
      const sign = -b.direction,
        turnAt = turn.confirmedAt ?? turn.index;
      if (turnAt < turn.index || turnAt > through) continue;
      const second = family.points[ordinal + 1];
      if (
        revokedIndices.has(leave.index) ||
        (second && revokedIndices.has(second.index))
      )
        continue;
      // An explicitly revoked first-class observation must not reappear under a derived label.
      const nativeFirst = family.signals.some(
        (s) =>
          s.index === leave.index &&
          Math.abs(s.kind) === 1 &&
          (revoked(s) ||
            ((s.confirmedAt ?? s.index) >= s.index &&
              (s.confirmedAt ?? s.index) <= turnAt)),
      );
      if (!nativeFirst && knownPoint(leave, turnAt))
        emit({
          kind: "P1",
          sign,
          index: leave.index,
          confirmedAt: turnAt,
          price: leave.price,
          stop: leave.price,
          centerId: b.centerId,
          reason: "单中枢离开段盘整背驰，下一端点已确认",
        });
      const after = family.points[ordinal + 2];
      if (!second || !after || second.direction !== b.direction) continue;
      const at = after.confirmedAt ?? after.index;
      if (at < after.index || at < turnAt) continue;
      const overlap =
        b.third &&
        b.retestPointId === ordinal + 2 &&
        (b.confirmedAt ?? at) >= second.index;
      const confirmedAt = overlap ? Math.max(at, b.confirmedAt ?? at) : at;
      if (
        !knownPoint(leave, confirmedAt) ||
        !knownPoint(second, confirmedAt) ||
        (second.price - leave.price) * sign < 0
      )
        continue;
      emit({
        kind: overlap ? "L2" : "2",
        sign,
        index: second.index,
        confirmedAt,
        price: second.price,
        stop: leave.price,
        centerId: b.centerId,
        reason: "盘背后的次级别回抽守住离开端点",
      });
    }

    for (const n of family.diagnostics?.nested ?? []) {
      const sign = Math.sign(n.direction);
      const linked = family.signals.filter(
        (s) => s.index === n.index && Math.sign(s.kind) === sign,
      );
      const active = linked.filter(
        (s) => !revoked(s) && (s.confirmedAt ?? s.index) >= s.index,
      );
      if (linked.length && !active.length) continue;
      const lowAt = active.length
        ? Math.min(...active.map((s) => s.confirmedAt ?? s.index))
        : n.index;
      const source = family.native?.highCandidates.find(
        (c) => c.id === n.sourceCandidateId,
      );
      const highFamily = result.families.find(
        (f) => f.config === n.sourceConfig,
      );
      const highPoint = source && highFamily?.points[source.pointId - 1];
      const highAt =
        highPoint?.confirmedAt ??
        source?.pointConfirmedAt ??
        highPoint?.index ??
        source?.index ??
        n.index;
      if (highAt < (highPoint?.index ?? source?.index ?? 0)) continue;
      const at = Math.max(lowAt, highAt);
      const point = points.get(n.index);
      const base = {
        sign,
        index: n.index,
        price: point?.price,
        quality: 2,
      };
      if ((n.confirmFlags & 3) === 3 && (!point || knownPoint(point, at)))
        emit({
          ...base,
          kind: "N",
          confirmedAt: at,
          reason: "上下级别区间套确认",
        });
      if (!(n.confirmFlags & 8)) continue;
      const confirmationsAfter = confirmations
        .filter(
          (c) => c.source === "third" && c.index > n.index && c.sign === sign,
        )
        .map((c) => c.at);
      for (const p of family.points)
        if (
          p.index > n.index &&
          p.direction === sign &&
          (p.confirmedAt ?? p.index) >= p.index
        )
          confirmationsAfter.push(p.confirmedAt ?? p.index);
      const followAt = Math.max(at, Math.min(...confirmationsAfter));
      if (confirmationsAfter.length && (!point || knownPoint(point, followAt)))
        emit({
          ...base,
          kind: "ST",
          confirmedAt: followAt,
          reason: "跨级别小转大候选获后续同向结构确认",
        });
    }

    const completions: { at: number; sign: number }[] = [];
    for (const t of family.native?.trends ?? [])
      if (t.completedAt !== null)
        completions.push({ at: t.completedAt, sign: -Math.sign(t.type) });
    for (const m of family.native?.recursiveMovements?.movements ?? [])
      if (m.completed !== null)
        completions.push({ at: m.completed, sign: -Math.sign(m.type) });
    for (const node of family.native?.recursive?.nodes ?? []) {
      if (node.completed === null) continue;
      const successor = family.native?.recursive?.nodes.find(
        (next) => next.id === node.successorId,
      );
      const sign =
        successor && successor.established <= node.completed
          ? Math.sign(successor.ZD - node.ZD)
          : 0;
      completions.push({ at: node.completed, sign });
    }
    for (const c of completions) {
      if (c.at < 0 || c.at > through) continue;
      for (const evidence of confirmations) {
        if (
          (c.sign && c.sign !== evidence.sign) ||
          Math.abs(evidence.at - c.at) > 3
        )
          continue;
        emit({
          kind: "ZY",
          sign: evidence.sign,
          index: evidence.index,
          confirmedAt: Math.max(c.at, evidence.at),
          stop: evidence.stop,
          centerId: evidence.centerId,
          reason: "走势完成附近出现同向三类点或离开突破确认",
        });
      }
    }
    if (options.includeMaKiss !== false)
      maEvidence(family, bars, through, emit);
  }
  return [...signals.values()].sort(
    (a, b) =>
      a.confirmedAt - b.confirmedAt ||
      a.index - b.index ||
      a.config - b.config ||
      chanSignalCodes.indexOf(a.code) - chanSignalCodes.indexOf(b.code),
  );
}

export type ChanSignalFilter = {
  codes?: readonly ChanSignalCode[];
  direction?: Direction | "both";
  configs?: readonly (0 | 1100)[];
  minQuality?: 1 | 2;
  index?: number;
};
export function evaluateChanSignal(
  result: CzscResult,
  bars: readonly Bar[],
  filter: ChanSignalFilter = {},
) {
  const index = filter.index ?? bars.length - 1;
  const signal =
    classifyCzscSignals(result, bars, { asOfIndex: index })
      .filter(
        (s) =>
          s.confirmedAt === index &&
          (!filter.codes || filter.codes.includes(s.code)) &&
          (!filter.configs || filter.configs.includes(s.config)) &&
          s.quality >= (filter.minQuality ?? 1) &&
          (!filter.direction ||
            filter.direction === "both" ||
            filter.direction === s.direction),
      )
      .at(-1) ?? null;
  return {
    matched: signal !== null,
    signal,
    direction: signal?.direction ?? null,
    stopPrice: signal?.stopPrice ?? null,
    targetPrice: signal?.targetPrice ?? null,
    summary: signal?.summary ?? "当根无匹配的已确认缠论买卖点",
  };
}
