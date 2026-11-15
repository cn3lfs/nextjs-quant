"use client";
import { useState } from "react";
import Link from "next/link";
import type { Channel } from "~/lib/domain";
import { alertKinds } from "~/lib/strategy-facts/alerts";
import { api } from "~/trpc/react";
import { Button } from "../ui/button";
import { LedgerInput, LedgerSelect } from "./ledger-fields";
import { useTaskVisible } from "../workbench/use-task-visible";
export function AlertControls({ channels }: { channels: Channel[] }) {
  const visible = useTaskVisible();
  const status = api.alertStatus.useQuery(undefined, { enabled: visible });
  const utils = api.useUtils();
  const [market, setMarket] = useState<"cn-equity" | "crypto">("cn-equity");
  const [channel, setChannel] = useState("");
  const [symbols, setSymbols] = useState("");
  const [message, setMessage] = useState("");
  const subscription = api.saveAlertSubscription.useMutation({
    onSuccess: () => {
      setMessage("提醒订阅已保存");
      void utils.alertStatus.invalidate();
    },
    onError: (e) => setMessage(e.message),
  });
  const current = status.data?.subscriptions.find(
    (s) => s.id === `primary-${market}`,
  );
  return (
    <section className="space-y-3 rounded border p-4" aria-label="统一提醒订阅">
      <h2>统一提醒订阅</h2>
      <p>
        保存订阅不改变引擎模式。旧监控订阅保留查询；新引擎仅使用这里显式启用的订阅。
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <LedgerSelect
          label="订阅市场"
          value={market}
          onChange={(v) => {
            setMarket(v as typeof market);
            setChannel("");
          }}
          options={[
            { value: "cn-equity", label: "A股" },
            { value: "crypto", label: "数字货币" },
          ]}
        />
        <LedgerSelect
          label="提醒渠道"
          value={channel || current?.channels[0]}
          onChange={setChannel}
          options={[
            { value: "all", label: "选择已配置渠道" },
            ...channels.map((c) => ({
              value: c.id,
              label: `${c.name}${c.enabled ? "" : "（未启用）"}`,
            })),
          ]}
        />
        <LedgerInput
          label="订阅证券（空为全部）"
          value={symbols}
          onChange={setSymbols}
        />
        <Button
          disabled={
            subscription.isPending || !(channel || current?.channels[0])
          }
          onClick={() =>
            subscription.mutate({
              id: `primary-${market}`,
              enabled: true,
              market,
              channels: [channel || current!.channels[0]!],
              kinds: [...alertKinds].filter((k) => k !== "missed"),
              symbols: symbols.split(/[,，\s]+/).filter(Boolean),
              strategyIds: [],
            })
          }
        >
          启用提醒订阅
        </Button>
        <Button
          variant="outline"
          disabled={!current || subscription.isPending}
          onClick={() =>
            current && subscription.mutate({ ...current, enabled: false })
          }
        >
          停用提醒订阅
        </Button>
      </div>
      <p>当前：{current?.enabled ? "已启用" : "未启用"}；不自动订阅旧渠道。</p>
      <h3>已登记策略</h3>
      {status.error && <p role="alert">{status.error.message}</p>}
      {status.data?.strategies
        .filter(
          (s) =>
            !/^(holding-|regime-|allocation-|expiry-|system-|plan-)/.test(s.id),
        )
        .map((s) => {
          const { live } = s;
          return (
            <div
              key={`${s.id}:${s.version}`}
              className="flex items-center gap-3"
            >
              <span>
                {s.id} v{s.version} · {s.market} · {s.sleeve} ·{" "}
                {live ? "已加入监视" : "仅研究"}
              </span>
              <Link
                className="underline"
                href={`/lab?strategy=${encodeURIComponent(s.id)}&version=${s.version}`}
              >
                在实验室核对门槛与管理
              </Link>
            </div>
          );
        })}
      {!status.data?.strategies.length && (
        <p>暂无已登记策略。完成策略扫描后前往实验室核对并手动开启。</p>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
