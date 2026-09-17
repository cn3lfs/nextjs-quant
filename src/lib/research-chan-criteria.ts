import type { Bar } from "./domain";
import type { CzscFamily, CzscResult, CzscSignalStructure } from "./czsc";

export const chanStructureTasks = {
  CH04: "验证二三买重合胜出候选同时保留二类40/41与三类33/34关联；原生第三类胜出可能不导出二类端点，缺失不可猜测",
  CH05: "已完成连续周线逐前缀调用，验证semantic=2与原生A/C及中枢归属；日线不代替周线",
  CH06: "C2已暴露完整成员列表；仍缺可证实走势完成边界与理论同级别，不能把后继中枢分组出现直接当成唯一完成边界",
  CH07: "C2已接入全量高级别Candidates完整表与output50跨根ID关联；两层构件包含工程版本见chan-nested-native",
  CH08: "原生新增完整已完成同级别走势序列、级别、连接边界；output23仅胜出信号所属方向",
  CH09: "复用CH08已完成走势序列，证明下跌与上涨的同级别连接及操作确认时点",
  CH10: "47/48只证明中枢间生命周期分类；需中阴阶段进入/结束及操作级别上下文",
  CH11: "接入历史板块成分与各板块同窗均线，冻结强弱排序及轮动参数；双基准RS不等于板块轮动",
  CH12: "C2已接入高级别背驰段与低级别买点包含；日线短持有工程版本见chan-rebound-native",
  CH13: "补完整月线日历适配与月线逐前缀背驰、其后首次三类点；周线和日线不能代替月线",
  CH14: "对称消费经归属验证的原生卖点，接入持有状态及受阻重试；卖点只退出已有多仓",
  CH15: "冻结市场基准及MACD零轴口径，复用现有训练/资金约束；不从DLL结构推导账户能力",
  "CH16-ma-kiss":
    "原生10/11/13均线差与吻已有；冻结具名吻入场/失效/退出规则，不把湿吻放量4当有效吻",
  "CH17-ma-area":
    "使用均线差10与吻11，按已完成前后同向区间累计面积；与DLL的MACD面积比29分名",
  "CH17-ma-average-force":
    "使用均线差10与吻11逐前缀累计单位时间面积；output12为原生端点即时背驰，不冒充均线面积平均力度",
  "CH18-small-to-large":
    "核验38/39/42、原生三类归属及原文回抽退出边界；semantic=3只为必要条件，不能标充分确认",
} as const;

export type ChanCriterion =
  | "overlap"
  | "trend-divergence"
  | "consolidation-divergence"
  | "small-turn-necessary";
type Signal = CzscFamily["signals"][number];
type PointField = Exclude<
  keyof CzscSignalStructure,
  "contextFlags" | "trendId" | "breakoutId" | "centerLifecycle"
>;

/** A uniform fact adapter for declaration rows. It proves only the requested
 * native predicate, not the full original-text method or trading completion. */
