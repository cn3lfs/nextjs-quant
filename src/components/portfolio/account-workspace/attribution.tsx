"use client";
import { api, type RouterOutputs } from "~/trpc/react";
import { formatNumber } from "trading-strategy-core/format-number";
import { pct } from "./shared";

export function AttributionRows({
  rows,
}: {
  rows: RouterOutputs["accountAttribution"];
}) {
  return (
    <div className="space-y-3">
      {rows.map((r) => (
        <article
          key={`${r.strategyId}:${r.version}`}
          className="space-y-2 rounded border p-3"
        >
          <h4>
            {r.strategyId} v{r.version} · {r.market}/{r.sleeve}
          </h4>
          <p className={r.flagged ? "text-nc-bad" : "text-nc-text-2"}>
            {r.flagged ? "衰减已标记" : "未标记衰减"}
          </p>
          <p>
            回测期望：{r.expected?.samples.length ?? 0} 个同参数样本；
            {r.expected?.source ??
              r.expectationReason ??
              "缺少同期限冻结分布，不用不等长历史窗口冒充"}
          </p>
          {(["alerts", "paper", "actual", "simulation"] as const).map(
            (key, i) => (
              <p key={key}>
                {["提醒前推", "纸面前推", "用户实际", "模拟场所"][i]}：
                {r[key].observedSamples} 样本 · 中位 {pct(r[key].median)} ·
                期望P{formatNumber(r[key].percentile * 100, 0)}{" "}
                {pct(r[key].threshold)} ·{" "}
                {r[key].flagged
                  ? "衰减"
                  : r[key].enough
                    ? "未偏离"
                    : r[key].reason}
              </p>
            ),
          )}
          <p className="text-xs text-nc-text-3">{r.basis}</p>
        </article>
      ))}
    </div>
  );
}

export function AccountAttribution() {
  const query = api.accountAttribution.useQuery();
  return (
    <section className="space-y-4">
      <h2>策略 / 分仓三方对比</h2>
      <p>
        同版本同定义的二十市场日入场期望在登记、影子或晋级时自动冻结。缺真实成交/原价及完整来源哈希时保持不可用，不用窗口汇总补造；与前推符合度的交易收益分布分开。
      </p>
      {query.error && <p role="alert">{query.error.message}</p>}
      <AttributionRows rows={query.data ?? []} />
    </section>
  );
}
