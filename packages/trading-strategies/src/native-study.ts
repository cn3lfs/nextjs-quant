import type { Bar } from "trading-strategy-core/bars";
import { chanNativeCandidates } from "./research/chan/research-chan-native.js";
import { czscSourceCommit, type CzscResult } from "./research/chan/czsc.js";

export const nativeStudyStrategies = ["research-chan"] as const;
export type NativeStudyStrategy = (typeof nativeStudyStrategies)[number];
export const nativeStudyDefinition = {
  id: "research-chan",
  name: "缠论三买 · 原生确认基础",
  family: "chan",
  version: 1,
  warmupBars: 140,
  rule: "固定开始日前140根输入起点，现金分红按已发生事件前向调整，基线为开始日前一收盘；其后逐收盘以该起点以来完整前缀调用原生DLL，配置0/日线锚1，仅首次观察到已确认且未撤销三买入场，下一合法开盘撮合。同端点归属修订不重复入场。默认持有5交易记录退出。不回填端点日期，不等同全源历史或完整缠论买卖体系。",
  sources: ["chan-theory/SKILL.md"],
} as const;
export const isNativeStudyStrategy = (id: string): id is NativeStudyStrategy =>
  (nativeStudyStrategies as readonly string[]).includes(id);

export type NativeStudyIdentity = {
  dllHash: string;
  apiVersion: number;
  buildCommit: string;
  configId: string;
  config: 0;
  anchor: 1;
};
export type FrozenChanSignal = {
  key: string;
  endpointIndex: number;
  endpointDate: string;
  confirmedAt: number;
  confirmedDate: string;
  centerId: number;
  center: {
    start: number;
    end: number;
    startDate: string;
    endDate: string;
    ZG: number;
    ZD: number;
    confirmedAt: number;
    established: number;
  };
};
export type FrozenChanObservation = {
  date: string;
  prefixHash: string;
  identity: NativeStudyIdentity;
  baseline: boolean;
  signals: readonly FrozenChanSignal[];
  gaps: readonly string[];
};

/** Decode only the currently supplied complete prefix. No observation date is backdated. */
export function nativeChanSignals(bars: readonly Bar[], result: CzscResult) {
  if (result.sourceCommit !== czscSourceCommit)
    throw new Error("原生结构传输版本不符");
  const found = chanNativeCandidates("chan-third-native", result, bars, 0);
  const last = bars.length - 1,
    family = result.families.find((row) => row.config === 0);
  const gaps = [...found.gaps],
    pending: string[] = [],
    signals: FrozenChanSignal[] = [];
  for (const point of found.signals) {
    const center = family?.centers[(point.centerId ?? 0) - 1];
    if (
      !center ||
      !Number.isInteger(point.confirmedAt) ||
      point.confirmedAt! < -1 ||
      point.confirmedAt! > last ||
      !Number.isInteger(point.revokedAt) ||
      point.revokedAt! < -1 ||
      point.revokedAt! > last ||
      !Number.isInteger(center.confirmedAt) ||
      center.confirmedAt! < -1 ||
      center.confirmedAt! > last ||
      !Number.isInteger(center.established) ||
      center.established! < 0 ||
      center.established! > last ||
      !Number.isInteger(point.index) ||
      point.index < 0 ||
      point.index > last ||
      (point.confirmedAt! >= 0 && point.confirmedAt! < point.index) ||
      bars[point.index]?.date !== point.date
    ) {
      gaps.push(`${point.date}：原生确认、撤销或中枢时点不属于当前前缀`);
      continue;
    }
    if (point.revokedAt! >= 0) continue;
    if (point.confirmedAt === -1) {
      pending.push(`${point.date}：原生端点尚未确认`);
      continue;
    }
    signals.push({
      key: `${point.date}:3`,
      endpointIndex: point.index,
      endpointDate: point.date,
      confirmedAt: point.confirmedAt!,
      confirmedDate: bars[point.confirmedAt!]!.date,
      centerId: point.centerId!,
      center: {
        start: center.start,
        end: center.end,
        startDate: center.startDate,
        endDate: center.endDate,
        ZG: center.ZG,
        ZD: center.ZD,
        confirmedAt: center.confirmedAt!,
        established: center.established!,
      },
    });
  }
  return { signals, gaps, pending };
}

