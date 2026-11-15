"use client";
import { useState } from "react";
import { api } from "~/trpc/react";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { formatNumber } from "~/lib/common/format-number";
import type { WorkspaceCandidate } from "../overview/candidate-table";

export function CandidatePlan({
  candidate,
}: {
  candidate: Pick<
    WorkspaceCandidate,
    "key" | "market" | "symbol" | "price" | "stop" | "target"
  >;
}) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const utils = api.useUtils();
  const save = api.createAlertPlan.useMutation({
    onSuccess: (p) => {
      setMessage(
        `已保存交易计划 · 数量 ${formatNumber(p.quantity, p.market === "crypto" ? 6 : 0)}`,
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
