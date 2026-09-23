import {
  rpsExclusions,
  rpsExclusionLabels,
  rpsPeriods,
  rpsPolicy,
  type RpsDay,
} from "~/lib/screening/rps";

/**
 * Latest 个股 result and the口径 behind it. The running job is reported by the
 * page-level 运行状态 box, so nothing here depends on live progress.
 */
export function RpsStatus({ latest }: { latest: RpsDay | null }) {
  return (
    <div className="space-y-4">
      <details className="rounded-lg border border-border bg-card p-4 text-sm">
        <summary className="cursor-pointer font-medium">
          计算口径与保留策略
        </summary>
        <div className="mt-2 space-y-2 text-muted-foreground">
          <p>{rpsPolicy.description}</p>
          <p>
            周期：{rpsPeriods.join(" / ")}
            ；每日工作流按午盘、尾盘、收盘更新；收盘等待下载完成。手工历史计算保留最近
            {rpsPolicy.retentionDays}
            个结果日；更早数据自动删除。取消保留已完整提交日期，重试跳过已有结果。
          </p>
          <p>
            {rpsPolicy.backfillWarning}{" "}
            当日向前数据单独标记；补做过去日期一律回填，已有日期不覆盖。
          </p>
        </div>
      </details>
      {latest ? (
        <div className="space-y-3 rounded-lg border border-border bg-card p-4">
          <p className="font-medium">
            最近结果：{latest.date} ·{" "}
            {latest.mode === "backfill" ? "回填（生存者偏差）" : "向前新增"}
            ；本地证券 {latest.total}，基础池 {latest.pool}
          </p>
          <div className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
            {rpsExclusions.map((key) => (
              <p key={key} className="flex justify-between gap-2">
                <span className="text-muted-foreground">
                  {rpsExclusionLabels[key]}
                </span>
                <span>{latest.excluded[key].length}</span>
              </p>
            ))}
          </div>
          <div className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
            {latest.periods.map((period, i) => (
              <p key={period} className="flex justify-between gap-2">
                <span className="text-muted-foreground">RPS{period}</span>
                <span>
                  基数 {latest.counts[i]} · 端点不足 {latest.missing[i]}
                </span>
              </p>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {latest.source.calendar}；GBBQ覆盖至 {latest.source.actionsCoverage}
            。停牌依据本地无成交记录，不能区分停牌、退市与缺行情。
          </p>
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
          尚无已完成的排名；可先执行回填。
        </p>
      )}
    </div>
  );
}
