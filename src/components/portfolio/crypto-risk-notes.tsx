"use client";
import { api } from "~/trpc/react";
import {
  formatNumber,
  formatPercent,
} from "trading-strategy-core/format-number";
import { useScreenVisible } from "../workbench/use-task-visible";

export function CryptoRiskNotes() {
  const visible = useScreenVisible();
  const query = api.cryptoRiskSummary.useQuery(undefined, {
    enabled: visible,
    refetchInterval: visible ? 30000 : false,
  });
  if (query.error)
    return <p role="alert">机器人与分仓风险读取失败：{query.error.message}</p>;
  if (!query.data) return <p role="status">正在读取机器人与分仓风险…</p>;
  const d = query.data;
  return (
    <section
      className="space-y-2 rounded-lg border bg-nc-card p-4"
      aria-label="未验证机器人与闲置分仓"
    >
      <h3 className="font-semibold">数字货币资金用途</h3>
      <p>
        突破分仓 {formatPercent(d.breakout.share * 100)} ·{" "}
        {formatNumber(d.breakout.budget)} USDT ·{" "}
        {d.breakout.idle
          ? "闲置：暂无通过验证的突破策略"
          : "已有通过研究验证的策略，启用状态见实验室"}
      </p>
      {d.bots.map((b) => (
        <p key={b.id} className="text-sm">
          <strong className="text-nc-warn">未验证机器人</strong> · {b.id} ·{" "}
          {{ stopped: "已停止", running: "运行中", paused: "已暂停" }[b.status]}{" "}
          · 库存敞口 {formatNumber(b.exposure)} USDT
          {b.exposure === null ? "（估值未知）" : ""} ·{" "}
          {new Date(b.at).toLocaleString("zh-CN")}
        </p>
      ))}
      <p className="text-xs text-nc-text-3">
        {d.basis}。机器人继续按现有设置运行；纸面镜像遵守同场所独占规则。
      </p>
    </section>
  );
}
