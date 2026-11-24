import type { Bar } from "trading-strategy-core/bars";
import {
  chanNativeCandidates,
  isNativeChanV3Profile,
  nativeChanV3Configs,
  nativeChanV3Profiles,
  type NativeChanV3Profile,
} from "./research/chan/research-chan-native.js";
import { czscSourceCommit, type CzscResult } from "./research/chan/czsc.js";

export { isNativeChanV3Profile, nativeChanV3Configs, nativeChanV3Profiles };
export type { NativeChanV3Profile };

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
export const nativeChanProfiles = [
  "chan-first-native",
  "chan-second-native",
  "chan-third-native",
  "chan-hold-cash-native",
] as const;
export type NativeChanProfile = (typeof nativeChanProfiles)[number];
export type NativeChanPointKind = 1 | 2 | 3 | -1 | -2 | -3;
export type FrozenChanPoint = FrozenChanSignal & {
  kind: NativeChanPointKind;
  divergence?: { semantic: number; flags: number };
};
export type FrozenChanV3Signal = {
  key: string;
  kind: 1 | 2 | 3;
  endpointIndex: number;
  endpointDate: string;
  confirmedAt: number;
  confirmedDate: string;
  containment?: {
    highStart: number;
    highEnd: number;
    lowStart: number;
    lowEnd: number;
  };
};
export type FrozenChanV3Projection = {
  configs: typeof nativeChanV3Configs;
  profiles: Readonly<
    Record<
      NativeChanV3Profile,
      {
        signals: readonly FrozenChanV3Signal[];
        gaps: readonly string[];
      }
    >
  >;
};
export type NativeChanProjectionVersion = 1 | 2 | 3;
export type FrozenChanObservation = {
  projectionVersion?: 2 | 3;
  points?: readonly FrozenChanPoint[];
  v3?: FrozenChanV3Projection;
  date: string;
  prefixHash: string;
  identity: NativeStudyIdentity;
  baseline: boolean;
  signals: readonly FrozenChanSignal[];
  gaps: readonly string[];
  pointGaps?: readonly string[];
};

/** Decode only the currently supplied complete prefix. No observation date is backdated. */
function decodePoints(
  bars: readonly Bar[],
  result: CzscResult,
  profile: "chan-third-native" | "chan-hold-cash-native",
) {
  if (result.sourceCommit !== czscSourceCommit)
    throw new Error("原生结构传输版本不符");
  const last = bars.length - 1,
    family = result.families.find((row) => row.config === 0);
  const third = chanNativeCandidates("chan-third-native", result, bars, 0);
  const gaps = third.gaps,
    pointGaps: string[] = [],
    pending: string[] = [],
    signals: FrozenChanSignal[] = [],
    points: FrozenChanPoint[] = [];
  let candidates = third.signals;
  if (profile === "chan-hold-cash-native" && family) {
    const other = chanNativeCandidates(
      profile,
      {
        ...result,
        families: [
          { ...family, signals: family.signals.filter((p) => p.kind !== 3) },
        ],
      },
      bars,
      0,
    );
    pointGaps.push(...other.gaps);
    const eligible = new Set([...third.signals, ...other.signals]);
    candidates = family.signals.filter((p) => eligible.has(p));
  }
  for (const point of candidates) {
    const center = family?.centers[(point.centerId ?? 0) - 1];
    if (
      !center ||
      !Number.isInteger(center.start) ||
      !Number.isInteger(center.end) ||
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
      (point.kind === 3 ? gaps : pointGaps).push(
        `${point.date}：原生确认、撤销或中枢时点不属于当前前缀`,
      );
      continue;
    }
    if (point.revokedAt! >= 0) continue;
    if (point.confirmedAt === -1) {
      pending.push(`${point.date}：原生端点尚未确认`);
      continue;
    }
    const signal: FrozenChanSignal = {
      key: `${point.date}:${point.kind}`,
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
    };
    if (point.kind === 3) signals.push(signal);
    points.push({
      ...signal,
      kind: point.kind as NativeChanPointKind,
      ...(Math.abs(point.kind) === 1 && point.divergence
        ? {
            divergence: {
              semantic: point.divergence.semantic,
              flags: point.divergence.flags,
            },
          }
        : {}),
    });
  }
  return { points, signals, gaps, pointGaps, pending };
}

export function nativeChanSignals(bars: readonly Bar[], result: CzscResult) {
  const { signals, gaps, pending } = decodePoints(
    bars,
    result,
    "chan-third-native",
  );
  return { signals, gaps, pending };
}

export function nativeChanSharedPoints(
  bars: readonly Bar[],
  result: CzscResult,
) {
  return decodePoints(bars, result, "chan-hold-cash-native");
}

