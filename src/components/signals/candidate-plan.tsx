"use client";
import { useEffect, useMemo, useState } from "react";
import { api } from "~/trpc/react";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { formatNumber } from "trading-strategy-core/format-number";
import { Checkbox } from "../ui/checkbox";
import { Switch } from "../ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import type { WorkspaceCandidate } from "../overview/candidate-table";
import { useScreenVisible } from "../workbench/use-task-visible";
import { SimOrderForm, type SimMarket } from "../portfolio/sim-order-form";

export type PlanSavedConfirmation = {
  id: string;
  symbol: string;
  message: string;
};

/** A saved plan that can be replayed into a local simulated account. */
export type SimExecutablePlan = {
  id: string;
  symbol: string;
  entry: number;
  quantity: number | null;
};

export function CandidatePlan({
  candidate,
  inline = false,
  plan: existingPlan,
  onSaved,
  onPendingChange,
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
  /** An already-saved/active plan gains the local simulated execution section. */
  plan?: SimExecutablePlan;
  onSaved?: (confirmation: PlanSavedConfirmation) => void;
  /** Lets a parent dialog hold its close affordances while the plan is saving. */
  onPendingChange?: (pending: boolean) => void;
  onClose?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [overrideCaps, setOverrideCaps] = useState(false);
  const [overrideSizing, setOverrideSizing] = useState(false);
  const [savedPlan, setSavedPlan] = useState<SimExecutablePlan | null>(null);
  const [execOpen, setExecOpen] = useState(false);
  const [execMessage, setExecMessage] = useState("");
  const [boundAccountId, setBoundAccountId] = useState("");
  const [autoExecute, setAutoExecute] = useState(false);
  const [bindingMessage, setBindingMessage] = useState("");
  const executable = existingPlan ?? savedPlan;
  const planId = executable?.id ?? "";
  const tranches = candidate.tranches ?? 1;
  const visible = useScreenVisible();
  const market: SimMarket =
    candidate.market === "crypto" ? "crypto" : "cn-equity";
  const expectedCurrency = market === "crypto" ? "USDT" : "CNY";
  const correlation = api.planCorrelation.useQuery(candidate.key, {
    enabled: visible && (open || inline),
    retry: false,
  });
  const bindingQuery = api.simPlanBindingGet.useQuery(planId, {
    enabled: Boolean(planId),
  });
  const accountsQuery = api.simAccountsList.useQuery(undefined, {
    enabled: Boolean(planId),
    staleTime: 15000,
  });
  const compatibleAccounts = useMemo(
    () =>
      (accountsQuery.data ?? []).filter(
        (account) =>
          account.status === "active" &&
          account.market === market &&
          account.currency === expectedCurrency,
      ),
    [accountsQuery.data, market, expectedCurrency],
  );
  useEffect(() => {
    if (!bindingQuery.isSuccess) return;
    setBoundAccountId(bindingQuery.data?.accountId ?? "");
    setAutoExecute(bindingQuery.data?.autoExecute ?? false);
  }, [
    bindingQuery.isSuccess,
    bindingQuery.data?.accountId,
    bindingQuery.data?.autoExecute,
    planId,
  ]);
  const utils = api.useUtils();
  const bindingSave = api.simPlanBindingSave.useMutation({
    onSuccess: (saved) => {
      setBoundAccountId(saved.accountId);
      setAutoExecute(saved.autoExecute);
      setBindingMessage(
        saved.autoExecute
          ? "已保存本地模拟账户绑定与自动模拟成交偏好（仅本地模拟账户，绝不触发真实下单；当前仍可随时点击「按计划手动模拟成交」立即执行）"
          : "已保存本地模拟账户绑定（仅本地模拟账户，绝不触发真实下单）",
      );
      void utils.simPlanBindingGet.invalidate(planId);
    },
    onError: (e) => {
      setBindingMessage(e.message);
    },
  });
  const save = api.createAlertPlan.useMutation({
    onSuccess: (p) => {
      const confirmation: PlanSavedConfirmation = {
        id: p.id,
        symbol: p.symbol,
        message: `已保存交易计划 · ${p.symbol} · 数量 ${formatNumber(p.quantity, p.market === "crypto" ? 6 : 0)}${p.sizingAudit?.overridden || (p.protection?.version === "plan-protection-1" && !p.protection.matchesStrategy) ? " · 已记录偏离策略参数" : ""}${p.positionSnapshot ? ` · ${p.positionSnapshot.basis === "post-close" ? "收盘快照" : "盘中核对"} ${new Date(p.positionSnapshot.at).toLocaleString("zh-CN")}${p.positionSnapshot.unassignedValue > 0 ? ` · 未分配分仓 ${formatNumber(p.positionSnapshot.unassignedValue)} 已计入市场占用，请分配` : ""}` : ""}`,
      };
      setMessage(confirmation.message);
      setSavedPlan({
        id: p.id,
        symbol: p.symbol,
        entry: p.entry,
        quantity: p.quantity,
      });
      setOpen(false);
      void utils.alertPlans.invalidate();
      void utils.workspaceCandidates.invalidate();
      void utils.todayWorkspace.invalidate();
      onPendingChange?.(false);
      onSaved?.(confirmation);
    },
    onError: (e) => {
      setMessage(e.message);
      onPendingChange?.(false);
    },
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
            onPendingChange?.(true);
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
            disabled={save.isPending}
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
      {executable && (
        <section
          aria-label="执行到本地模拟账户"
          className="space-y-3 rounded border border-nc-border-soft p-3"
        >
          <div className="space-y-1.5">
            <h4 className="text-sm font-semibold">按计划手动模拟成交</h4>
            <p className="text-xs text-nc-text-3">
              计划 {executable.symbol} · 入场参考{" "}
              {formatNumber(executable.entry)} · 数量{" "}
              {executable.quantity === null
                ? "待定"
                : formatNumber(
                    executable.quantity,
                    candidate.market === "crypto" ? 6 : 0,
                  )}
            </p>
            <Button
              type="button"
              size="sm"
              disabled={executable.quantity === null}
              onClick={() => setExecOpen(true)}
            >
              按计划手动模拟成交
            </Button>
            {execMessage && (
              <p role="status" className="text-sm">
                {execMessage}
              </p>
            )}
          </div>

          <div className="space-y-2 border-t border-nc-border-soft pt-3">
            <h4 className="text-sm font-semibold">
              绑定本地模拟账户（支持自动模拟成交）
            </h4>
            <label className="block text-sm">
              选择模拟账户
              <Select
                value={boundAccountId || undefined}
                onValueChange={(value) => {
                  setBoundAccountId(value);
                  setBindingMessage("");
                }}
              >
                <SelectTrigger
                  aria-label="绑定模拟账户"
                  className="mt-1 w-full"
                >
                  <SelectValue placeholder="请选择兼容的本地模拟账户" />
                </SelectTrigger>
                <SelectContent>
                  {compatibleAccounts.map((account) => (
                    <SelectItem key={account.id} value={account.id}>
                      {account.name} · {account.currency}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            {accountsQuery.isSuccess && compatibleAccounts.length === 0 && (
              <p role="alert" className="text-xs text-nc-warn">
                尚无与该标的兼容的活跃模拟账户，请先在「持仓复盘 ·
                本地模拟盘」新建。
              </p>
            )}
            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={autoExecute}
                onCheckedChange={(checked) => {
                  setAutoExecute(checked);
                  setBindingMessage("");
                }}
              />
              自动模拟成交（仅本地模拟账户，绝不触发真实下单）
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!boundAccountId || bindingSave.isPending}
                onClick={() =>
                  bindingSave.mutate({
                    accountId: boundAccountId,
                    planId: executable.id,
                    autoExecute,
                  })
                }
              >
                {bindingSave.isPending ? "正在保存…" : "保存模拟绑定"}
              </Button>
              {bindingQuery.data && (
                <span className="text-xs text-nc-text-3">
                  当前已绑定：
                  {compatibleAccounts.find(
                    (account) => account.id === bindingQuery.data?.accountId,
                  )?.name ?? bindingQuery.data.accountId}{" "}
                  ·{" "}
                  {bindingQuery.data.autoExecute
                    ? "自动模拟成交已开启"
                    : "仅手动模拟"}
                </span>
              )}
            </div>
            {bindingQuery.error && (
              <p role="alert" className="text-xs text-nc-bad">
                模拟绑定读取失败：{bindingQuery.error.message}
              </p>
            )}
            {bindingMessage && (
              <p
                role={bindingSave.isError ? "alert" : "status"}
                className="text-xs"
              >
                {bindingMessage}
              </p>
            )}
          </div>

          <Dialog open={execOpen} onOpenChange={setExecOpen}>
            <DialogContent className="lg:max-w-xl">
              <DialogTitle>
                按计划手动模拟成交 · {executable.symbol}
              </DialogTitle>
              <DialogDescription>
                按计划入场价与数量预填；选择兼容的模拟账户后先试算再确认。
              </DialogDescription>
              <SimOrderForm
                key={`${executable.id}:plan-manual:${boundAccountId}`}
                defaults={{
                  accountId: boundAccountId || undefined,
                  symbol: executable.symbol,
                  side: "buy",
                  price: String(executable.entry),
                  quantity:
                    executable.quantity === null
                      ? ""
                      : String(executable.quantity),
                  executionMode: "plan-manual",
                  planId: executable.id,
                }}
                marketHint={candidate.market}
                onDone={(trade) => {
                  setExecOpen(false);
                  setExecMessage(
                    `已按计划记录${trade.side === "buy" ? "买入" : "卖出"} ${trade.symbol} × ${trade.quantity} 到本地模拟账户`,
                  );
                }}
              />
            </DialogContent>
          </Dialog>
        </section>
      )}
    </div>
  );
}
