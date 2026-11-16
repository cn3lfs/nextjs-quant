"use client";
import { useState } from "react";
import { api } from "~/trpc/react";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { formatNumber } from "trading-strategy-core/format-number";
import { Checkbox } from "../ui/checkbox";
import type { WorkspaceCandidate } from "../overview/candidate-table";
import { useScreenVisible } from "../workbench/use-task-visible";

export function CandidatePlan({
  candidate,
  inline = false,
  onSaved,
  onClose,
}: {
  candidate: Pick<
    WorkspaceCandidate,
    "key" | "market" | "symbol" | "price" | "stop" | "target"
  > & {
    positionSnapshot?: WorkspaceCandidate["positionSnapshot"];
    tranches?: number;
    exitSpec?: WorkspaceCandidate["exitSpec"];
    sizingPolicy?: WorkspaceCandidate["sizingPolicy"];
    policyReason?: string | null;
  };
  inline?: boolean;
  onSaved?: () => void;
  onClose?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [overrideCaps, setOverrideCaps] = useState(false);
  const [overrideSizing, setOverrideSizing] = useState(false);
  const tranches = candidate.tranches ?? 1;
  const visible = useScreenVisible();
  const correlation = api.planCorrelation.useQuery(candidate.key, {
    enabled: visible && (open || inline),
    retry: false,
  });
  const utils = api.useUtils();
  const save = api.createAlertPlan.useMutation({
    onSuccess: (p) => {
      setMessage(
        `已保存交易计划 · 数量 ${formatNumber(p.quantity, p.market === "crypto" ? 6 : 0)}${p.sizingAudit?.overridden || (p.protection?.version === "plan-protection-1" && !p.protection.matchesStrategy) ? " · 已记录偏离策略参数" : ""}${p.positionSnapshot ? ` · ${p.positionSnapshot.basis === "post-close" ? "收盘快照" : "盘中核对"} ${new Date(p.positionSnapshot.at).toLocaleString("zh-CN")}${p.positionSnapshot.unassignedValue > 0 ? ` · 未分配分仓 ${formatNumber(p.positionSnapshot.unassignedValue)} 已计入市场占用，请分配` : ""}` : ""}`,
      );
      setOpen(false);
      void utils.alertPlans.invalidate();
      void utils.workspaceCandidates.invalidate();
      void utils.todayWorkspace.invalidate();
      onSaved?.();
    },
    onError: (e) => setMessage(e.message),
  });
  return (
    <div className="space-y-2 rounded border bg-nc-card p-3">
      {!inline && <Button onClick={() => setOpen(true)}>加入计划</Button>}
      {(open || inline) && (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const expiry = String(f.get("expiry"));
            if (!expiry || !Number.isFinite(Date.parse(expiry))) {
              setMessage("请填写有效到期时间");
              return;
            }
            save.mutate({
              eventKey: candidate.key,
              rationale: String(f.get("rationale") ?? ""),
              tags: [
                ...new Set(
                  String(f.get("tags") ?? "")
                    .split(/[,，]/)
                    .map((v) => v.trim())
                    .filter(Boolean),
                ),
              ],
              overrideCaps,
              stages: Array.from({ length: tranches }, (_, i) =>
                Number(f.get(`entry-${i}`)),
              ),
              stop: Number(f.get("stop")),
              target: f.get("target") ? Number(f.get("target")) : null,
              expiresAt: new Date(expiry).toISOString(),
              ...(overrideSizing
                ? {
                    overrideSizing: {
                      confirmed: true as const,
                      reason: String(f.get("sizing-reason")),
                    },
                  }
                : {}),
              ...(candidate.market === "crypto"
                ? {
                    quantityRules: {
                      step: Number(f.get("step")),
                      minimum: Number(f.get("minimum")),
                      source: String(f.get("source")),
                    },
                  }
                : {}),
            });
          }}
        >
          <p>
            {candidate.symbol} ·
            数量复用所选策略与纸面账户的仓位规则，含撮合费用；
            {tranches} 档入场。实际成交价格由用户核对。
          </p>
          {candidate.sizingPolicy && (
            <p className="text-xs text-nc-text-3">
              仓位来源：{candidate.sizingPolicy.source} · 单笔风险{" "}
              {formatNumber(candidate.sizingPolicy.riskPerTrade * 100, 2)}% ·
              最多 {candidate.sizingPolicy.maxPositions} 只 · 当前权重上限{" "}
              {formatNumber(candidate.sizingPolicy.weightCeiling * 100, 2)}% ·
              费用假设 佣金 {candidate.sizingPolicy.costs.commissionBps} bp /
              最低 {candidate.sizingPolicy.costs.minimumCommission}，卖税{" "}
              {candidate.sizingPolicy.costs.sellTaxBps} bp，研究滑点{" "}
              {candidate.sizingPolicy.costs.slippageBps} bp。
              {candidate.sizingPolicy.validated
                ? "已有研究资格，仍须核对前推"
                : "研究/用户口径，未获完整业绩资格"}
            </p>
          )}
          {candidate.policyReason && (
            <p role="alert">仓位来源尚不可用：{candidate.policyReason}</p>
          )}
          {candidate.sizingPolicy?.bookSizing && (
            <p className="text-sm text-nc-text-3">
              组合决策 {candidate.sizingPolicy.bookSizing.date}：目标权重{" "}
              {formatNumber(
                candidate.sizingPolicy.bookSizing.targetWeight * 100,
                2,
              )}
              % · 研究持仓权重{" "}
              {formatNumber(
                candidate.sizingPolicy.bookSizing.currentWeight * 100,
                2,
              )}
              % · 增仓差{" "}
              {formatNumber(
                candidate.sizingPolicy.bookSizing.deltaWeight * 100,
                2,
              )}
              %。 数量按目标总仓减已核验实际持仓计算。
            </p>
          )}
          <label className="block">
            入场理由（可选）
            <Input name="rationale" aria-label="入场理由" maxLength={1000} />
          </label>
          <label className="block">
            计划标签（逗号分隔）
            <Input name="tags" aria-label="计划标签" />
          </label>
          {candidate.positionSnapshot && (
            <p className="text-xs text-nc-text-3">
              {candidate.positionSnapshot.basis === "post-close"
                ? "收盘快照"
                : "盘中核对"}
              ：
              {new Date(candidate.positionSnapshot.at).toLocaleString("zh-CN")}
              {candidate.positionSnapshot.unassignedValue > 0
                ? ` · 未分配分仓 ${formatNumber(candidate.positionSnapshot.unassignedValue)} 已计入市场占用，请分配`
                : ""}
            </p>
          )}
          {correlation.error && (
            <p role="alert">相关性提示读取失败：{correlation.error.message}</p>
          )}
          {correlation.data && (
            <div className="text-xs text-nc-text-3">
              <p>{correlation.data.reason}</p>
              {correlation.data.pairs
                .filter((p) => p.warning)
                .map((p) => (
                  <p key={p.symbol}>
                    {p.symbol} · 相关系数 {formatNumber(p.correlation, 2)} /{" "}
                    {p.overlapDays} 日 · {p.warning}
                  </p>
                ))}
            </div>
          )}
          <div className="grid gap-2 lg:grid-cols-2">
            {[
              ...Array.from({ length: tranches }, (_, i) => ({
                name: `entry-${i}`,
                label: tranches > 1 ? `第${i + 1}档入场参考` : "入场参考",
                value: candidate.price,
              })),
              { name: "stop", label: "计划止损", value: candidate.stop },
              { name: "target", label: "计划目标", value: candidate.target },
            ].map((f) => (
              <label key={f.name}>
                {f.label}
                <Input
                  name={f.name}
                  aria-label={f.label}
                  type="number"
                  step="any"
                  min="0"
                  required={f.name !== "target"}
                  defaultValue={f.value ?? ""}
                />
              </label>
            ))}
            <label>
              计划到期时间
              <Input
                name="expiry"
                aria-label="计划到期时间"
                type="datetime-local"
                required
                defaultValue={new Date(
                  Date.now() +
                    86400000 -
                    new Date().getTimezoneOffset() * 60000,
                )
                  .toISOString()
                  .slice(0, 16)}
              />
            </label>
          </div>
          {candidate.exitSpec && (
            <p className="text-xs text-nc-text-3">
              策略保护：
              {candidate.exitSpec.stop
                ? `初始止损 ${candidate.exitSpec.stop.kind}`
                : "未声明初始止损"}
              {candidate.exitSpec.trailing
                ? ` · 收盘后更新移动止损 ${formatNumber(candidate.exitSpec.trailing * 100, 2)}%`
                : ""}
              {candidate.exitSpec.maxBars
                ? ` · 最长 ${candidate.exitSpec.maxBars} 根完成bar`
                : ""}
              。成交关联后继承完整退出规则。
            </p>
          )}
          <label className="flex items-center gap-2">
            <Checkbox
              checked={overrideSizing}
              onCheckedChange={(v) => setOverrideSizing(v === true)}
            />
            明确调整策略入场或保护参数，记录为偏离验证模型
          </label>
          {overrideSizing && (
            <label>
              调整原因
              <Input
                name="sizing-reason"
                aria-label="调整原因"
                required
                minLength={1}
                maxLength={500}
              />
            </label>
          )}
          {candidate.market === "crypto" && (
            <div className="grid gap-2 lg:grid-cols-2">
              <p role="alert" className="lg:col-span-2">
                缺少平台数量网格时不能保存；请填写经平台核验的步长、最小数量及来源。
              </p>
              {[
                { name: "step", label: "平台数量步长" },
                { name: "minimum", label: "平台最小数量" },
                { name: "source", label: "数量规则来源" },
              ].map((f) => (
                <label key={f.name}>
                  {f.label}
                  <Input
                    name={f.name}
                    aria-label={f.label}
                    required
                    type={f.name === "source" ? "text" : "number"}
                    step="any"
                    min="0"
                  />
                </label>
              ))}
            </div>
          )}
          {save.error?.message.startsWith("敞口超限") && (
            <label className="flex items-center gap-2">
              <Checkbox
                checked={overrideCaps}
                onCheckedChange={(v) => setOverrideCaps(v === true)}
              />
              已核对超限明细，仍然创建并记录这次超限
            </label>
          )}
          <Button disabled={save.isPending}>保存交易计划</Button>{" "}
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setOpen(false);
              onClose?.();
            }}
          >
            关闭
          </Button>
        </form>
      )}
      {message && <p role={save.error ? "alert" : "status"}>{message}</p>}
    </div>
  );
}