/** Decode all three controls from the same two-level snapshot. */
export function nativeChanV3Projection(
  bars: readonly Bar[],
  result: CzscResult,
): FrozenChanV3Projection {
  if (
    result.sourceCommit !== czscSourceCommit ||
    nativeChanV3Configs.some(
      (config) => !result.families.some((family) => family.config === config),
    )
  )
    throw new Error("v3 原生投影须包含锁定版本的 config 0 与 1100");
  const last = bars.length - 1;
  const profiles = {} as Record<
    NativeChanV3Profile,
    FrozenChanV3Projection["profiles"][NativeChanV3Profile]
  >;
  for (const profile of nativeChanV3Profiles) {
    const { signals, gaps } = chanNativeCandidates(profile, result, bars, 0);
    const byKey = new Map<string, FrozenChanV3Signal>();
    for (const signal of signals) {
      if (signal.kind !== 1 && signal.kind !== 2 && signal.kind !== 3) continue;
      // CH07's native cross-level association has both confirmations but
      // carries no confirmation index. It is knowable on this prefix.
      const confirmedAt =
        profile === "chan-nested-native" ? last : signal.confirmedAt;
      if ((signal.revokedAt ?? -1) >= 0 || confirmedAt === -1) continue;
      const confirmedDate =
        confirmedAt === undefined ? undefined : bars[confirmedAt]?.date;
      if (
        !confirmedDate ||
        confirmedAt! < signal.index ||
        bars[signal.index]?.date !== signal.date
      ) {
        gaps.push(`${signal.date}：原生组合确认时点无效`);
        continue;
      }
      const key = `${signal.date}:${signal.kind}`;
      if (byKey.has(key)) continue;
      const reference = signal.containment;
      byKey.set(key, {
        key,
        kind: signal.kind,
        endpointIndex: signal.index,
        endpointDate: signal.date,
        confirmedAt: confirmedAt!,
        confirmedDate,
        ...(reference && {
          containment: {
            highStart: reference.highCandidate.segmentStart!,
            highEnd: reference.highCandidate.segmentEnd!,
            lowStart: reference.lowStart,
            lowEnd: reference.lowEnd,
          },
        }),
      });
    }
    profiles[profile] = { signals: [...byKey.values()], gaps };
  }
  return { configs: nativeChanV3Configs, profiles };
}

function validateV3Projection(
  row: FrozenChanObservation,
  bars: readonly Bar[],
  index: number,
  selected: NativeChanV3Profile | undefined,
  seen: Set<string>,
) {
  const data = row.v3;
  if (
    row.projectionVersion !== 3 ||
    !data ||
    data.configs?.length !== 2 ||
    data.configs[0] !== 0 ||
    data.configs[1] !== 1100
  )
    throw new Error("原生组合投影结构缺口：需要完整的 v3 双级投影");
  for (const profile of nativeChanV3Profiles) {
    const facts = data.profiles?.[profile];
    if (!Array.isArray(facts?.signals) || !Array.isArray(facts.gaps))
      throw new Error("v3 原生组合观察缺失");
    if (profile === selected && facts.gaps.length)
      throw new Error(`v3 原生组合投影存在结构缺口：${profile}`);
    for (const signal of facts.signals as readonly FrozenChanV3Signal[]) {
      const {
        key,
        kind,
        endpointIndex,
        endpointDate,
        confirmedAt,
        confirmedDate,
        containment,
      } = signal;
      const id = `${profile}:${key}`;
      if (
        seen.has(id) ||
        key !== `${endpointDate}:${kind}` ||
        !Number.isInteger(endpointIndex) ||
        endpointIndex < 0 ||
        !Number.isInteger(confirmedAt) ||
        confirmedAt < endpointIndex ||
        confirmedAt > index ||
        ![1, 2, 3].includes(kind) ||
        bars[endpointIndex]?.date !== endpointDate ||
        bars[confirmedAt]?.date !== confirmedDate
      )
        throw new Error("v3 原生组合信号重复或引用超出当前已知前缀");
      if (profile === "chan-overlap-native") {
        if (containment || (kind !== 2 && kind !== 3))
          throw new Error("v3 二三买重合信号类别无效");
      } else {
        if (!containment) throw new Error("v3 原生组合缺少高级别区间");
        const { highStart, highEnd, lowStart, lowEnd } = containment;
        if (
          ![highStart, highEnd, lowStart, lowEnd].every(Number.isInteger) ||
          highStart < 0 ||
          highStart >= highEnd ||
          highEnd > index ||
          lowStart < highStart ||
          lowStart > lowEnd ||
          lowEnd > highEnd ||
          lowEnd !== endpointIndex ||
          (profile === "chan-nested-native" &&
            (kind !== 1 ||
              confirmedAt !== index ||
              lowStart === lowEnd ||
              (lowStart === highStart && lowEnd === highEnd))) ||
          (profile === "chan-rebound-native" && lowStart !== lowEnd)
        )
          throw new Error("v3 原生组合级别区间无效");
      }
      seen.add(id);
    }
  }
}

