import { createHash } from "node:crypto";
import type { Bar, Snapshot } from "~/lib/domain";

/** 在线尾段必须与本地尾部重合的最少根数：单根重合可能只是巧合，不足以证明两边口径一致。 */
const deltaOverlapMinimum = 2;
/** 本地 lday 把成交额存成 float32，同一笔金额回读的相对误差约 1e-7；供应商侧也各自取整。 */
const deltaAmountTolerance = 1e-5;
/** 只比较价量字段，日期与来源已由调用方固定。 */
const exactFields = ["open", "high", "low", "close"] as const;
/** 供应商可能按手/份等整数倍报量，本地按原值存：倍率由重叠日反推，允许供应商四舍五入。 */
const volumeScales = [1, 10, 100, 1000] as const;

/**
 * 盘中只补本地尾部之后的日线周期。
 *
 * 这段拼接只服务图表显示：它要求重叠日价格逐字段相等、成交额在本地 float32 精度内、
 * 成交量能由唯一的整数倍解释（实测东方财富按手取整、本地 lday 存股，倍率 100 且允许
 * 半手误差），任一条不成立就抛错，由调用方退回整段在线取数。绝不写入本地文件、增量缓存
 * 或任何历史。
 */
export function mergeOnlineDailyTail(
  source: Snapshot,
  tail: Bar[],
  note: { source: string; requests: number },
): { snapshot: Snapshot; added: number } {
  if (source.period !== "day" || source.adjustment !== "none")
    throw new Error("在线当日增量只用于不复权日线");
  const last = source.bars.at(-1);
  if (!last) throw new Error("本地日线为空，不能叠加在线增量");
  if (!tail.length) throw new Error("在线未返回日线");
  for (let index = 1; index < tail.length; index++)
    if (tail[index]!.date <= tail[index - 1]!.date)
      throw new Error("在线日线倒序或重复，拒绝拼接");
  const localByDate = new Map(source.bars.map((bar) => [bar.date, bar]));
  const overlap = tail.filter((bar) => localByDate.has(bar.date));
  if (overlap.length < deltaOverlapMinimum)
    throw new Error(
      `在线日线与本地重叠不足 ${deltaOverlapMinimum} 根，无法确认两侧连续`,
    );
  const pairs = overlap.map((bar) => ({
    local: localByDate.get(bar.date)!,
    remote: bar,
  }));
  for (const { local, remote } of pairs) {
    for (const field of exactFields)
      if (local[field] !== remote[field])
        throw new Error(
          `在线日线与本地重叠日价格不一致（${remote.date} ${field}）`,
        );
    if (
      Math.abs(local.amount - remote.amount) >
      Math.max(Math.abs(local.amount), 1) * deltaAmountTolerance
    )
      throw new Error(`在线日线与本地重叠日成交额不一致（${remote.date}）`);
  }
  // 供应商按手（或其它整数倍）四舍五入报量，本地存原值：倍率必须让所有重叠日都落在
  // 供应商取整范围内，反推不出唯一整数倍就不拼接。
  const scale = volumeScales.find((candidate) =>
    pairs.every(
      ({ local, remote }) =>
        Math.abs(local.volume - remote.volume * candidate) <=
        Math.max(candidate / 2, 1),
    ),
  );
  if (!scale)
    throw new Error(
      `在线日线与本地重叠日成交量口径不一致（${pairs[0]!.remote.date} 等 ${pairs.length} 根）`,
    );
  const added = tail.filter((bar) => bar.date > last.date);
  if (!added.length) return { snapshot: source, added: 0 };
  const scaled = added.map((bar) => ({ ...bar, volume: bar.volume * scale }));
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        version: "chart-online-delta-1",
        base: source.hash,
        source: note.source,
        added: scaled,
      }),
    )
    .digest("hex");
  const detail = `本地日线叠加在线当日增量 ${added.length} 根（${note.source}，${note.requests} 次请求）；重叠 ${overlap.length} 根价格一致、成交量倍率 ${scale}`;
  return {
    snapshot: {
      ...source,
      id: `snapshot-${source.symbol}-day-${hash.slice(0, 20)}`,
      hash,
      bars: [...source.bars, ...scaled],
      sourceNote: source.sourceNote
        ? `${source.sourceNote}；${detail}`
        : detail,
    },
    added: added.length,
  };
}
