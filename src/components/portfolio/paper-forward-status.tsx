"use client";
import { api } from "~/trpc/react";
import Link from "next/link";
import { useScreenVisible } from "../workbench/use-task-visible";
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
      <h2 className="font-semibold text-nc-accent">
        {compact ? "前推一致性" : "模拟 · 候选前推"}
      </h2>
      {!compact && (
        <p>
          比较日权益、信号率、每笔净收益均值及平均模型滑点；A股需60市场日及20次入场，数字货币日线需120日。不会自动开启提醒。
        </p>
      )}
      {query.error && <p role="alert">{query.error.message}</p>}
      {query.data?.map((a) => {
        const current = a.currentAssessment;
        return (
          <p key={a.id} className="break-all text-sm">
            {a.id}：{current.observedSignals ?? "—"} 观察信号 /{" "}
            {current.days ?? "—"} 观察市场日 · {current.recommendation}
            {a.error ? `；${a.error}` : ""}
            {current.slippageBasis === "paper-model"
              ? " · 模型滑点，真实执行未验证"
              : ""}
          </p>
        );
      })}
      <Link href="/accounts" className="underline">
        账户权益、持仓与回测期望对照
      </Link>
    </section>
  );
}
