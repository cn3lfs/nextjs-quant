"use client";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { api } from "~/trpc/react";
import {
  formatNumber,
  formatPercent,
} from "trading-strategy-core/format-number";
import { Panel, Segmented } from "../panels";
import { Button } from "../ui/button";
import { CandidateTable, type WorkspaceCandidate } from "./candidate-table";
import {
  candidateView,
  dailyMainAction,
  isTodayBatch,
  PENDING_CANDIDATE_MESSAGE,
  selectMarket,
  todayMarketOptions,
  type MarketFilter,
} from "./today-candidates";
import { CandidatePlan } from "../signals/candidate-plan";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "../ui/dialog";
import { LedgerSelect } from "../signals/ledger-fields";
import { DataTable } from "../ui/data-table";
import { useScreenVisible } from "../workbench/use-task-visible";
import { PaperFacts } from "../portfolio/paper-accounts-panel";
import { AccountRiskLinks } from "../portfolio/account-risk-links";
import { TodayIntel } from "../news/today-intel";
import { PaperShadowPrompt } from "../research/paper-shadow-prompt";
import { CryptoRiskNotes } from "../portfolio/crypto-risk-notes";
import { PaperForwardStatus } from "../portfolio/paper-forward-status";
import type { CloseScanPhase } from "~/lib/market/close-scan-window";
const Overview = dynamic(() =>
  import("./today-overview").then((m) => m.TodayOverview),
);
const Intraday = dynamic(() =>
  import("../workbench/route-panels").then((m) => m.IntradayPanel),
);
const closeScanLabel: Record<CloseScanPhase, string> = {
  "unknown-date": "基准交易日未知",
  waiting: "等待收盘",
  unconfirmed: "等待或未确认",
  running: "扫描中",
  missed: "已错过（不补跑）",
  complete: "流程已结束",
};
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
  const visible = useScreenVisible();
  const [filter, setFilter] = useState<MarketFilter>({
    market: "all",
    page: 0,
  });
  const [plan, setPlan] = useState<{
    row: WorkspaceCandidate;
    key: string;
  } | null>(null);
  const query = api.todayWorkspace.useQuery(undefined, {
    enabled: visible,
    refetchInterval: visible ? 30000 : false,
  });
  const scanCloseDate = query.data?.readiness.equity.expectedDate ?? null;
  const useTodayBatch = isTodayBatch(filter.market, filter.page);
  const candidates = api.workspaceCandidates.useQuery(
    {
      page: filter.page,
      market: filter.market === "all" ? undefined : filter.market,
      scanCloseDate,
    },
    { enabled: visible && !useTodayBatch && query.data !== undefined },
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
  const close = d.closeScan;
  const main = dailyMainAction({
    risks: risks.length,
    equityReady: d.readiness.equity.ready,
    cryptoReady: d.readiness.crypto.ready,
    candidates: d.candidates.total,
  });
  const view = candidateView({
    market: filter.market,
    page: filter.page,
    all: d.candidates,
    filtered: candidates.data,
    fetching: candidates.isFetching,
    failure: candidates.error?.message ?? null,
    close,
  });
  const loaded = view.rows ?? [];
  const historicalRows = loaded.filter((row) => row.scan?.hasHistorical).length;
  const plannableSources = (row: WorkspaceCandidate) =>
    row.sources.filter((source) => source.scanFreshness !== "stale");
  const planSource = plan?.row.sources.find((s) => s.key === plan.key) ?? null;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-nc-card p-4">
        <div>
          <h2 className="text-lg font-semibold">今日决策</h2>
          <p className="text-xs text-nc-text-3">
            截至 {new Date(d.now).toLocaleString("zh-CN")} · 提醒 {d.mode} ·
            提醒与本地模拟记账；真实交易由用户操作
          </p>
        </div>
        <Button asChild>
          <Link href={main.href}>{main.text}</Link>
        </Button>
      </div>
      {(
        [
          ["cn-equity", "A 股", d.readiness.equity.ready],
          ["crypto", "数字货币", d.readiness.crypto.ready],
        ] as const
      )
        .filter(([, , ready]) => !ready)
        .map(([market, label]) => (
          <p key={market} role="alert" className="text-sm text-nc-warn">
            {label}
            数据未就绪：候选可能缺失或停留在历史来源，显示数量是候选、不是已保存计划。
            <Link href="/system" className="underline">
              前往系统页补齐
            </Link>
          </p>
        ))}
      {(["cn-equity", "crypto"] as const)
        .filter((market) => d.capital[market] <= 0)
        .map((market) => (
          <div
            key={market}
            role="alert"
            className="rounded-lg border border-nc-warn bg-nc-card p-4"
          >
            {market === "crypto" ? "数字货币" : "A股"}资金为
            0，无法计算交易计划数量。请在系统页配置市场资金及分仓份额。
            <Button asChild variant="outline">
              <Link href="/system">配置分仓资金</Link>
            </Button>
          </div>
        ))}
      <PaperShadowPrompt />
      <PaperForwardStatus compact />
      <CryptoRiskNotes />
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
                  {s.at !== null && (
                    <span className="block text-xs text-nc-text-3">
                      {s.snapshotBasis === "post-close"
                        ? "收盘后快照"
                        : "盘中快照"}{" "}
                      · {new Date(s.at).toLocaleString("zh-CN")}
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </Panel>
      </div>
      <section className="rounded-lg border bg-nc-card p-4">
        <h2 className="mb-3 text-lg font-semibold text-nc-accent">
          今日模拟账户变化
        </h2>
        <PaperFacts today />
      </section>
      <section
        id="tomorrow"
        aria-label="明日计划"
        className="space-y-2 rounded-lg border bg-nc-card p-4"
      >
        <h2 className="text-lg font-semibold">明日计划</h2>
        <Segmented
          label="候选市场"
          value={filter.market}
          onChange={(market) =>
            setFilter((current) => selectMarket(current, market))
          }
          options={todayMarketOptions}
        />
        <p className="text-xs text-nc-text-3">
          收盘扫描与影子入场候选，逐条标明观察时点；历史候选需核对行情。数字货币按下一完成周期。数量沿用策略与纸面账户的仓位及费用假设；滑点影响以冻结研究口径和实际成交核对，不保证计划价成交。
        </p>
        <p className="text-xs text-nc-text-3" role="status">
          基准交易日：{close.date ?? "待交易日历"} · 收盘扫描：
          {closeScanLabel[close.phase]}
          {close.calendarConfirmed ? "" : " · 下一交易日未确认"}
          {close.at !== null && (
            <> · 记录于 {new Date(close.at).toLocaleString("zh-CN")}</>
          )}{" "}
          · 该日下载回执：
          {d.readiness.equity.receipt ? "已就绪" : "未就绪"} · 已启用 A 股策略{" "}
          {close.strategies} 条
        </p>
        {historicalRows > 0 && (
          <p className="text-sm text-nc-warn">
            {close.phase === "complete"
              ? "以下含历史来源，不是当次推荐。"
              : "最近收盘扫描未完成，以下为历史候选，不是当次推荐。"}
          </p>
        )}
        {close.phase === "complete" &&
          view.rows !== undefined &&
          view.total === 0 &&
          filter.market !== "crypto" && (
            <p className="text-xs text-nc-text-3">
              A股本地日线：{d.readiness.equity.localDate ?? "未知"} ·
              应到交易日：
              {close.date ?? "待日历"} · 回执：
              {d.readiness.equity.receipt ? "已就绪" : "未就绪"} · 数据缺口{" "}
              {d.gaps.length} 项{d.gaps.length ? "（见下方）" : ""}
              。该结论只表示扫描流程结束。
            </p>
          )}
        {view.rows === undefined ? (
          view.error ? (
            <p role="alert">
              候选读取失败：{view.error}{" "}
              <Button
                variant="outline"
                onClick={() => void candidates.refetch()}
              >
                重试
              </Button>
            </p>
          ) : (
            <p role="status">{PENDING_CANDIDATE_MESSAGE}</p>
          )
        ) : (
          <CandidateTable
            data={view.rows}
            total={view.total ?? 0}
            page={filter.page}
            onPage={(page) => setFilter((current) => ({ ...current, page }))}
            loading={view.loading}
            onRetry={() => void candidates.refetch()}
            onPlan={(row) => {
              const source =
                row.sources.find((s) => s.scanFreshness === "current") ??
                plannableSources(row)[0];
              if (source) setPlan({ row, key: source.key });
            }}
            canPlan={(row) => plannableSources(row).length > 0}
            emptyMessage={view.emptyMessage ?? undefined}
          />
        )}
        <Dialog
          open={plan !== null}
          onOpenChange={(open) => {
            if (!open) setPlan(null);
          }}
        >
          <DialogContent className="left-auto! right-4! top-4! translate-x-0! translate-y-0! lg:max-w-xl">
            <DialogTitle>创建交易计划 · {plan?.row.symbol}</DialogTitle>
            <DialogDescription>
              核对所选策略及保护位；保存后可在本页查看未完成计划。
            </DialogDescription>
            {plan && plannableSources(plan.row).length > 1 && (
              <LedgerSelect
                label="计划来源策略"
                value={plan.key}
                onChange={(key) => setPlan({ ...plan, key })}
                options={plannableSources(plan.row).map((s) => ({
                  value: s.key,
                  label: `${s.strategyId} v${s.version} · ${s.sleeve}`,
                }))}
              />
            )}
            {planSource && (
              <CandidatePlan
                key={planSource.key}
                candidate={planSource}
                inline
                onSaved={() => setPlan(null)}
                onClose={() => setPlan(null)}
              />
            )}
          </DialogContent>
        </Dialog>
      </section>
      <section
        className="space-y-2 rounded-lg border bg-nc-card p-4"
        aria-label="未完成交易计划"
      >
        <h2 className="text-lg font-semibold">
          未完成交易计划 · {d.openPlans.total}
        </h2>
        <DataTable
          label="未完成交易计划"
          data={d.openPlans.items}
          rowCount={d.openPlans.total}
          pagination={{ pageIndex: 0, pageSize: 20 }}
          sorting={[]}
          onPaginationChange={() => {}}
          onSortingChange={() => {}}
          showPagination={false}
          getRowId={(p) => p.id}
          columns={[
            {
              id: "symbol",
              header: "标的 / 策略",
              cell: ({ row: { original: p } }) =>
                `${p.symbol} · ${p.strategyId} v${p.strategyVersion}`,
            },
            {
              id: "entry",
              header: "入场 / 数量",
              cell: ({ row: { original: p } }) =>
                `${formatNumber(p.entry)} / ${formatNumber(p.quantity, p.market === "crypto" ? 6 : 0)}`,
            },
            {
              id: "stop",
              header: "止损 / 目标",
              cell: ({ row: { original: p } }) =>
                `${formatNumber(p.stop)} / ${formatNumber(p.target)}`,
            },
            {
              id: "expiry",
              header: "有效至",
              cell: ({ row: { original: p } }) =>
                p.expiresAt
                  ? new Date(p.expiresAt).toLocaleString("zh-CN")
                  : "未设置",
            },
            {
              id: "policy",
              header: "仓位 / 保护依据",
              cell: ({ row: { original: p } }) => (
                <span>
                  {p.sizingAudit?.validated
                    ? "通过研究验证"
                    : "研究中 / 未验证"}
                  {p.sizingAudit?.overridden ||
                  (p.protection?.version === "plan-protection-1" &&
                    !p.protection.matchesStrategy)
                    ? " · 已确认偏离策略参数"
                    : ""}
                  {p.protection?.version === "unavailable"
                    ? " · 缺完整退出规格"
                    : ""}
                </span>
              ),
            },
            {
              id: "journal",
              header: "计划理由 / 标签",
              cell: ({ row: { original: p } }) =>
                [p.rationale || "未记录", ...(p.tags ?? [])].join(" · "),
            },
            {
              id: "detail",
              header: "核对",
              cell: ({ row: { original: p } }) => (
                <Link
                  className="underline"
                  href={`/accounts/alerts?plan=${encodeURIComponent(p.id)}`}
                >
                  计划详情
                </Link>
              ),
            },
          ]}
          emptyMessage="尚无未完成交易计划。可直接从上方候选加入。"
        />
        {d.openPlans.total > 20 && (
          <Link href="/accounts/alerts" className="text-sm underline">
            查看其余未完成计划
          </Link>
        )}
      </section>
      <section
        className="space-y-2 rounded-lg border bg-nc-card p-4"
        aria-label="设置或调整止损单"
      >
        <h2 className="text-lg font-semibold">设置 / 调整止损单</h2>
        <p className="text-xs text-nc-text-3">
          按已完成收盘计算下一周期保护；挂单与退出由用户在券商操作，应用不认证已挂单。
        </p>
        {d.stopTasks.length ? (
          d.stopTasks.map((t) => (
            <div key={t.key} className="border-b pb-2 text-sm">
              <strong>
                {t.symbol} · {t.account}
              </strong>{" "}
              · {formatNumber(t.oldStop)} → {formatNumber(t.newStop)} ·{" "}
              {
                {
                  set: "设置止损",
                  adjust: "调整止损",
                  "time-exit": "时间退出",
                  "rule-exit": "策略退出条件",
                  "target-exit": "目标退出",
                  "stop-exit": "保护价触及",
                  "needs-review": "需要核验",
                }[t.status]
              }
              <p>{t.reason}</p>
              <p className="text-xs text-nc-text-3">
                {t.dueAt
                  ? `${new Date(t.dueAt).toLocaleString("zh-CN", { timeZone: t.market === "cn-equity" ? "Asia/Shanghai" : "UTC" })} ${t.market === "cn-equity" ? "北京时间" : "UTC"}`
                  : (t.dueDate ?? "待完整行情")}{" "}
                · {t.strategyId} v{t.version} · 来源计划 {t.sourcePlanId}
              </p>
            </div>
          ))
        ) : (
          <p>当前没有已关联持仓的保护任务。</p>
        )}
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
            <AccountRiskLinks />
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
                  <Link
                    className="font-semibold underline"
                    href={`/accounts?position=${encodeURIComponent(h.market === "cn-equity" ? `local:${h.symbol}` : `crypto:${h.account}`)}`}
                  >
                    {h.symbol}
                  </Link>{" "}
                  · 距止损{" "}
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
          A股本地日线：{d.readiness.equity.localDate ?? "未知"} · 应到交易日：
          {d.readiness.equity.expectedDate ?? "待日历"} · 该日下载回执：
          {d.readiness.equity.receipt ? "已就绪" : "未就绪"} · A股扫描：
          {d.readiness.equity.ready
            ? "就绪"
            : d.readiness.equity.status === "unknown"
              ? "交易日历或本地证据待核验"
              : "日线或回执待补齐"}{" "}
          · BTC/ETH 1d/4h：
          {d.readiness.crypto.ready ? "就绪" : "待补齐"} · 提醒引擎最近运行：
          {d.runtime
            ? new Date(d.runtime.lastCheck).toLocaleString("zh-CN")
            : "尚未运行"}
        </p>
        {d.readiness.crypto.series.map((s) => (
          <p
            key={`${s.symbol}:${s.interval}`}
            className="text-xs text-nc-text-3"
          >
            {s.symbol} {s.interval} · 本地最新 {s.end ?? "缺失"} ·{" "}
            {s.ready ? "当前周期就绪" : `待核验（缺口${s.gaps ?? "未知"}）`}
          </p>
        ))}
        {d.gaps.length > 0 && (
          <div role="alert" className="mt-2 text-sm text-nc-warn">
            <p>扫描数据缺口（最近20项）：</p>
            {d.gaps.map((g) => (
              <p key={g.id}>
                {g.id} · {g.reason} · {new Date(g.at).toLocaleString("zh-CN")}
              </p>
            ))}
          </div>
        )}
        <p className="text-xs text-nc-text-3">
          {d.archive.series.filter((s) => s.manifest).length}/
          {d.archive.series.length} 组原生周期有索引；校验与覆盖详情见{" "}
          <Link href="/system" className="underline">
            数据与连接
          </Link>
          。
        </p>
      </Panel>
      <TodayIntel />
    </div>
  );
}
