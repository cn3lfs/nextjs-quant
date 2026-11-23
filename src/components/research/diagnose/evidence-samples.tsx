"use client";

import { useEffect, useRef, useState } from "react";
import type { DiagnoseScenarioMetrics } from "~/lib/research/diagnose-contract";
import { Pill } from "../../panels";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/tabs";
import {
  formatMoney,
  formatRatio,
  type DiagnosticFocusTarget,
  type DiagnosticFocusTab,
} from "./format";

const focusRowClass = "border-l-2 border-nc-accent bg-nc-inset text-nc-text";
const rowClass = "border-l-2 border-transparent";

/** Sampled evidence rows, highlight-linked from the 15-check drawer. */
export function EvidenceSamples({
  scenario,
  focus,
}: {
  scenario: DiagnoseScenarioMetrics;
  focus: DiagnosticFocusTarget | null;
}) {
  const section = useRef<HTMLElement>(null);
  const [previousFocus, setPreviousFocus] =
    useState<DiagnosticFocusTarget | null>(null);
  const [tab, setTab] = useState<DiagnosticFocusTab>("fills");
  const match = (row: {
    date?: string;
    signalAt?: string;
    orderId?: number;
    id?: number;
  }) => {
    if (!focus) return false;
    const rowDate = focus.signalDate
      ? row.signalAt
      : (row.date ?? row.signalAt);
    return (
      (focus.orderId === undefined ||
        focus.orderId === (row.orderId ?? row.id)) &&
      (focus.date === undefined || focus.date === rowDate?.slice(0, 10))
    );
  };
  const rowProps = (row: Parameters<typeof match>[0]) => {
    const matched = match(row);
    return {
      className: matched ? focusRowClass : rowClass,
      "data-evidence-match": matched || undefined,
      tabIndex: matched ? -1 : undefined,
    };
  };
  const orders = scenario.sampleOrders;
  const fills = scenario.sampleFills;
  const rejections = scenario.sampleRejections;
  const rowsByTab = { fills, orders, rejections };
  if (focus !== previousFocus) {
    setPreviousFocus(focus);
    const preferred = focus?.tab ?? "fills";
    const alternatives = ["fills", "orders", "rejections"] as const;
    setTab(
      rowsByTab[preferred].some(match)
        ? preferred
        : (alternatives.find((name) => rowsByTab[name].some(match)) ??
            preferred),
    );
  }
  useEffect(() => {
    if (!focus) return;
    const frame = requestAnimationFrame(() => {
      const target =
        section.current?.querySelector<HTMLElement>(
          '[data-state="active"] [data-evidence-match]',
        ) ?? section.current;
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [focus]);
  return (
    <section
      ref={section}
      tabIndex={-1}
      aria-label="证据样本"
      className="space-y-2"
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <h4 className="text-sm font-semibold text-nc-text">证据样本</h4>
        <span className="text-sub text-nc-text-3">
          每类最多 50 条；完整列表在归档产物中。
        </span>
        {focus && (
          <Pill tone="accent">
            {rowsByTab[tab].some(match) ? "已定位" : "待核对"}
            {focus.orderId !== undefined ? ` 订单 #${focus.orderId}` : ""}
            {focus.date ? ` ${focus.date}` : ""}
          </Pill>
        )}
      </div>
      {focus?.ledgerDiff && (
        <dl className="flex flex-wrap gap-x-3 gap-y-1 rounded border border-nc-border-soft bg-nc-inset px-3 py-2 text-sub tabular-nums">
          <dt className="text-nc-text-3">账本差额</dt>
          <dd>
            {focus.ledgerDiff.field} · 期望 {String(focus.ledgerDiff.expected)}{" "}
            · 实际 {String(focus.ledgerDiff.actual)}
          </dd>
        </dl>
      )}
      {focus && !rowsByTab[tab].some(match) && (
        <p role="status" className="text-sub text-nc-text-3">
          本表的归档样本没有匹配记录。
        </p>
      )}
      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as DiagnosticFocusTab)}
      >
        <TabsList>
          <TabsTrigger value="fills">成交 {fills.length}</TabsTrigger>
          <TabsTrigger value="orders">委托 {orders.length}</TabsTrigger>
          <TabsTrigger value="rejections">拒绝 {rejections.length}</TabsTrigger>
        </TabsList>
        <TabsContent value="fills">
          <div className="overflow-x-auto rounded-lg border border-nc-border-soft">
            <table className="w-full min-w-[620px] text-sm">
              <caption className="sr-only">成交样本</caption>
              <thead>
                <tr className="border-b border-nc-border-soft text-left text-sub text-nc-text-3">
                  <th scope="col" className="px-3 py-1.5 font-medium">
                    日期
                  </th>
                  <th scope="col" className="px-3 py-1.5 font-medium">
                    证券
                  </th>
                  <th scope="col" className="px-3 py-1.5 font-medium">
                    方向
                  </th>
                  <th scope="col" className="px-3 py-1.5 font-medium">
                    价格
                  </th>
                  <th scope="col" className="px-3 py-1.5 font-medium">
                    数量
                  </th>
                  <th scope="col" className="px-3 py-1.5 font-medium">
                    费用
                  </th>
                  <th scope="col" className="px-3 py-1.5 font-medium">
                    委托
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-nc-border-soft">
                {fills.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-3 py-3 text-nc-text-3">
                      没有成交样本。
                    </td>
                  </tr>
                ) : (
                  fills.map((fill) => (
                    <tr
                      key={`${fill.orderId}-${fill.symbol}-${fill.date}-${fill.side}`}
                      {...rowProps(fill)}
                    >
                      <td className="px-3 py-1.5 tabular-nums">{fill.date}</td>
                      <td className="px-3 py-1.5">{fill.symbol}</td>
                      <td
                        className={`px-3 py-1.5 ${fill.side === "buy" ? "text-nc-up" : "text-nc-down"}`}
                      >
                        {fill.side === "buy" ? "买入" : "卖出"}
                      </td>
                      <td className="px-3 py-1.5 tabular-nums">
                        {formatRatio(fill.price, 4)}
                      </td>
                      <td className="px-3 py-1.5 tabular-nums">
                        {formatRatio(fill.quantity, 0)}
                      </td>
                      <td className="px-3 py-1.5 tabular-nums">
                        {formatMoney(fill.fee)}
                      </td>
                      <td className="px-3 py-1.5 tabular-nums">
                        #{fill.orderId}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </TabsContent>
        <TabsContent value="orders">
          <div className="overflow-x-auto rounded-lg border border-nc-border-soft">
            <table className="w-full min-w-[680px] text-sm">
              <caption className="sr-only">委托样本</caption>
              <thead>
                <tr className="border-b border-nc-border-soft text-left text-sub text-nc-text-3">
                  <th scope="col" className="px-3 py-1.5 font-medium">
                    委托
                  </th>
                  <th scope="col" className="px-3 py-1.5 font-medium">
                    证券
                  </th>
                  <th scope="col" className="px-3 py-1.5 font-medium">
                    方向
                  </th>
                  <th scope="col" className="px-3 py-1.5 font-medium">
                    状态
                  </th>
                  <th scope="col" className="px-3 py-1.5 font-medium">
                    信号日
                  </th>
                  <th scope="col" className="px-3 py-1.5 font-medium">
                    原因
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-nc-border-soft">
                {orders.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-3 text-nc-text-3">
                      没有委托样本。
                    </td>
                  </tr>
                ) : (
                  orders.map((order) => (
                    <tr
                      key={`${order.id}-${order.symbol}-${order.signalAt}`}
                      {...rowProps(order)}
                    >
                      <td className="px-3 py-1.5 tabular-nums">#{order.id}</td>
                      <td className="px-3 py-1.5">{order.symbol}</td>
                      <td
                        className={`px-3 py-1.5 ${order.side === "buy" ? "text-nc-up" : "text-nc-down"}`}
                      >
                        {order.side === "buy" ? "买入" : "卖出"}
                      </td>
                      <td className="px-3 py-1.5">
                        {order.status === "filled"
                          ? "成交"
                          : order.status === "rejected"
                            ? "拒绝"
                            : "待成交"}
                      </td>
                      <td className="px-3 py-1.5 tabular-nums">
                        {order.signalAt}
                      </td>
                      <td className="px-3 py-1.5 text-nc-text-3">
                        {order.reason ?? "—"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </TabsContent>
        <TabsContent value="rejections">
          <div className="overflow-x-auto rounded-lg border border-nc-border-soft">
            <table className="w-full min-w-[520px] text-sm">
              <caption className="sr-only">拒绝样本</caption>
              <thead>
                <tr className="border-b border-nc-border-soft text-left text-sub text-nc-text-3">
                  <th scope="col" className="px-3 py-1.5 font-medium">
                    委托
                  </th>
                  <th scope="col" className="px-3 py-1.5 font-medium">
                    日期
                  </th>
                  <th scope="col" className="px-3 py-1.5 font-medium">
                    原因
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-nc-border-soft">
                {rejections.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-3 py-3 text-nc-text-3">
                      没有拒绝样本。
                    </td>
                  </tr>
                ) : (
                  rejections.map((rejection) => (
                    <tr
                      key={`${rejection.orderId}-${rejection.date}-${rejection.reason}`}
                      {...rowProps(rejection)}
                    >
                      <td className="px-3 py-1.5 tabular-nums">
                        #{rejection.orderId}
                      </td>
                      <td className="px-3 py-1.5 tabular-nums">
                        {rejection.date}
                      </td>
                      <td className="px-3 py-1.5 text-nc-text-3">
                        {rejection.reason}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </TabsContent>
      </Tabs>
    </section>
  );
}
