import type { Bar } from "./domain";
import type { CzscFamily, CzscResult } from "./czsc";

export const chanNativeProfiles = {
  "chan-first-native": ["CH01", "原生一买 · 趋势背驰证据", 1],
  "chan-second-native": ["CH02", "原生二买 · DLL次级别回调", 2],
  "chan-third-native": ["CH03", "原生三买 · 中枢上首次回试", 3],
} as const;
export type ChanNativeId = keyof typeof chanNativeProfiles;
export const chanNativeIds = Object.keys(chanNativeProfiles) as ChanNativeId[];
export const isChanNative = (id: string): id is ChanNativeId =>
  Object.hasOwn(chanNativeProfiles, id);
export const chanNativeBoundary =
  "复用b67f3c6 DLL原生具名子集，保持配置0/1100、单队列逐完整前缀调用。每根只消费当时新出现的quality=1/2信号，端点日与首次可知确认日分离；预热已有信号不回填。原生kind=1另需semantic=1及flags含新极值(1)/背驰确认(16)、所属中枢存在且端点低于ZD；kind=2仅选原生二买，原生规则为一买后的第二段回调不低于一买低点；kind=3另验所属中枢ZG之上，严格大于，首次回试由原生算法负责。中枢归属来自output25，禁止最近中枢推测。缺少元数据或归属无效报结构缺口，不补造信号。固定持有期及既有可选风控，确认后下一合法开盘，T+1及成交限制保持；不实现裸卖空。这三个预设是锁定DLL的具体规则变体，不宣称原文递归级别、二三买重合、区间套或完整体系覆盖；固定输入不是盈利证据。";
export const chanNativeStrategies = Object.fromEntries(
  chanNativeIds.map((id) => [
    id,
    {
      label: `缠论 · ${chanNativeProfiles[id][1]}`,
      family: "缠论原生结构",
      signal: "czsc" as const,
      version: `${id}-engineering-1`,
      description: chanNativeBoundary,
      sources: [
        "chan-theory/SKILL.md",
        "chan-theory/references/05-trading-points.md",
        "chan-theory/references/04-dynamics.md",
      ],
    },
  ]),
) as Record<
  ChanNativeId,
  {
    label: string;
    family: string;
    signal: "czsc";
    version: string;
    description: string;
    sources: string[];
  }
>;

export function chanNativeCandidates(
  id: ChanNativeId,
  result: CzscResult,
  bars: readonly Bar[],
  config: 0 | 1100,
) {
  const family = result.families.find((f) => f.config === config);
  const gaps: string[] = [];
  const signals: CzscFamily["signals"] = [];
  if (result.status !== "structure") return { signals, gaps };
  if (!family) return { signals, gaps: ["结构缺口：缺少指定原生配置输出"] };
  for (const p of family.signals.filter(
    (s) => s.kind === chanNativeProfiles[id][2] && [1, 2].includes(s.quality),
  )) {
    const bar = bars[p.index];
    const center =
      p.centerId != null && Number.isInteger(p.centerId)
        ? family.centers[p.centerId - 1]
        : undefined;
    if (
      !bar ||
      bar.date !== p.date ||
      !center ||
      !Number.isFinite(center.ZD) ||
      !Number.isFinite(center.ZG) ||
      center.ZD <= 0 ||
      center.ZD > center.ZG ||
      center.end > p.index ||
      center.end < center.start ||
      bars[center.start]?.date !== center.startDate ||
      bars[center.end]?.date !== center.endDate ||
      center.start < 0 ||
      center.end >= bars.length
    ) {
      gaps.push(`${p.date}：结构缺口，缺少有效原生中枢归属或端点`);
      continue;
    }
    if (p.kind === 1) {
      const d = p.divergence;
      if (!d || !Number.isInteger(d.flags) || !Number.isFinite(d.semantic)) {
        gaps.push(`${p.date}：结构缺口，缺少原生背驰语义/标志`);
        continue;
      }
      if (
        d.semantic !== 1 ||
        (d.flags & 17) !== 17 ||
        Math.fround(bar.low) >= Math.fround(center.ZD)
      )
        continue;
    }
    if (p.kind === 3 && Math.fround(bar.low) <= Math.fround(center.ZG))
      continue;
    signals.push(p);
  }
  return { signals, gaps };
}
