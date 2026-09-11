import {
  rpsExclusions,
  rpsExclusionLabels,
  rpsPeriods,
  rpsPolicy,
  type RpsDay,
  type RpsProgress,
} from "~/lib/rps";

export function RpsStatus({
  latest,
  progress,
}: {
  latest: RpsDay | null;
  progress: RpsProgress | null;
}) {
  return (
    <div className="space-y-4">
      <p>{rpsPolicy.description}</p>
      <p>
        周期：{rpsPeriods.join(" / ")}
        ；每日工作流按午盘、尾盘、收盘更新；收盘等待下载完成。手工历史计算保留最近
        {rpsPolicy.retentionDays}
        个结果日；更早数据自动删除。取消保留已完整提交日期，重试跳过已有结果。
      </p>
      <p className="text-muted-foreground">
        {rpsPolicy.backfillWarning}{" "}
        当日向前数据单独标记；补做过去日期一律回填，已有日期不覆盖。
      </p>
      {progress ? (
        <div role="status">
          <p>
            {progress.target === "industry"
              ? "行业"
              : progress.target === "concept"
                ? "概念"
                : "个股"}
            任务：
            {progress.mode === "backfill" ? "回填" : "向前"} / {progress.status}{" "}
            / {progress.phase}
          </p>
          <p>
            读取 {progress.scanned}/{progress.total}；提交{" "}
            {progress.completedDays}/{progress.totalDays} 日
          </p>
          {progress.error && <p role="alert">{progress.error}</p>}
        </div>
      ) : (
        <p>尚未运行RPS任务。</p>
      )}
      {latest ? (
        <>
          <p>
            最近结果：{latest.date} ·{" "}
            {latest.mode === "backfill" ? "回填（生存者偏差）" : "向前新增"}
            ；本地证券 {latest.total}，基础池 {latest.pool}
          </p>
          <ul>
            {rpsExclusions.map((key) => (
              <li key={key}>
                {rpsExclusionLabels[key]}：{latest.excluded[key].length}
              </li>
            ))}
          </ul>
          <ul>
            {latest.periods.map((period, i) => (
              <li key={period}>
                RPS{period} 排名基数 {latest.counts[i]}；池内端点不足{" "}
                {latest.missing[i]}
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground">
            {latest.source.calendar}；GBBQ覆盖至 {latest.source.actionsCoverage}
            。停牌依据本地无成交记录，不能区分停牌、退市与缺行情。
          </p>
        </>
      ) : (
        <p>尚无已完成的排名；可先执行回填。</p>
      )}
    </div>
  );
}
