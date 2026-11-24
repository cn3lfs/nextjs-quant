import { createHash } from "node:crypto";
import type { Bar } from "~/lib/domain";
import type { JobSignal } from "../jobs/jobs";
import {
  nativeChanSharedPoints,
  nativeChanV3Profiles,
  nativeChanV3Projection,
  nativeStudyDefinition,
  type FrozenChanObservation,
  type FrozenChanPoint,
  type FrozenChanSignal,
  type NativeChanV3Profile,
  type NativeStudyIdentity,
} from "trading-strategies";
import {
  analyzeCzsc,
  analyzeNativeThirdBuy,
  nativeIdentityFromSnapshot,
  projectCzsc,
} from "./chan/czsc";

type AuditPoint = FrozenChanSignal &
  Partial<Pick<FrozenChanPoint, "kind" | "divergence">>;
type NativeAudit = {
  date: string;
  key: string;
  event: "baseline" | "first-seen" | "revised" | "withdrawn" | "reappeared";
  reason?: string;
  before?: AuditPoint;
  after?: AuditPoint;
  profile?: NativeChanV3Profile;
};
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** The existing projectCzsc queue owns all DLL calls; this loop never opens another worker. */
export async function captureNativeChanObservations(
  bars: readonly Bar[],
  first: number = nativeStudyDefinition.warmupBars,
  signal?: JobSignal,
  project: typeof projectCzsc = projectCzsc,
  progress?: (done: number, total: number) => void,
  projection: "third-buy" | "full-reference" | "v3" = "third-buy",
) {
  if (
    !Number.isInteger(first) ||
    first < nativeStudyDefinition.warmupBars ||
    first >= bars.length
  )
    throw new Error("原生观察缺少固定起点预热或执行行情");
  const observations: FrozenChanObservation[] = [],
    audit: NativeAudit[] = [];
  const pending: { date: string; details: string[] }[] = [];
  const seen = new Set<string>();
  const seenV3 = new Set<string>();
  let active = new Map<string, FrozenChanPoint>();
  let identity: NativeStudyIdentity | undefined;
  for (let index = first - 1; index < bars.length; index++) {
    signal?.throwIfAborted();
    const prefix = bars.slice(0, index + 1);
    let captured: NativeStudyIdentity | undefined;
    const wrapped: typeof projectCzsc = async (input, request) => {
      if (captured) throw new Error("同一收盘原生观察重复调用DLL");
      signal?.throwIfAborted();
      const raw = await project(
        input,
        request,
        () => signal?.aborted === true,
        signal?.jobId,
      );
      signal?.throwIfAborted();
      captured = nativeIdentityFromSnapshot(raw);
      if (identity && JSON.stringify(captured) !== JSON.stringify(identity))
        throw new Error("回放期间原生DLL或配置变化");
      return raw;
    };
    const result =
      projection === "third-buy"
        ? await analyzeNativeThirdBuy(prefix, wrapped)
        : await analyzeCzsc(prefix, true, wrapped, true, 1);
    signal?.throwIfAborted();
    if (!captured) throw new Error("原生观察未捕获DLL身份");
    identity ??= captured;
    const decoded = nativeChanSharedPoints(prefix, result);
    if (decoded.gaps.length)
      throw new Error(`原生结构元数据缺口：${decoded.gaps.join("；")}`);
    const baseline = index === first - 1,
      date = bars[index]!.date;
    if (decoded.pending.length)
      pending.push({ date, details: decoded.pending });
    const current = new Map<string, FrozenChanPoint>();
    const points: FrozenChanPoint[] = [];
    for (const point of decoded.points) {
      if (current.has(point.key)) {
        if (point.kind === 3) throw new Error("原生同一前缀信号身份重复");
        decoded.pointGaps.push(`${point.key}：原生同一前缀信号身份重复`);
        continue;
      }
      current.set(point.key, point);
      const previous = active.get(point.key);
      if (!seen.has(point.key)) {
        seen.add(point.key);
        points.push(point);
        audit.push({
          date,
          key: point.key,
          event: baseline ? "baseline" : "first-seen",
          after: point,
        });
      } else if (!previous) {
        audit.push({ date, key: point.key, event: "reappeared", after: point });
      } else if (JSON.stringify(previous) !== JSON.stringify(point)) {
        audit.push({
          date,
          key: point.key,
          event: "revised",
          before: previous,
          after: point,
        });
      }
    }
    for (const [key, previous] of active) {
      if (!current.has(key))
        audit.push({
          date,
          key,
          event: "withdrawn",
          before: previous,
          reason:
            "当前前缀已撤销、移除或不再满足原生买卖点资格；不改写此前首次观察事实",
        });
    }
    const freshKeys = new Set(points.map((p) => p.key));
    active = current;
    const v3 =
      projection === "v3" ? nativeChanV3Projection(prefix, result) : undefined;
    if (v3) {
      for (const profile of nativeChanV3Profiles) {
        const facts = v3.profiles[profile];
        v3.profiles = {
          ...v3.profiles,
          [profile]: {
            ...facts,
            signals: facts.signals.filter(({ key }) => {
              const id = `${profile}:${key}`;
              if (seenV3.has(id)) return false;
              seenV3.add(id);
              audit.push({
                date,
                key,
                profile,
                event: baseline ? "baseline" : "first-seen",
              });
              return true;
            }),
          },
        };
      }
    }
    observations.push({
      date,
      prefixHash: digest(prefix),
      identity: captured,
      baseline,
      projectionVersion: v3 ? 3 : 2,
      ...(v3 && { v3 }),
      points,
      signals: decoded.signals.filter((signal) => freshKeys.has(signal.key)),
      gaps: decoded.gaps,
      ...(decoded.pointGaps.length ? { pointGaps: decoded.pointGaps } : {}),
    });
    progress?.(observations.length, bars.length - first + 1);
  }
  return {
    version:
      projection === "v3"
        ? "strategy-center-native-3"
        : "strategy-center-native-2",
    identity: identity!,
    originDate: bars[0]!.date,
    baselineDate: bars[first - 1]!.date,
    priceBasis: "forward-cash-dividend-adjusted" as const,
    observations,
    audit,
    pending,
    boundary:
      "固定输入起点，保留至少140根预热。每个收盘只投影当时完整前缀。基线已有点仅作记录，后续首次确认的买卖点供下一合法开盘执行。撤销、修订和再现只追加审计。",
  };
}