export function nativeChanV3Rules(profile: NativeChanV3Profile) {
  const entry = { kind: "external", id: profile, side: "entry" } as const;
  return { entry, exit: { maxBars: 5 } };
}

export function resolveNativeChanFirstIndex(
  bars: readonly Bar[],
  observations: readonly FrozenChanObservation[],
  explicitFirst?: number,
) {
  const baseline = observations[0];
  const first = bars.findIndex((bar) => bar.date === baseline?.date) + 1;
  if (
    baseline?.baseline !== true ||
    first < nativeStudyDefinition.warmupBars ||
    first >= bars.length ||
    (explicitFirst !== undefined && first !== explicitFirst)
  )
    throw new Error("原生观察基线与执行起点不一致或预热不足");
  return first;
}

/** Validate the frozen feed once, before it can affect cash or orders. */
function validateObservations(
  bars: readonly Bar[],
  first: number,
  observations: readonly FrozenChanObservation[],
  profile?: NativeChanProfile | NativeChanV3Profile,
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
  const selectedV3 =
    profile && isNativeChanV3Profile(profile) ? profile : undefined;
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
    if (selectedV3 || row.projectionVersion === 3)
      validateV3Projection(row, bars, i, selectedV3, seen);
    if (
      profile &&
      !selectedV3 &&
      profile !== "chan-third-native" &&
      row.pointGaps !== undefined &&
      (!Array.isArray(row.pointGaps) || row.pointGaps.length > 0)
    )
      throw new Error("原生买卖点投影存在结构缺口");
    const projected =
      profile !== undefined &&
      (row.points !== undefined ||
        row.projectionVersion !== undefined ||
        profile !== "chan-third-native");
    if (
      projected &&
      ((row.projectionVersion !== 2 && row.projectionVersion !== 3) ||
        !Array.isArray(row.points))
    )
      throw new Error("原生策略需要完整的 v2 买卖点投影");
    let thirdIndex = 0;
    for (const signal of projected ? row.points! : row.signals) {
      const point = projected ? (signal as FrozenChanPoint) : undefined;
      const kind = point ? point.kind : 3;
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
        ![1, 2, 3, -1, -2, -3].includes(kind) ||
        (Math.abs(kind) === 1 &&
          (!point?.divergence ||
            point.divergence.semantic !== 1 ||
            !Number.isInteger(point.divergence.flags) ||
            (point.divergence.flags & 17) !== 17)) ||
        signal.key !== `${signal.endpointDate}:${kind}`
      )
        throw new Error("原生信号重复或引用超出当前已知前缀");
      if (point && kind === 3) {
        const legacy = row.signals[thirdIndex++];
        if (!legacy || !sameSignal(legacy, point))
          throw new Error("原生三买信号与共享投影不一致");
      }
      seen.add(signal.key);
    }
    if (projected && thirdIndex !== row.signals.length)
      throw new Error("原生三买信号与共享投影不一致");
  }
  return (i: number, position?: { entry: number; entryIndex: number }) => {
    const row = observations[i - first + 1];
    if (!row || row.date !== bars[i]?.date)
      throw new Error("缺少原生决策日期观察");
    if (profile && row.baseline) return { enter: false, exit: false };
    const points = profile ? row.points : undefined;
    const hold = profile === "chan-hold-cash-native";
    const kind =
      profile === "chan-first-native"
        ? 1
        : profile === "chan-second-native"
          ? 2
          : 3;
    return {
      enter:
        !row.baseline &&
        (selectedV3
          ? row.v3!.profiles[selectedV3].signals.length > 0
          : points
            ? points.some((p) => (hold ? p.kind > 0 : p.kind === kind))
            : row.signals.length > 0),
      exit:
        !!position &&
        position.entry > 0 &&
        (hold
          ? points!.some((p) => p.kind < 0)
          : i - position.entryIndex >= (selectedV3 ? 4 : 5)),
    };
  };
}

function sameSignal(a: FrozenChanSignal, b: FrozenChanSignal) {
  return (
    a.key === b.key &&
    a.endpointIndex === b.endpointIndex &&
    a.endpointDate === b.endpointDate &&
    a.confirmedAt === b.confirmedAt &&
    a.confirmedDate === b.confirmedDate &&
    a.centerId === b.centerId &&
    a.center &&
    (Object.keys(b.center) as (keyof typeof b.center)[]).every(
      (key) => a.center[key] === b.center[key],
    )
  );
}

export function createNativeStudyRule(
  bars: readonly Bar[],
  first: number,
  observations: readonly FrozenChanObservation[],
) {
  return validateObservations(bars, first, observations);
}

export function createNativeChanProfileRule(
  profile: NativeChanProfile | NativeChanV3Profile,
  bars: readonly Bar[],
  observations: readonly FrozenChanObservation[],
  explicitFirst?: number,
) {
  const first = resolveNativeChanFirstIndex(bars, observations, explicitFirst);
  return validateObservations(bars, first, observations, profile);
}
