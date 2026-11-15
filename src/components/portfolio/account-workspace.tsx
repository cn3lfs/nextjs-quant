"use client";
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { api, type RouterOutputs } from "~/trpc/react";
import { accountKindLabels } from "~/lib/portfolio/account-workspace";
import { formatNumber, formatPercent } from "~/lib/common/format-number";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { DataTable, type DataTableColumn } from "../ui/data-table";
import { Segmented } from "../panels";
import { PaperAccountsPanel } from "./paper-accounts-panel";
import { TradeLedgerPanel } from "./trade-ledger-panel";

const pct = (n: number | null) => formatPercent(n === null ? null : n * 100);
type Position = RouterOutputs["accountPositions"]["items"][number];
export function AccountWorkspace() {
  const search = useSearchParams(),
    tab = search.get("tab"),
    position = search.get("position");
  if (tab === "ledger") return <TradeLedgerPanel />;
  if (tab === "trades") return <AccountTrades />;
  if (tab === "paper") return <PaperAccountsPanel />;
  if (tab === "attribution") return <AccountAttribution />;
  if (tab === "monthly") return <MonthlyReview />;
  if (position) return <AccountPositionDetail id={position} />;
  return <UnifiedPositions />;
}
function UnifiedPositions() {
  const [kind, setKind] = useState<
      "real" | "paper" | "exchange-simulation" | "all"
    >("real"),
    [market, setMarket] = useState<"all" | "cn-equity" | "crypto">("all"),
    [group, setGroup] = useState<"market" | "sleeve" | "kind">("market"),
    [sleeve, setSleeve] = useState(""),
    [page, setPage] = useState(0);
  const query = api.accountPositions.useQuery({
    kind,
    market,
    group,
    sleeve,
    page,
  });
  const columns: DataTableColumn<Position>[] = [
    {
      id: "symbol",
      header: "持仓",
      cell: ({ row }) => (
        <Link
          className="underline"
          href={`/accounts?position=${encodeURIComponent(row.original.id)}`}
        >
          {row.original.symbol} ·{" "}
          {row.original.market === "cn-equity" ? "A股" : "数字货币"}
        </Link>
      ),
    },
    {
      id: "account",
      header: "账户 / 类型",
      cell: ({ row }) => (
        <span
          className={
            row.original.kind === "real" ? "text-nc-text-1" : "text-nc-accent"
          }
        >
          {row.original.account} · {accountKindLabels[row.original.kind]}
        </span>
      ),
    },
    {
      id: "sleeve",
      header: "分仓 / 行业",
      cell: ({ row }) => `${row.original.sleeve} / ${row.original.industry}`,
    },
    {
      id: "value",
      header: "市值",
      cell: ({ row }) =>
        `${formatNumber(row.original.value)} ${row.original.currency}`,
    },
    {
      id: "stop",
      header: "距止损 / R",
      cell: ({ row }) => (
        <span
          className={
            row.original.stopDistance !== null && row.original.stopDistance <= 0
              ? "text-nc-bad"
              : ""
          }
        >
          {pct(row.original.stopDistance)} /{" "}
          {formatNumber(row.original.rMultiple)}
        </span>
      ),
    },
  ];
  return (
    <section aria-label="统一持仓" className="space-y-4">
      <h2 className="text-xl font-semibold">统一持仓与风险</h2>
      <p className="text-sm text-nc-text-3">
        默认仅真实账户；纸面、模拟交易所分别标记。CNY/USDT不换算相加。手工与导入账本为独立事实，请勿重复登记同一成交。
      </p>
      <Segmented
        label="账户类型"
        value={kind}
        options={[
          { value: "real", label: "真实账户" },
          { value: "paper", label: "纸面账户" },
          { value: "exchange-simulation", label: "模拟交易所" },
          { value: "all", label: "全部类型" },
        ]}
        onChange={(v) => {
          setKind(v as typeof kind);
          setPage(0);
        }}
      />
      <Segmented
        label="市场"
        value={market}
        options={[
          { value: "all", label: "全部市场" },
          { value: "cn-equity", label: "A股" },
          { value: "crypto", label: "数字货币" },
        ]}
        onChange={(v) => {
          setMarket(v as typeof market);
          setPage(0);
        }}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          label="分组方式"
          value={group}
          options={[
            { value: "market", label: "按市场" },
            { value: "sleeve", label: "按分仓" },
            { value: "kind", label: "按类型" },
          ]}
          onChange={(v) => {
            setGroup(v as typeof group);
            setPage(0);
          }}
        />
        <Input
          aria-label="分仓筛选"
          placeholder="分仓ID，空为全部"
          value={sleeve}
          onChange={(e) => {
            setSleeve(e.target.value);
            setPage(0);
          }}
          className="max-w-56"
        />
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {query.data?.totals.map((t) => (
          <p key={t.currency} className="rounded border p-3">
            {t.currency} 持仓市值 {formatNumber(t.value)} · {t.count} 笔持仓 ·{" "}
            {t.missing} 笔估值未知
          </p>
        ))}
      </div>
      <div className="flex flex-wrap gap-3 text-sm">
        {query.data?.exposure.map((e) => (
          <p key={`${e.dimension}:${e.key}`}>
            {e.dimension} / {e.key}：{formatNumber(e.value)}
          </p>
        ))}
      </div>
      {query.data?.missingAccounts.map((m) => (
        <p key={m} role="status">
          {m}
        </p>
      ))}
      <DataTable
        label="统一持仓列表"
        columns={columns}
        data={query.data?.items ?? []}
        rowCount={query.data?.total ?? 0}
        pagination={{ pageIndex: page, pageSize: 20 }}
        sorting={[]}
        onSortingChange={() => {}}
        onPaginationChange={(u) =>
          setPage(
            (typeof u === "function" ? u({ pageIndex: page, pageSize: 20 }) : u)
              .pageIndex,
          )
        }
        getRowId={(r) => r.id}
        loading={query.isLoading}
        error={query.error?.message}
        onRetry={() => void query.refetch()}
      />
    </section>
  );
}
function AccountPositionDetail({ id }: { id: string }) {
  const [page, setPage] = useState(0);
  const query = api.accountPosition.useQuery({ id, page });
  if (query.isLoading) return <p role="status">正在读取持仓归因…</p>;
  if (query.error)
    return (
      <p role="alert">
        {query.error.message}{" "}
        <Button onClick={() => void query.refetch()}>重试</Button>
      </p>
    );
  if (!query.data) return null;
  const d = query.data,
    p = d.position;
  return (
    <section aria-label="持仓归因与衰减" className="space-y-4">
      <Link href="/accounts" className="underline">
        返回统一持仓
      </Link>
      <h2 className="text-xl font-semibold">
        {p.symbol} · {accountKindLabels[p.kind]} · {p.account}
      </h2>
      <p>
        数量 {formatNumber(p.quantity, 6)} · 市值 {formatNumber(p.value)}{" "}
        {p.currency} · 距止损 {pct(p.stopDistance)} · R{" "}
        {formatNumber(p.rMultiple)}
      </p>
      <p>
        原价时点 {p.at ?? "未知"} · 分仓 {p.sleeve} · 行业 {p.industry}
      </p>
      {p.reasons.map((r) => (
        <p key={r} className="text-sm text-nc-text-3">
          {r}
        </p>
      ))}
      <h3 className="text-lg font-semibold">归因与衰减</h3>
      {p.strategyId === null ? (
        <p>尚未关联策略；下方按来源建议确认或手工关联。</p>
      ) : (
        <AttributionRows rows={d.attribution} />
      )}
      <h3>持仓相关性与集中度</h3>
      <p>
        同市场同类型价格日收益相关；缺少20个相邻市场日或零方差留空。历史行业未知不补造。集中度仅使用导入账本的重放净值，其他账户缺完整现金事实时留空。
      </p>
      <p>
        平均相关性 {formatNumber(d.correlation.averagePairwise.value)} ·
        有效证券对 {d.correlation.pairCount.available} · 最大权重{" "}
        {pct(d.concentration.summary.maxSingleWeight)}
      </p>
      {d.correlation.rows
        .find((r) => r.symbol === p.symbol)
        ?.cells.map((c, i) => (
          <p key={i}>
            {p.symbol} / {d.correlation.symbols[i]}：{formatNumber(c.value)} ·{" "}
            {c.overlapDays}日 {c.reason}
          </p>
        ))}
      <TradeSources
        trades={d.trades}
        suggestions={d.suggestions}
        total={d.tradeCount}
        page={page}
        setPage={setPage}
        fetching={query.isFetching}
      />
    </section>
  );
}

