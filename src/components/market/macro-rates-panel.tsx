"use client";
import { Bank } from "@phosphor-icons/react/ssr";
import { cn } from "~/lib/common/classnames";
import { api } from "~/trpc/react";
import { Panel, PanelEmpty } from "../panels";
import { usePanelVisible } from "../workbench/keep-alive";

const pct = (v: number | null | undefined, d = 3) => (v == null ? "—" : `${v.toFixed(d)}%`);
const bp = (v: number | null) =>
  v == null ? "" : `${v > 0 ? "+" : ""}${Math.round(v * 100)}bp`;

function Row({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-[1px]">
      <span className="shrink-0 text-[11px] text-nc-text-4">{label}</span>
      <span className="truncate text-right text-[12px] tabular-nums">
        {value}
        {note && <span className={cn("ml-1 text-[10.5px] text-nc-text-4")}>{note}</span>}
      </span>
    </div>
  );
}

/** 宏观利率：国债收益率、期限利差、回购定盘利率、LPR。服务端缓存 1 小时。 */
export function MacroRatesPanel() {
  const visible = usePanelVisible();
  const query = api.macroRates.useQuery(undefined, {
    enabled: visible,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 60 * 60000,
  });
  const data = query.data;
  const t = data?.treasury ?? [];
  const t0 = t.at(-1);
  const t20 = t.at(-21);
  const r = data?.repo ?? [];
  const r0 = r.at(-1);
  const r20 = r.slice(-20);
  const avg7 = r20.length ? r20.reduce((a, x) => a + x.fr007, 0) / r20.length : null;
  const l0 = data?.lpr.at(-1);
  const diff = (a?: number | null, b?: number | null) => (a == null || b == null ? null : a - b);
  return (
    <Panel
      icon={Bank}
      title="宏观利率"
      meta={t0 ? `国债 ${t0.date}` : undefined}
      note="中债国债曲线（中央结算公司）· FR 回购定盘（中国货币网）· LPR（东方财富）；变化为较 20 个交易日前"
    >
      {query.error ? (
        <p role="alert" className="m-0 text-[12px] text-nc-bad">读取失败：{query.error.message}</p>
      ) : !data ? (
        <PanelEmpty>正在读取宏观利率…</PanelEmpty>
      ) : (
        <div className="flex flex-col">
          <Row label="10 年国债" value={pct(t0?.["10y"])} note={bp(diff(t0?.["10y"], t20?.["10y"]))} />
          <Row label="1 年国债" value={pct(t0?.["1y"])} note={bp(diff(t0?.["1y"], t20?.["1y"]))} />
          <Row label="30 年国债" value={pct(t0?.["30y"])} note={bp(diff(t0?.["30y"], t20?.["30y"]))} />
          <Row label="期限利差 10Y−1Y" value={bp(diff(t0?.["10y"], t0?.["1y"])) || "—"} />
          <Row label={`FR007${r0 ? ` · ${r0.date.slice(5)}` : ""}`} value={pct(r0?.fr007, 2)} note={avg7 == null ? undefined : `20 日均 ${avg7.toFixed(2)}%`} />
          <Row label="FR001" value={pct(r0?.fr001, 2)} />
          <Row label={`LPR${l0 ? ` · ${l0.date.slice(0, 7)}` : ""}`} value={l0 ? `1Y ${pct(l0.lpr1y, 2)} · 5Y ${pct(l0.lpr5y, 2)}` : "—"} />
          {data.failures.length > 0 && (
            <p className="m-0 mt-1 text-[10.5px] text-nc-warn">
              未能读取：{data.failures.map((f) => `${f.part}（${f.message}）`).join("；")}
            </p>
          )}
        </div>
      )}
    </Panel>
  );
}
