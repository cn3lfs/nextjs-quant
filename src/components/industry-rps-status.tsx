import {
  industryExclusions,
  industryRpsPolicy,
  type IndustryRpsAudit,
} from "~/lib/industry-rps";
import {
  rpsExclusionLabels,
  rpsPeriods,
  rpsPolicy,
  type RpsProgress,
} from "~/lib/rps";

export const industryExclusionLabels = {
  ...rpsExclusionLabels,
  unavailable: "本地证券/日线缺失",
};
export function IndustryRpsStatus({
  latest,
  progress,
}: {
  latest: {
    date: string;
    mode: "backfill" | "forward";
    counts: number[];
    total: number;
    excluded: IndustryRpsAudit["excluded"];
  } | null;
  progress: RpsProgress | null;
}) {
  return (
    <div className="space-y-3">
      <p>{industryRpsPolicy.description}</p>
      <p className="text-muted-foreground">{industryRpsPolicy.warning}</p>
      <p>{industryRpsPolicy.periodsNote}</p>
      <p>{rpsPolicy.description}</p>
      <p>
        按所选分类来源计算，与个股共用单任务队列。每日批次遵循工作流设置。保留最近750个结果日；自动删除更早结果及成分快照。取消保留已提交日期，重试只补缺失日期。
      </p>
      {progress && (
        <p role="status">
          {progress.target === "industry"
            ? "行业"
            : progress.target === "concept"
              ? "概念"
              : "个股"}
          任务：
          {progress.mode === "backfill" ? "回填" : "向前新增"} /{" "}
          {progress.status} / {progress.phase}；读取 {progress.scanned}/
          {progress.total}；提交 {progress.completedDays}/{progress.totalDays}{" "}
          日 {progress.error && <span role="alert">{progress.error}</span>}
        </p>
      )}
      {latest ? (
        <>
          <p>
            最近行业结果：{latest.date} ·{" "}
            {latest.mode === "backfill"
              ? "回填（成分漂移 / 生存者偏差）"
              : "向前新增（当次成分快照）"}
            ；行业数 {latest.total}
          </p>
          <p>各原因剔除数按行业成分出现次数统计，同一股票跨行业分别计数。</p>
          <ul>
            {industryExclusions.map((key) => (
              <li key={key}>
                {industryExclusionLabels[key]}：{latest.excluded[key]}
              </li>
            ))}
          </ul>
          <p>
            {rpsPeriods
              .map((p, i) => `RPS${p} 排名基数 ${latest.counts[i]}`)
              .join("；")}
          </p>
        </>
      ) : (
        <p>尚无行业排名，请配置目录后计算或回填。</p>
      )}
    </div>
  );
}