function TradeSources({
  trades,
  suggestions,
  total,
  page,
  setPage,
  fetching,
}: {
  trades: RouterOutputs["accountTrades"]["trades"];
  suggestions: RouterOutputs["accountTrades"]["suggestions"];
  total: number;
  page: number;
  setPage: (page: number) => void;
  fetching: boolean;
}) {
  const utils = api.useUtils();
  const link = api.linkAccountTrade.useMutation({
    onSuccess: () =>
      Promise.all([
        utils.accountPosition.invalidate(),
        utils.accountTrades.invalidate(),
        utils.accountPositions.invalidate(),
      ]),
  });
  const [manual, setManual] = useState("");
  const d = { trades, suggestions, tradeCount: total };
  return (
    <section aria-label="成交来源" className="space-y-3">
      <h3>
        成交来源（第 {page + 1} 页，共 {d.tradeCount} 笔）
      </h3>
      <div className="flex gap-2">
        <Button
          variant="outline"
          disabled={page === 0 || fetching}
          onClick={() => setPage(page - 1)}
        >
          上一页成交
        </Button>
        <Button
          variant="outline"
          disabled={(page + 1) * 20 >= d.tradeCount || fetching}
          onClick={() => setPage(page + 1)}
        >
          下一页成交
        </Button>
      </div>
      {d.trades.map((t) => (
        <article key={t.id} className="space-y-2 rounded border p-3">
          <p>
            <span
              className={
                t.kind === "real" ? "text-nc-text-1" : "text-nc-accent"
              }
            >
              {t.account} · {accountKindLabels[t.kind]}
            </span>{" "}
            · {t.date} · {t.side} {formatNumber(t.quantity, 6)} @{" "}
            {formatNumber(t.price)} · {t.strategyId ?? "未关联"} v
            {t.strategyVersion ?? "—"} · {t.sleeve}
          </p>
          {t.planId && (
            <Link href="/accounts/alerts" className="underline">
              计划 {t.planId}
            </Link>
          )}
          {t.alertKey && <p className="break-all text-xs">提醒 {t.alertKey}</p>}
          {t.kind !== "paper" && (
            <>
              <div className="flex flex-wrap gap-2">
                {d.suggestions
                  .find((s) => s.tradeId === t.id)
                  ?.plans.map((plan) => (
                    <Button
                      key={plan.id}
                      variant="outline"
                      disabled={link.isPending}
                      onClick={() =>
                        link.mutate({
                          tradeId: t.id,
                          planId: plan.id,
                          alertKey: plan.triggerKey,
                          strategyId: plan.strategyId,
                          strategyVersion: plan.strategyVersion,
                          sleeve: plan.sleeve,
                        })
                      }
                    >
                      确认关联 {plan.strategyId} / {plan.id}
                    </Button>
                  ))}
                <Button variant="outline" onClick={() => setManual(t.id)}>
                  手工关联
                </Button>
              </div>
              {manual === t.id && (
                <form
                  className="grid gap-2 lg:grid-cols-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    link.mutate({
                      tradeId: t.id,
                      strategyId: String(f.get("strategy")),
                      strategyVersion: Number(f.get("version")),
                      sleeve: String(f.get("sleeve")),
                      planId: String(f.get("plan")) || null,
                      alertKey: String(f.get("alert")) || null,
                    });
                  }}
                >
                  {[
                    { name: "strategy", label: "策略ID", value: t.strategyId },
                    {
                      name: "version",
                      label: "策略版本",
                      value: t.strategyVersion ?? 1,
                    },
                    { name: "sleeve", label: "分仓ID", value: t.sleeve },
                    { name: "plan", label: "计划ID（可空）", value: t.planId },
                    {
                      name: "alert",
                      label: "提醒键（可空）",
                      value: t.alertKey,
                    },
                  ].map((f) => (
                    <label key={f.name}>
                      {f.label}
                      <Input name={f.name} defaultValue={f.value ?? ""} />
                    </label>
                  ))}
                  <Button disabled={link.isPending}>保存人工关联</Button>
                </form>
              )}
            </>
          )}
        </article>
      ))}
      {link.error && <p role="alert">{link.error.message}</p>}
      {link.isSuccess && <p role="status">关联已保存，审计记录保留。</p>}
    </section>
  );
}
function AccountTrades() {
  const search = useSearchParams(),
    [page, setPage] = useState(0),
    [symbol, setSymbol] = useState(search.get("symbol") ?? ""),
    [kind, setKind] = useState<
      "real" | "paper" | "exchange-simulation" | "all"
    >("real");
  const query = api.accountTrades.useQuery({
    page,
    symbol,
    kind,
    tradeId: search.get("trade") ?? undefined,
  });
  return (
    <section className="space-y-4">
      <h2>全部成交与来源</h2>
      <p>包含已清仓交易；建议不自动确认，纸面成交归属固定。</p>
      <Segmented
        label="成交账户类型"
        value={kind}
        options={[
          { value: "real", label: "真实" },
          { value: "paper", label: "纸面" },
          { value: "exchange-simulation", label: "模拟交易所" },
          { value: "all", label: "全部" },
        ]}
        onChange={(v) => {
          setKind(v);
          setPage(0);
        }}
      />
      <Input
        aria-label="成交品种筛选"
        value={symbol}
        onChange={(e) => {
          setSymbol(e.target.value);
          setPage(0);
        }}
        placeholder="证券代码或币对"
        className="max-w-56"
      />
      {query.error && <p role="alert">{query.error.message}</p>}
      {query.isLoading && <p role="status">正在读取成交…</p>}
      <TradeSources
        trades={query.data?.trades ?? []}
        suggestions={query.data?.suggestions ?? []}
        total={query.data?.tradeCount ?? 0}
        page={page}
        setPage={setPage}
        fetching={query.isFetching}
      />
    </section>
  );
}

