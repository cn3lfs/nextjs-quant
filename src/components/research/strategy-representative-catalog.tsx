import {
  listStrategyRepresentatives,
  type StrategyRepresentative,
} from "trading-strategies";
import {
  researchStrategySchema,
  type ResearchStrategyId,
} from "~/lib/research/specs/research-strategies";
import { Button } from "../ui/button";

const coverage = {
  available: "数据可用",
  partial: "数据覆盖不完整",
  missing: "缺少所需数据",
  unknown: "数据覆盖待核验",
};
export function representativePreset(
  item: Pick<StrategyRepresentative, "presetId">,
): ResearchStrategyId | undefined {
  const parsed = researchStrategySchema.safeParse(item.presetId);
  return parsed.success ? parsed.data : undefined;
}
export function StrategyRepresentativeCatalog({
  onSelect,
}: {
  onSelect: (preset: ResearchStrategyId) => void;
}) {
  return (
    <details className="rounded-lg border p-4">
      <summary className="cursor-pointer font-medium">九方向代表策略</summary>
      <p className="my-3 text-sm text-muted-foreground">
        按研究方法选取代表，不按收益排名。以下为历史证据登记，固定输入测试和观察结果不代表已验证的策略业绩。
      </p>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {listStrategyRepresentatives().map((item) => {
          const preset = representativePreset(item);
          return (
            <article
              key={item.id}
              data-strategy-representative={item.id}
              className="space-y-2 rounded-md border p-3"
            >
              <h3 className="font-medium">{item.name}</h3>
              <p className="text-sm">{item.description}</p>
              <p className="text-sm text-muted-foreground">
                方法：{item.methodId}
                {item.presetId
                  ? ` · 预设：${item.presetId}`
                  : " · 尚无独立预设"}
              </p>
              <p className="text-sm">
                {item.readiness === "implemented-no-backtest"
                  ? "未真实回测"
                  : `${item.evidence.batch} ${item.readiness === "observed-incomplete-batch" ? "批次未完整" : "已归档"} · ${item.evidence.label}`}{" "}
                · {coverage[item.dataCoverage]}
              </p>
              {item.evidence?.evidenceLevel === "raw-only" && (
                <p className="text-sm text-muted-foreground">
                  仅保留原始观察记录
                </p>
              )}
              <ul className="list-disc space-y-1 pl-4 text-sm text-muted-foreground">
                {item.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
              {preset ? (
                <Button
                  aria-label={`选择${item.name}研究预设`}
                  type="button"
                  variant="outline"
                  onClick={() => onSelect(preset)}
                >
                  选择研究预设
                </Button>
              ) : (
                <p className="text-sm text-muted-foreground">
                  仅供方法参考，暂不可从此目录选择预设。
                </p>
              )}
            </article>
          );
        })}
      </div>
    </details>
  );
}
