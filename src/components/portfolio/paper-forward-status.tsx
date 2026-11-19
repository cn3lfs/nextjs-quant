"use client";
import { api } from "~/trpc/react";
import Link from "next/link";
import { MethodologyPopover } from "../panels";
import { useScreenVisible } from "../workbench/use-task-visible";

const forwardMethodology = [
  {
    label: "比较口径",
    detail:
      "只与同一账户、同一策略版本的冻结分布比较日权益、信号率、每笔净收益均值与平均模型滑点；不同账户或不同版本的评估不能互相借用。",
  },
  {
    label: "样本门槛",
    detail:
      "A股需满 60 个市场日且累计 20 次入场；数字货币日线需满 120 个市场日。门槛未满时只给出证据不足。",
  },
  {
    label: "模型滑点",
    detail:
      "滑点按模拟模型扣减，真实执行成本尚未验证，不能据此认为可以实盘复现。",
  },
  {
    label: "提醒",
    detail: "状态变化不会自动开启提醒；晋级与提醒都需要在账户页手动确认。",
  },
] as const;

/** 单行结论：分号前是判断本身，分号后是处置建议，完整文本留在悬浮说明里。 */
function conclusionPhrase(recommendation: string) {
  const [phrase] = recommendation.split("；");
  return phrase || recommendation;
}

export function PaperForwardStatus({ compact = false }: { compact?: boolean }) {
  const visible = useScreenVisible();
  const query = api.paperAccounts.useQuery(undefined, {
    enabled: visible,
    refetchInterval: visible ? 30000 : false,
  });
  return (
    <section
      aria-label="候选纸面前推状态"
      className="mb-4 space-y-2 rounded-lg border bg-nc-card p-4"
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h2 className="font-semibold text-nc-accent">
          {compact ? "前推一致性" : "模拟 · 候选前推"}
        </h2>
        <MethodologyPopover title="纸面前推口径" items={forwardMethodology} />
      </header>
      {query.error && (
        <p role="alert" className="text-xs text-nc-bad">
          {query.error.message}
        </p>
      )}
      {query.data && query.data.length > 0 && (
        <div>
          {query.data.map((a) => {
            const current = a.currentAssessment;
            const detail = [
              current.recommendation,
              current.slippageBasis === "paper-model"
                ? "模型滑点，真实执行未验证"
                : null,
              a.error,
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <div
                key={a.id}
                className="flex items-center justify-between gap-2 border-b border-nc-border-soft py-1.5 text-xs last:border-b-0"
              >
                <span
                  className="min-w-0 flex-1 truncate font-mono text-nc-text-2"
                  title={a.id}
                >
                  {a.id}
                </span>
                <span className="shrink-0 tabular-nums text-nc-text-3">
                  {current.observedSignals ?? "—"} 信号 / {current.days ?? "—"}{" "}
                  日
                </span>
                <span
                  className="flex min-w-0 flex-1 items-center justify-end gap-1.5"
                  title={detail}
                >
                  <span className="truncate text-nc-text-2">
                    {conclusionPhrase(current.recommendation)}
                  </span>
                  {a.error && (
                    <span
                      className="shrink-0 rounded-full border border-nc-warn-edge px-1.5 text-[10px] leading-4 text-nc-warn"
                      title={a.error}
                    >
                      核验待处理
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
      <Link href="/accounts" className="inline-block text-xs underline">
        账户权益、持仓与回测期望对照
      </Link>
    </section>
  );
}