export function chanStructureCriterion(
  criterion: ChanCriterion,
  result: CzscResult,
  bars: readonly Bar[],
  config: 0 | 1100,
  signal: Signal,
) {
  const gaps: string[] = [];
  const family = result.families.find((f) => f.config === config);
  const meta = signal.structure;
  if (result.status !== "structure" || result.sourceCommit !== "b67f3c6")
    gaps.push("原生结构状态或锁定版本不符");
  const center =
    family && Number.isInteger(signal.centerId) && signal.centerId! > 0
      ? family.centers[signal.centerId! - 1]
      : undefined;
  if (!family || !meta || !family.signals.includes(signal))
    gaps.push("缺少当前前缀原生信号及结构元数据");
  if (
    !Number.isInteger(signal.index) ||
    bars[signal.index]?.date !== signal.date
  )
    gaps.push("信号端点与当前前缀不符");
  if (
    !center ||
    !Number.isInteger(center.start) ||
    !Number.isInteger(center.end) ||
    center.end > signal.index ||
    center.start < 0 ||
    center.end < center.start ||
    bars[center.start]?.date !== center.startDate ||
    bars[center.end]?.date !== center.endDate ||
    ![center.ZD, center.ZG].every((v) => Number.isFinite(v) && v > 0) ||
    center.ZD > center.ZG
  )
    gaps.push("缺少有效中枢归属");
  const point = (field: PointField) => {
    const id = meta?.[field];
    const p =
      Number.isInteger(id) && id! > 0 ? family?.points[id! - 1] : undefined;
    if (
      !p ||
      !Number.isInteger(p.index) ||
      p.index < 0 ||
      p.index > signal.index ||
      bars[p.index]?.date !== p.date ||
      !Number.isFinite(p.price) ||
      p.price <= 0 ||
      ![-1, 1].includes(p.direction) ||
      Math.fround(p.price) !==
        Math.fround(p.direction > 0 ? bars[p.index]!.high : bars[p.index]!.low)
    ) {
      gaps.push(`缺少有效原生端点关联：${field}`);
      return null;
    }
    return p;
  };
  const own = point("pointId");
  if (own && own.index !== signal.index)
    gaps.push("原生pointId与信号位置不一致");
  const flags = meta?.contextFlags;
  if (!Number.isInteger(flags) || flags! < 0)
    gaps.push("原生上下文位图缺失或无效");
  let matches = [1, 2].includes(signal.quality);
  if (criterion === "overlap") {
    matches &&=
      [2, 3].includes(Math.abs(signal.kind)) &&
      (flags! & 2048) !== 0 &&
      (flags! & 4096) !== 0;
    if (matches) {
      const base = point("secondBasePointId"),
        turn = point("secondTurnPointId"),
        leave = point("leavePointId"),
        retest = point("retestPointId");
      matches &&= !!(
        base &&
        turn &&
        own &&
        leave &&
        retest &&
        base.index < turn.index &&
        turn.index < own.index &&
        leave.index < retest.index &&
        retest.index === own.index &&
        base.direction === -Math.sign(signal.kind) &&
        turn.direction === Math.sign(signal.kind) &&
        own.direction === base.direction &&
        (signal.kind > 0
          ? own.price >= base.price &&
            Math.fround(own.price) > Math.fround(center?.ZG ?? NaN)
          : own.price <= base.price &&
            Math.fround(own.price) < Math.fround(center?.ZD ?? NaN))
      );
    }
  } else if (criterion === "small-turn-necessary") {
    matches &&=
      Math.abs(signal.kind) === 3 && signal.divergence?.semantic === 3;
    if (matches) {
      const base = point("smallTurnBasePointId"),
        leave = point("smallTurnLeavePointId"),
        retest = point("smallTurnRetestPointId");
      matches &&= !!(
        base &&
        leave &&
        retest &&
        own &&
        base.index < leave.index &&
        leave.index < retest.index &&
        retest.index === own.index &&
        base.direction === -Math.sign(signal.kind) &&
        leave.direction === Math.sign(signal.kind) &&
        retest.direction === base.direction &&
        (signal.kind > 0
          ? Math.fround(own.price) > Math.fround(center?.ZG ?? NaN)
          : Math.fround(own.price) < Math.fround(center?.ZD ?? NaN))
      );
    }
  } else {
    const d = signal.divergence;
    if (!d || !Number.isInteger(d.flags) || !Number.isFinite(d.areaRatio))
      gaps.push("原生背驰语义或力度缺失");
    matches &&=
      Math.abs(signal.kind) === 1 &&
      d?.semantic === (criterion === "trend-divergence" ? 1 : 2) &&
      !!d &&
      (d.flags & 16) !== 0;
    if (matches) {
      const a = point("previousStartPointId"),
        b = point("previousEndPointId"),
        c = point("currentStartPointId"),
        e = point("currentEndPointId");
      matches &&= !!(
        a &&
        b &&
        c &&
        e &&
        own &&
        a.index < b.index &&
        b.index <= c.index &&
        c.index < e.index &&
        e.index === own.index
      );
      if (criterion === "trend-divergence") {
        const table = family?.native?.recursiveMovements;
        const association = table?.associations.find(
          (a) => a.structureId === meta?.trendId && a.status === "verified",
        );
        const movement = table?.movements.find(
          (m) => m.id === association?.movementId,
        );
        if (
          !movement ||
          movement.completed === null ||
          movement.centerIds.length < 2 ||
          association?.level !== movement.level
        )
          gaps.push(
            "缺少C4逐成员关联的已完成同级别多中枢走势，不能由trendId/方向推测",
          );
        else {
          const last = table!.centers.find(
            (c) => c.id === movement.centerIds.at(-1),
          );
          matches &&=
            movement.type === -Math.sign(signal.kind) &&
            e?.index === movement.end &&
            !!last &&
            center?.start === last.centerStart &&
            center.end === last.centerEnd &&
            !!c &&
            c.index >= last.centerEnd &&
            !!a &&
            a.index >= movement.start &&
            !!d &&
            (d.flags & 1) !== 0 &&
            d.areaRatio > 0 &&
            d.areaRatio < 100;
        }
      }
    }
  }
  return {
    criterion,
    status: gaps.length
      ? ("missing" as const)
      : matches
        ? ("matched" as const)
        : ("not-matched" as const),
    gaps,
    signal,
    center: center ?? null,
    observedAt: bars.at(-1)?.date ?? null,
    boundary: "仅证明当前DLL前缀判据，不表示原文全覆盖；小转大永远只是必要条件",
  };
}