function AttributionRows({
  rows,
}: {
  rows: RouterOutputs["accountAttribution"];
}) {
  return (
    <div className="space-y-3">
      {rows.map((r) => (
        <article
          key={`${r.strategyId}:${r.version}`}
          className="space-y-2 rounded border p-3"
        >
          <h4>
            {r.strategyId} v{r.version} · {r.market}/{r.sleeve}
          </h4>
          <p className={r.flagged ? "text-nc-bad" : "text-nc-text-2"}>
            {r.flagged ? "衰减已标记" : "未标记衰减"}
          </p>
          <p>
            回测期望：{r.expected?.samples.length ?? 0} 个同参数样本；
            {r.expected?.source ?? "缺少同期限冻结分布，不用不等长历史窗口冒充"}
          </p>
          {(["alerts", "paper", "actual", "simulation"] as const).map(
            (key, i) => (
              <p key={key}>
                {["提醒前推", "纸面前推", "用户实际", "模拟场所"][i]}：
                {r[key].observedSamples} 样本 · 中位 {pct(r[key].median)} ·
                期望P{formatNumber(r[key].percentile * 100, 0)}{" "}
                {pct(r[key].threshold)} ·{" "}
                {r[key].flagged
                  ? "衰减"
                  : r[key].enough
                    ? "未偏离"
                    : r[key].reason}
              </p>
            ),
          )}
          <p className="text-xs text-nc-text-3">{r.basis}</p>
        </article>
      ))}
    </div>
  );
}
function AccountAttribution() {
  const query = api.accountAttribution.useQuery(),
    freeze = api.freezeAccountExpectation.useMutation({
      onSuccess: () => void query.refetch(),
    });
  return (
    <section className="space-y-4">
      <h2>策略 / 分仓三方对比</h2>
      <p>
        按市场与分仓展示策略，版本分别对比，不平均独立账户收益。相同分仓可并列查看。
      </p>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          freeze.mutate(String(new FormData(e.currentTarget).get("job")));
        }}
      >
        <Input
          name="job"
          aria-label="同参数回测任务ID"
          placeholder="已完成的策略对象组合回测任务ID"
          required
          className="max-w-lg"
        />
        <Button disabled={freeze.isPending}>冻结同参数期望</Button>
      </form>
      {freeze.error && <p role="alert">{freeze.error.message}</p>}
      {freeze.isSuccess && <p role="status">已冻结首次同参数分布。</p>}
      {query.error && <p role="alert">{query.error.message}</p>}
      <AttributionRows rows={query.data ?? []} />
    </section>
  );
}
function MonthlyReview() {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7)),
    query = api.accountMonthlyReview.useQuery(month);
  return (
    <section className="space-y-4">
      <h2>月度纪律自查</h2>
      <Input
        type="month"
        aria-label="自查月份"
        value={month}
        onChange={(e) => setMonth(e.target.value)}
        className="max-w-56"
      />
      <p>{query.data?.notice}</p>
      {query.error && <p role="alert">{query.error.message}</p>}
      {query.data?.unavailable.map((r, i) => (
        <p key={`${r.account}:${r.security}:${i}`}>
          {r.account} / {r.security}：{r.reason}
        </p>
      ))}
      <p>
        缺少计划的真实成交 {query.data?.unlinked ?? "—"}{" "}
        笔，不能认定守纪或违纪。
      </p>
      {query.data?.items.map((r) => (
        <article key={`${r.account}:${r.kind}`} className="rounded border p-3">
          <h3>
            {r.account} ·{" "}
            {
              { stop: "跌破止损仍持有", oversize: "超仓", chase: "追高" }[
                r.kind as "stop" | "oversize" | "chase"
              ]
            }
          </h3>
          <p>
            {r.count} 次 · 实际回合盈亏 {formatNumber(r.actual)} CNY · 按纪律{" "}
            {formatNumber(r.counterfactual)} CNY · 金额改善{" "}
            {formatNumber(r.impact)} CNY
          </p>
          <p>{r.reason}</p>
          <p className="text-xs text-nc-text-3">{r.basis}</p>
        </article>
      ))}
      <Link href="/accounts/review" className="underline">
        交割单现金逐日核对、原有纪律网格与详细归因
      </Link>
    </section>
  );
}
