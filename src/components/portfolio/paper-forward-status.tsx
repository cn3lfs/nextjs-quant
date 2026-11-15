"use client";
import { api } from "~/trpc/react";
import Link from "next/link";
import { useTaskVisible } from "../workbench/use-task-visible";
export function PaperForwardStatus() {
  const visible = useTaskVisible();
  const query = api.paperAccounts.useQuery(undefined, {
    enabled: visible,
    refetchInterval: visible ? 30000 : false,
  });
  return (
    <section
      aria-label="候选纸面前推状态"
      className="mb-4 space-y-2 rounded-lg border bg-nc-card p-4"
    >
      <h2 className="font-semibold text-nc-accent">模拟 · 候选前推</h2>
      <p>
        只计算登记后完成行情，30信号或60市场日后按同一门槛评估；不会自动开启提醒。
      </p>
      {query.error && <p role="alert">{query.error.message}</p>}
      {query.data?.map((a) => (
        <p key={a.id} className="break-all text-sm">
          {a.id}：{a.summary?.signals ?? 0} 信号 / {a.summary?.days ?? 0} 市场日
          · {a.summary?.assessment?.recommendation ?? a.error ?? "前推中"}
        </p>
      ))}
      <Link href="/accounts" className="underline">
        账户权益、持仓与回测期望对照
      </Link>
    </section>
  );
}
