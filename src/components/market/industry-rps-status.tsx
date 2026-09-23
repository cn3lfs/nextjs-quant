import {
  industryExclusions,
  industryRpsPolicy,
  type IndustryRpsAudit,
} from "~/lib/screening/industry-rps";
import { rpsExclusionLabels, rpsPeriods, rpsPolicy } from "~/lib/screening/rps";

export const industryExclusionLabels = {
  ...rpsExclusionLabels,
  unavailable: "本地证券/日线缺失",
};
export function IndustryRpsStatus({
  latest,
}: {
  latest: {
    date: string;
    mode: "backfill" | "forward";
    counts: number[];
    total: number;
    excluded: IndustryRpsAudit["excluded"];
  } | null;
}) {
  return (
    <div className="space-y-3">
      <details className="rounded-lg border border-border bg-card p-4 text-sm">
        <summary className="cursor-pointer font-medium">
          行业口径与保留策略
        </summary>
        <div className="mt-2 space-y-2 text-muted-foreground">
          <p>{industryRpsPolicy.description}</p>
          <p>{industryRpsPolicy.warning}</p>
          <p>{industryRpsPolicy.periodsNote}</p>
          <p>{rpsPolicy.description}</p>
          <p>
            按所选分类来源计算，与个股共用单任务队列。每日批次遵循工作流设置。保留最近750个结果日；自动删除更早结果及成分快照。取消保留已提交日期，重试只补缺失日期。
          </p>
        </div>
      </details>
      {latest ? (
        <div className="space-y-3 rounded-lg border border-border bg-card p-4">
          <p className="font-medium">
            最近行业结果：{latest.date} ·{" "}
            {latest.mode === "backfill"
              ? "回填（成分漂移 / 生存者偏差）"
              : "向前新增（当次成分快照）"}
            ；行业数 {latest.total}
          </p>
          <p className="text-xs text-muted-foreground">
            各原因剔除数按行业成分出现次数统计，同一股票跨行业分别计数。
          </p>
          <div className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
            {industryExclusions.map((key) => (
              <p key={key} className="flex justify-between gap-2">
                <span className="text-muted-foreground">
                  {industryExclusionLabels[key]}
                </span>
                <span>{latest.excluded[key]}</span>
              </p>
            ))}
          </div>
          <p className="text-sm text-muted-foreground">
            {rpsPeriods
              .map((p, i) => `RPS${p} 排名基数 ${latest.counts[i]}`)
              .join("；")}
          </p>
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
          尚无行业排名，请配置目录后计算或回填。
        </p>
      )}
    </div>
  );
}
