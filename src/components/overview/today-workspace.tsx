"use client";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { api } from "~/trpc/react";
import { formatNumber, formatPercent } from "~/lib/common/format-number";
import { Panel, Segmented } from "../panels";
import { Button } from "../ui/button";
import { CandidateTable } from "./candidate-table";
import { useTaskVisible } from "../workbench/use-task-visible";
const Overview = dynamic(() =>
  import("./today-overview").then((m) => m.TodayOverview),
);
const Intraday = dynamic(() =>
  import("../workbench/route-panels").then((m) => m.IntradayPanel),
);
export function TodayWorkspace() {
  const search = useSearchParams();
  const tab = search.get("tab") ?? "today";
  return (
    <div className="space-y-4 [&_p]:my-0!">
      <Segmented
        label="今日视图"
        value={tab}
        onChange={(v) =>
          window.history.pushState(null, "", v === "today" ? "/" : `/?tab=${v}`)
        }
        options={[
          { value: "today", label: "今日决策" },
          { value: "overview", label: "市场与数据总览" },
          { value: "intraday", label: "盘中预选历史" },
        ]}
      />
      {tab === "overview" ? (
        <Overview />
      ) : tab === "intraday" ? (
        <Intraday />
      ) : (
        <DailyDecision />
      )}
    </div>
  );
}
function DailyDecision() {
  const visible = useTaskVisible();
  const [page, setPage] = useState(0);
  const query = api.todayWorkspace.useQuery(undefined, {
    enabled: visible,
    refetchInterval: visible ? 30000 : false,
  });
  const candidates = api.workspaceCandidates.useQuery(
    { page },
    { enabled: visible && page > 0 },
  );
  const d = query.data;
  if (query.error)
    return (
      <p role="alert">
        今日工作区读取失败：{query.error.message}{" "}
        <Button onClick={() => void query.refetch()}>重试</Button>
      </p>
    );
  if (!d) return <p role="status">正在读取今日决策…</p>;
  const risks =
    d.holdings?.filter((h) => h.stop !== null && h.price <= h.stop) ?? [];
  const dataMissing = !d.receipt || d.archive.needsBackfill;
  const main = risks.length
    ? { href: "#holding-risk", text: `处理 ${risks.length} 个跌破止损` }
    : dataMissing
      ? { href: "/system", text: "补齐数据" }
      : { href: "#tomorrow", text: `查看 ${d.candidates.total} 个计划` };
  const rows = page ? candidates.data : d.candidates;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-nc-card p-4">
        <div>
          <h2 className="text-lg font-semibold">今日决策</h2>
          <p className="text-xs text-nc-text-3">
            截至 {new Date(d.now).toLocaleString("zh-CN")} · 提醒 {d.mode} ·
            仅提醒，不自动交易
          </p>
        </div>
        <Button asChild>
          <Link href={main.href}>{main.text}</Link>
        </Button>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          className="col-span-1!"
          title="市场状态"
          meta="提醒引擎的最近一次完成行情观察"
        >
          <div className="grid gap-3 lg:grid-cols-2">
            {d.regimes.map((r) => (
              <div key={r.symbol} className="rounded border p-3">
                <strong>{r.symbol}</strong>
                <p>
                  {r.value
                    ? `${{ up: "上升", down: "下降", mixed: "震荡" }[r.value.trend]} · 温度 ${formatNumber(r.value.temperature, 1)}`
                    : "尚无有效观察"}
                </p>
                {r.market === "cn-equity" && (
                  <p className="text-xs">
                    历史低位深度 {r.value?.low?.depth ?? "未知"} ·{" "}
                    {r.value?.low?.confidence ?? "待数据"}
                  </p>
                )}
                <p className="text-xs text-nc-text-3">
                  {r.value?.bar ?? "时点未记录"}
                </p>
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-nc-text-3">
            趋势=收盘/SMA20/SMA60；温度=近120根收盘分位，非完整市场温度。低位=5–10年价格分位与回撤；无财务佐证时仅价格依据。
          </p>
        </Panel>
        <Panel
          className="col-span-1!"
          title="分仓占用与目标"
          meta="占用来自最近核对；偏离阈值10个百分点"
        >
          <div className="space-y-2">
            {d.sleeves.map((s) => (
              <div
                key={`${s.market}:${s.id}`}
                className="flex flex-wrap justify-between gap-2 border-b pb-2 text-sm"
              >
                <span>
                  {s.market === "crypto" ? "币种" : "A股"} · {s.id}
                </span>
                <span className={s.drift ? "text-nc-warn" : ""}>
                  实际{" "}
                  {formatPercent(s.actual === null ? null : s.actual * 100)} /
                  目标 {formatPercent(s.share * 100)} · {formatNumber(s.value)}
                  {s.drift ? " · 偏离" : ""}
                  {!s.fresh ? " · 待更新核对" : ""}
                </span>
              </div>
            ))}
          </div>
        </Panel>
      </div>
      <section
        id="tomorrow"
        aria-label="明日计划"
        className="space-y-2 rounded-lg border bg-nc-card p-4"
      >
        <h2 className="text-lg font-semibold">明日计划</h2>
        <p className="text-xs text-nc-text-3">
          收盘扫描与影子入场候选，逐条标明观察时点；历史候选需核对行情。数字货币按下一完成周期。数量不含费用滑点。
        </p>
        <CandidateTable
          data={rows?.items ?? []}
          total={rows?.total ?? 0}
          page={page}
          onPage={setPage}
          loading={page > 0 && candidates.isFetching}
          error={candidates.error?.message}
          onRetry={() => void candidates.refetch()}
        />
      </section>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          className="col-span-1!"
          title="已触发的提醒"
          meta="今日最新10条 · shadow 与 live"
        >
          <div className="max-h-40 space-y-2 overflow-auto">
            {d.triggered.items.length ? (
              d.triggered.items.map((e) => (
                <p key={e.key} className="text-sm">
                  <strong>
                    {e.mode} · {e.symbol}
                  </strong>{" "}
                  · {e.reason}
                </p>
              ))
            ) : (
              <p>今日尚无提醒。</p>
            )}
            <Link className="text-sm underline" href="/accounts/alerts">
              完整历史与前瞻收益
            </Link>
          </div>
        </Panel>
        <section id="holding-risk">
          <Panel
            title="风险持仓"
            meta="完成bar价格；R=(现价−已核对成本)/(成本−止损)"
          >
            {d.holdings === null ? (
              <p>尚未核对持仓，风险未知。</p>
            ) : d.holdings.length === 0 ? (
              <p>最近核对无持仓。</p>
            ) : (
              d.holdings.map((h) => (
                <div
                  key={`${h.market}:${h.account}:${h.symbol}`}
                  className="border-b py-2 text-sm"
                >
                  <strong>{h.symbol}</strong> · 距止损{" "}
                  {formatPercent(
                    h.stop === null
                      ? null
                      : ((h.price - h.stop) / h.price) * 100,
                  )}{" "}
                  · R{" "}
                  {formatNumber(
                    h.cost !== null && h.stop !== null && h.cost > h.stop
                      ? (h.price - h.cost) / (h.cost - h.stop)
                      : null,
                  )}
                  {h.stop !== null && h.price <= h.stop ? (
                    <strong className="text-nc-bad"> · 已跌破</strong>
                  ) : null}
                  <p className="text-xs text-nc-text-3">
                    {h.bar} ·{" "}
                    {h.cost === null ? "成本未核对；R留空" : "原价口径"}
                  </p>
                </div>
              ))
            )}
          </Panel>
        </section>
      </div>
      <Panel title="数据就绪" meta="读取本地回执与官方归档索引，不自动回填">
        <p>
          通达信今日收盘下载回执：{d.receipt ? "已就绪" : "未就绪"} · BTC/ETH
          官方归档：{d.archive.needsBackfill ? "待补齐" : "齐全"} ·
          提醒引擎最近运行：
          {d.runtime
            ? new Date(d.runtime.lastCheck).toLocaleString("zh-CN")
            : "尚未运行"}
        </p>
        <p className="text-xs text-nc-text-3">
          {d.archive.series.filter((s) => s.manifest).length}/
          {d.archive.series.length} 组原生周期有索引；校验与覆盖详情见{" "}
          <Link href="/system" className="underline">
            数据与连接
          </Link>
          。
        </p>
      </Panel>
    </div>
  );
}
