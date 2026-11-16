"use client";
import { useState } from "react";
import { api } from "~/trpc/react";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { formatNumber } from "trading-strategy-core/format-number";
import { Checkbox } from "../ui/checkbox";
import type { WorkspaceCandidate } from "../overview/candidate-table";

export function CandidatePlan({
  candidate,
}: {
  candidate: Pick<
    WorkspaceCandidate,
    "key" | "market" | "symbol" | "price" | "stop" | "target"
  > & { positionSnapshot?: WorkspaceCandidate["positionSnapshot"] };
}) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [overrideCaps, setOverrideCaps] = useState(false);
  const utils = api.useUtils();
  const save = api.createAlertPlan.useMutation({
    onSuccess: (p) => {
      setMessage(
        `已保存交易计划 · 数量 ${formatNumber(p.quantity, p.market === "crypto" ? 6 : 0)}${p.positionSnapshot ? ` · ${p.positionSnapshot.basis === "post-close" ? "收盘快照" : "盘中核对"} ${new Date(p.positionSnapshot.at).toLocaleString("zh-CN")}${p.positionSnapshot.unassignedValue > 0 ? ` · 未分配分仓 ${formatNumber(p.positionSnapshot.unassignedValue)} 已计入市场占用，请分配` : ""}` : ""}`,
      );
      setOpen(false);
      void utils.alertPlans.invalidate();
      void utils.workspaceCandidates.invalidate();
    },
    onError: (e) => setMessage(e.message),
  });
  return (
    <div className="space-y-2 rounded border bg-nc-card p-3">
      <Button onClick={() => setOpen(true)}>加入计划</Button>
      {open && (
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
              overrideCaps,
              stages: [Number(f.get("entry"))],
              stop: Number(f.get("stop")),
              target: f.get("target") ? Number(f.get("target")) : null,
              expiresAt: new Date(expiry).toISOString(),
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
            按分仓风险和最新核对额度计算数量，不含费用滑点。
          </p>
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
          <div className="grid gap-2 lg:grid-cols-2">
            {[
              { name: "entry", label: "入场参考", value: candidate.price },
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
                defaultValue={new Date(Date.now() + 86400000)
                  .toISOString()
                  .slice(0, 16)}
              />
            </label>
          </div>
          {candidate.market === "crypto" && (
            <div className="grid gap-2 lg:grid-cols-2">
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
            onClick={() => setOpen(false)}
          >
            关闭
          </Button>
        </form>
      )}
      {message && <p role={save.error ? "alert" : "status"}>{message}</p>}
    </div>
  );
}