/** Validate the frozen feed once, before it can affect cash or orders. */
export function createNativeStudyRule(
  bars: readonly Bar[],
  first: number,
  observations: readonly FrozenChanObservation[],
) {
  if (
    !Number.isInteger(first) ||
    first < nativeStudyDefinition.warmupBars ||
    first >= bars.length ||
    observations.length !== bars.length - first + 1
  )
    throw new Error("原生观察必须完整覆盖基线及全部执行日期");
  let identity: string | undefined;
  const seen = new Set<string>();
  for (let j = 0; j < observations.length; j++) {
    const row = observations[j]!,
      i = first - 1 + j,
      meta = row?.identity;
    if (
      !row ||
      !meta ||
      !Array.isArray(row.signals) ||
      !Array.isArray(row.gaps) ||
      row.gaps.length > 0 ||
      row.date !== bars[i]!.date ||
      row.baseline !== (j === 0) ||
      !/^[a-f0-9]{64}$/.test(row.prefixHash) ||
      !/^[a-f0-9]{64}$/.test(meta.dllHash) ||
      meta.apiVersion !== 22 ||
      typeof meta.buildCommit !== "string" ||
      !meta.buildCommit.trim() ||
      typeof meta.configId !== "string" ||
      !meta.configId.trim() ||
      meta.config !== 0 ||
      meta.anchor !== 1
    )
      throw new Error("原生观察日期、前缀或DLL身份无效");
    const currentIdentity = JSON.stringify([
      meta.dllHash,
      meta.apiVersion,
      meta.buildCommit,
      meta.configId,
      meta.config,
      meta.anchor,
    ]);
    if (identity !== undefined && identity !== currentIdentity)
      throw new Error("回放期间原生DLL或配置变化");
    identity = currentIdentity;
    for (const signal of row.signals) {
      const c = signal.center;
      if (
        seen.has(signal.key) ||
        !signal.key ||
        !Number.isInteger(signal.endpointIndex) ||
        signal.endpointIndex < 0 ||
        signal.endpointIndex > i ||
        bars[signal.endpointIndex]?.date !== signal.endpointDate ||
        !Number.isInteger(signal.confirmedAt) ||
        signal.confirmedAt < signal.endpointIndex ||
        signal.confirmedAt > i ||
        bars[signal.confirmedAt]?.date !== signal.confirmedDate ||
        !Number.isInteger(signal.centerId) ||
        signal.centerId < 1 ||
        !Number.isInteger(c.start) ||
        !Number.isInteger(c.end) ||
        c.start < 0 ||
        c.start > signal.endpointIndex ||
        c.end < c.start ||
        c.end > i ||
        bars[c.start]?.date !== c.startDate ||
        bars[c.end]?.date !== c.endDate ||
        !Number.isInteger(c.confirmedAt) ||
        c.confirmedAt < -1 ||
        c.confirmedAt > i ||
        !Number.isInteger(c.established) ||
        c.established < 0 ||
        c.established > i ||
        !Number.isFinite(c.ZD) ||
        !Number.isFinite(c.ZG) ||
        c.ZD <= 0 ||
        c.ZG < c.ZD ||
        signal.key !== `${signal.endpointDate}:3`
      )
        throw new Error("原生信号重复或引用超出当前已知前缀");
      seen.add(signal.key);
    }
  }
  return (i: number, position: { entry: number; entryIndex: number }) => {
    const row = observations[i - first + 1];
    if (!row || row.date !== bars[i]?.date)
      throw new Error("缺少原生决策日期观察");
    return {
      enter: !row.baseline && row.signals.length > 0,
      exit: position.entry > 0 && i - position.entryIndex >= 5,
    };
  };
}
