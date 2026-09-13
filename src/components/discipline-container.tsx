"use client";
import { useRef, useState } from "react";
import { api } from "~/trpc/react";
import { defaultBacktestCosts } from "~/lib/backtest-costs";
import {
  disciplineNotice,
  disciplineScope,
} from "~/lib/discipline-counterfactual";
import { DisciplineResults } from "./discipline-results";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

export function DisciplineContainer({ account }: { account: string }) {
  const utils = api.useUtils(),
    start = api.disciplineStart.useMutation(),
    cancel = api.disciplineCancel.useMutation();
  const [id, setId] = useState(""),
    [openingCash, setOpeningCash] = useState("126200"),
    [error, setError] = useState(""),
    [exporting, setExporting] = useState(false);
  const lock = useRef(false);
  const state = api.disciplineStatus.useQuery(id, {
    enabled: !!id,
    retry: false,
    refetchInterval: (q) => (q.state.data?.status === "running" ? 1000 : false),
  });
  const busy = start.isPending || state.data?.status === "running";
  return (
    <section
      aria-label="纪律反事实"
      className="space-y-3 rounded-lg border border-border p-4"
    >
      <h2 className="font-semibold">纪律反事实</h2>
      <p className="text-sm">
        {disciplineNotice}。{disciplineScope}
      </p>
      <p className="text-sm text-muted-foreground">
        本批核对 W2 的 784/774 回合及两项固定金额。期初现金默认 126,200 元，沿用
        W2 反推下界，非真实期初资金证明。结果保留 15
        分钟，重新运行会替换；完整导出含全部网格、逐回合、现金与行情证据。
      </p>
      <Label htmlFor="discipline-opening">实验期初现金（元）</Label>
      <Input
        id="discipline-opening"
        type="number"
        min={0}
        value={openingCash}
        disabled={busy}
        onChange={(e) => setOpeningCash(e.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={
            busy ||
            !openingCash ||
            !Number.isFinite(Number(openingCash)) ||
            Number(openingCash) < 0
          }
          onClick={async () => {
            if (lock.current) return;
            lock.current = true;
            setError("");
            setId("");
            try {
              const task = await start.mutateAsync({
                account,
                openingCash: Number(openingCash),
                stopCosts: defaultBacktestCosts,
              });
              setId(task.id);
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              lock.current = false;
            }
          }}
        >
          运行全部 20 点
        </Button>
        {busy && id && (
          <Button
            variant="outline"
            disabled={cancel.isPending}
            onClick={async () => {
              try {
                await cancel.mutateAsync(id);
                setId("");
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              }
            }}
          >
            取消
          </Button>
        )}
        {state.data?.status === "complete" && (
          <Button
            variant="outline"
            disabled={exporting}
            onClick={async () => {
              setExporting(true);
              setError("");
              try {
                const content = await utils.disciplineExport.fetch(id, {
                  staleTime: 0,
                });
                const url = URL.createObjectURL(
                  new Blob([content], { type: "application/json" }),
                );
                const a = document.createElement("a");
                a.href = url;
                a.download = "discipline-counterfactual.json";
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              } finally {
                setExporting(false);
              }
            }}
          >
            导出完整对照
          </Button>
        )}
      </div>
      {busy && <p role="status">{state.data?.phase ?? "准备数据"}…</p>}
      {(error || state.error) && (
        <p role="alert">{error || state.error?.message}。可重新运行。</p>
      )}
      {!id && !error && <p className="text-sm">尚未运行。</p>}
      {state.data && <DisciplineResults data={state.data} />}
    </section>
  );
}
