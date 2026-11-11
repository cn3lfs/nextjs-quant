import { createHash } from "node:crypto";
import type { Bar } from "~/lib/domain";
import {
  nativeChanSignals,
  nativeStudyDefinition,
  type FrozenChanObservation,
  type FrozenChanSignal,
  type NativeStudyIdentity,
} from "trading-strategies";
import { analyzeCzsc, projectCzsc } from "./chan/czsc";

type NativeAudit = {
  date: string;
  key: string;
  event: "baseline" | "first-seen" | "revised" | "withdrawn" | "reappeared";
  reason?: string;
  before?: FrozenChanSignal;
  after?: FrozenChanSignal;
};
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** The existing projectCzsc queue owns all DLL calls; this loop never opens another worker. */
export async function captureNativeChanObservations(
  bars: readonly Bar[],
  first: number,
  signal?: AbortSignal,
  project: typeof projectCzsc = projectCzsc,
  progress?: (done: number, total: number) => void,
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
  let active = new Map<string, FrozenChanSignal>();
  let identity: NativeStudyIdentity | undefined;
  for (let index = first - 1; index < bars.length; index++) {
    signal?.throwIfAborted();
    const prefix = bars.slice(0, index + 1);
    let captured: NativeStudyIdentity | undefined;
    const wrapped: typeof projectCzsc = async (input, request) => {
      if (captured) throw new Error("同一收盘原生观察重复调用DLL");
      signal?.throwIfAborted();
      const raw = await project(input, request);
      signal?.throwIfAborted();
      if (
        !/^[a-f0-9]{64}$/.test(raw.hash) ||
        raw.apiVersion !== 22 ||
        typeof raw.buildCommit !== "string" ||
        !raw.buildCommit.trim() ||
        typeof raw.configId !== "string" ||
        !raw.configId.trim()
      )
        throw new Error("原生DLL身份元数据缺失或无效");
      captured = {
        dllHash: raw.hash,
        apiVersion: raw.apiVersion,
        buildCommit: raw.buildCommit,
        configId: raw.configId,
        config: 0,
        anchor: 1,
      };
      if (identity && JSON.stringify(captured) !== JSON.stringify(identity))
        throw new Error("回放期间原生DLL或配置变化");
      return raw;
    };
    const result = await analyzeCzsc(prefix, true, wrapped, true, 1);
    signal?.throwIfAborted();
    if (!captured) throw new Error("原生观察未捕获DLL身份");
    identity ??= captured;
    const decoded = nativeChanSignals(prefix, result);
    if (decoded.gaps.length)
      throw new Error(`原生结构元数据缺口：${decoded.gaps.join("；")}`);
    const baseline = index === first - 1,
      date = bars[index]!.date;
    if (decoded.pending.length)
      pending.push({ date, details: decoded.pending });
    const current = new Map<string, FrozenChanSignal>();
    const signals: FrozenChanSignal[] = [];
    for (const point of decoded.signals) {
      if (current.has(point.key)) throw new Error("原生同一前缀信号身份重复");
      current.set(point.key, point);
      const previous = active.get(point.key);
      if (!seen.has(point.key)) {
        seen.add(point.key);
        signals.push(point);
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
            "当前前缀已撤销、移除或不再满足原生三买资格；不改写此前首次观察事实",
        });
    }
    active = current;
    observations.push({
      date,
      prefixHash: digest(prefix),
      identity: captured,
      baseline,
      signals,
      gaps: decoded.gaps,
    });
    progress?.(observations.length, bars.length - first + 1);
  }
  return {
    version: "strategy-center-native-1",
    identity: identity!,
    originDate: bars[0]!.date,
    baselineDate: bars[first - 1]!.date,
    priceBasis: "forward-cash-dividend-adjusted" as const,
    observations,
    audit,
    pending,
    boundary:
      "固定开始日前140根起点；每收盘只使用该起点以来完整前缀，非全源历史。基线已有点不买；后续首次合格点收盘确认、下一开盘执行。撤销、修订和再现只追加审计，不回写原始观察或重复入场。",
  };
}
