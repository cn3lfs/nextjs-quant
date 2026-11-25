"use client";
import { useSearchParams, useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { Suspense, useState } from "react";
import { api, type RouterOutputs } from "~/trpc/react";
import { PanelCache } from "../workbench/keep-alive";
import { Segmented, StateBanner } from "../panels";
import {
  useAccumulatedPages,
  useIntersectionLoadMore,
} from "../ui/use-infinite-table";
import { chartAdjustmentLabels } from "~/lib/chart/chart-adjustment";
import { readMarketPoolLocation } from "~/lib/market/market-pool-location";
import { rpsConditionsSchema } from "~/lib/screening/rps-conditions";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Input } from "../ui/input";
import {
  candidateHref,
  qualificationLabel,
  type WorkspaceCandidate,
} from "../overview/candidate-table";
import { CandidatePlan } from "../signals/candidate-plan";
import { PlanLevelsProvider } from "../market/plan-levels";
import { RiskDistanceBar } from "../portfolio/risk-distance-bar";
import { useTaskVisible } from "../workbench/use-task-visible";
import { useSecurityNames } from "../market/use-security-names";
import { securityDisplayName } from "~/lib/market/security-display";
import {
  cryptoDisplayName,
  cryptoSymbol,
  isCryptoSymbol,
} from "~/lib/market/crypto";
import { strategyDisplayName } from "~/lib/strategy-facts/strategy-display";
import { useMarketSession } from "~/lib/stores/market-session";
import { useScreenSession } from "~/lib/stores/screen-session";
import { cn } from "~/lib/common/classnames";
import { formatNumber } from "trading-strategy-core/format-number";
import { Button } from "../ui/button";
import {
  DeployStrategyDialog,
  type DeployStrategyPreset,
} from "../pipeline/deploy-strategy-dialog";
import { PatternScreenPanel } from "./pattern-screen-panel";
const Market = dynamic(() =>
  import("../market/market-page").then((m) => m.MarketPage),
);
const Formula = dynamic(() =>
  import("./screen-page").then((m) => m.ScreenPage),
);
const Pool = dynamic(() =>
  import("../market/stock-pool-view").then((m) => m.StockPoolView),
);
const Rps = dynamic(() =>
  import("../workbench/route-panels").then((m) => m.RpsPanel),
);
const Sentiment = dynamic(() =>
  import("../market/limit-up-view").then((m) => m.LimitUpView),
);
const Wencai = dynamic(() =>
  import("../market/thsdk-wencai-panel").then((m) => m.ThsdkWencaiPanel),
);
const Valuation = dynamic(() =>
  import("../market/sector-valuation-view").then((m) => m.SectorValuationView),
);
const Crypto = dynamic(() =>
  import("../market/crypto-view").then((m) => m.CryptoQuotes),
);
const Futures = dynamic(() =>
  import("../market/futures-view").then((m) => m.FuturesView),
);
const Watchlist = dynamic(() =>
  import("../market/watchlist-view").then((m) => m.WatchlistView),
);
const IntradayHistory = dynamic(() =>
  import("../intraday/intraday-history-panel").then(
    (m) => m.IntradayHistoryPanel,
  ),
);
/** Missing prices stay "不可用"; never derive a raw price from an adjusted one. */
function priceOrUnavailable(value: number | null | undefined) {
  return value === null || value === undefined
    ? "不可用"
    : formatNumber(value, 2);
}
export function ScanWorkspace() {
  return (
    <Suspense fallback={<p role="status">正在读取扫描与图表…</p>}>
      <ScanWorkspaceBody />
    </Suspense>
  );
}
function ScanDeployEntry({ tab }: { tab: string }) {
  const search = useSearchParams();
  const [open, setOpen] = useState(false);
  const selectedJob = useScreenSession((state) => state.screenId);
  const explicitJobId =
    tab === "formula"
      ? (search.get("screenJob") ?? search.get("job") ?? selectedJob)
      : "";
  const useRecentFormula = open && tab === "formula" && !explicitJobId;
  const recentJobs = api.jobs.useQuery(undefined, {
    enabled: useRecentFormula,
  });
  const formulaJobId =
    explicitJobId ||
    (useRecentFormula
      ? (recentJobs.data?.find(({ isFormulaScreen }) => isFormulaScreen)?.id ??
        "")
      : "");
  const formulaJob = api.jobSummary.useQuery(
    { id: formulaJobId, screenFirstPage: true },
    { enabled: open && Boolean(formulaJobId) },
  );
  const loadingFormula =
    (useRecentFormula && recentJobs.isPending) ||
    (open && Boolean(formulaJobId) && formulaJob.isPending);
  const symbol = search.get("symbol") ?? "";
  const preset: DeployStrategyPreset = {
    name: "扫描选股 · 双突破",
    strategySpec: { kind: "double-breakout" },
    provenance: {
      sourceKind: "scan",
      sourceRefId:
        (search.get("screenSnapshot") ?? formulaJobId) || symbol || null,
      createdFromRoute: "/scan",
    },
  };
  if (tab === "crypto") {
    preset.name = "数字货币 · 双均线";
    preset.strategySpec = {
      kind: "crypto-dual-ma",
      fast: 20,
      slow: 60,
      period: "1h",
    };
    preset.universeSpec = {
      kind: "fixed-symbols",
      symbols: isCryptoSymbol(symbol) ? [symbol] : [],
    };
  } else if (tab === "formula") {
    const result = formulaJob.data?.screenFirstPage;
    const formula = result?.formula;
    preset.name = formula ? `${formula.name} · 双突破` : "公式选股 · 双突破";
    preset.universeSpec = {
      kind: "formula-screen",
      formulaName: formula?.name ?? "",
      source: formula?.source ?? "",
      parameters: formula?.parameters,
    };
    preset.description = formula
      ? "已带入所选任务的公式和参数。运行台使用本地日线重新选股。"
      : "可填写当前编辑器中的公式和参数，或先完成一次公式选股以带入已运行的配置。";
  } else if (tab === "pattern") {
    preset.name = "结构与形态突破 · 双突破";
    preset.universeSpec = {
      kind: "theory-screener-scan",
      methodId: "f02-dow-swing-break",
    };
  } else if (tab === "rps" || tab === "pool") {
    const { query } = readMarketPoolLocation(search.toString());
    const filters =
      rpsConditionsSchema.safeParse(
        search.getAll("rpsCondition").map((value) => {
          const [period, side, threshold] = value.split(",");
          return { period: Number(period), side, value: Number(threshold) };
        }),
      ).data ?? [];
    const supportedFilter = filters.find(
      ({ period, side }) =>
        side === "gte" &&
        (period === 10 || period === 20 || period === 50 || period === 120),
    );
    const period = supportedFilter?.period ?? query.period;
    const supportedPeriod =
      period === 10 || period === 20 || period === 50 || period === 120;
    preset.name = "RPS 选股 · 双突破";
    preset.universeSpec = {
      kind: "rps-filter",
      period: supportedPeriod ? period : 50,
      minRps: supportedFilter?.value ?? query.minimumRps ?? 0,
    };
    if (
      !supportedPeriod ||
      filters.some((filter) => filter !== supportedFilter) ||
      query.pool ||
      query.search.trim()
    )
      preset.description =
        "运行台的 RPS 筛选按全市场、单一周期和最低分运行，请确认部署口径。";
  } else if (tab === "chart" && /^(sh|sz|bj)\d{6}$/i.test(symbol)) {
    preset.universeSpec = { kind: "fixed-symbols", symbols: [symbol] };
  }
  return (
    <>
      <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={loadingFormula}
          onClick={() => setOpen(true)}
        >
          {loadingFormula ? "正在读取选股预置…" : "部署到策略运行台"}
        </Button>
      </div>
      <DeployStrategyDialog
        open={open && !loadingFormula}
        onOpenChange={setOpen}
        defaultPreset={preset}
      />
    </>
  );
}

function ScanWorkspaceBody() {
  const search = useSearchParams();
  const tab = search.get("tab") ?? "chart";
  return (
    <div className="min-w-0 space-y-3">
      {tab !== "formula" && tab !== "futures" && (
        <ScanDeployEntry key={tab} tab={tab} />
      )}
      <PanelCache
        pinned={["chart", "formula"]}
        active={tab}
        panels={{
          chart: <ScanResults market="cn-equity" />,
          watchlist: <Watchlist />,
          crypto: <ScanResults market="crypto" />,
          formula: <FormulaResults />,
          wencai: <Wencai />,
          pool: <Pool />,
          rps: <Rps />,
          sentiment: <Sentiment />,
          valuation: <Valuation />,
          futures: <Futures />,
        }}
      />
    </div>
  );
}
function FormulaResults() {
  const search = useSearchParams();
  const hasSnapshot = search.has("screenSnapshot");
  const [subTab, setSubTab] = useState<"formula" | "pattern" | "intraday">(
    "formula",
  );
  const showFormula = subTab === "formula";
  const showPattern = subTab === "pattern";
  return (
    <div className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          label="公式选股视图"
          value={subTab}
          onChange={setSubTab}
          options={[
            { value: "formula", label: "公式选股" },
            { value: "pattern", label: "结构与形态突破" },
            { value: "intraday", label: "历史预选记录" },
          ]}
        />
        {(showFormula || showPattern) && (
          <ScanDeployEntry key={subTab} tab={subTab} />
        )}
      </div>
      {showFormula || showPattern ? (
        <div
          className={cn(
            "grid min-w-0 gap-4",
            hasSnapshot && "xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]",
          )}
        >
          <div className="min-w-0 [&_.inline-form]:flex-wrap! [&_.inline-form>input]:basis-full!">
            {showFormula ? <Formula /> : <PatternScreenPanel />}
          </div>
          {hasSnapshot && (
            <section
              aria-label={showFormula ? "公式候选图表" : "结构形态候选图表"}
              className="min-w-0 self-start space-y-3 xl:sticky xl:top-20"
            >
              <ScreenPlan />
              <Market embedded />
            </section>
          )}
        </div>
      ) : (
        <IntradayHistory />
      )}
    </div>
  );
}
function ScreenPlan() {
  const search = useSearchParams();
  const router = useRouter();
  const prepare = api.prepareScreenPlan.useMutation({
    onSuccess: (c) =>
      router.push(
        `/scan?symbol=${encodeURIComponent(c.symbol)}&adjustment=none&candidate=${encodeURIComponent(c.key)}`,
        { scroll: false },
      ),
  });
  return (
    <div className="rounded border bg-nc-card p-2 text-xs">
      <p className="text-nc-warn">
        公式候选 · 研究中。原公式未指定保护位，加入计划时须明确止损与目标。
      </p>
      <Button
        size="sm"
        disabled={prepare.isPending}
        onClick={() =>
          prepare.mutate({
            jobId: search.get("screenJob") ?? "",
            snapshotId: search.get("screenSnapshot")!,
          })
        }
      >
        加入计划
      </Button>
      {prepare.error && <p role="alert">{prepare.error.message}</p>}
    </div>
  );
}
/** 批次微标：完整日期在 title 中，列表只显示月-日。 */
function batchLabel(bar: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(bar) ? bar.slice(5) : bar;
}
/**
 * 扫描候选轨：策略 + RPS20 过滤与紧凑列表。点击即加载并进入图表；
 * A 股同时建立翻股列表，图表内可用 PgUp/PgDn 连续换股。
 */
function ScanCandidateRail({ market }: { market: "cn-equity" | "crypto" }) {
  const visible = useTaskVisible();
  const router = useRouter();
  const search = useSearchParams();
  const names = useSecurityNames().data ?? {};
  const [strategy, setStrategy] = useState("");
  const [rps, setRps] = useState("");
  const [page, setPage] = useState(0);
  const definitions = api.alertStatus.useQuery(undefined, { enabled: visible });
  const rows = api.workspaceCandidates.useQuery(
    {
      page,
      market,
      strategy: strategy || undefined,
      minimumRps: rps === "" ? undefined : Number(rps),
    },
    { enabled: visible },
  );
  const resetKey = JSON.stringify([market, strategy, rps]);
  const batches = useAccumulatedPages({
    pageIndex: page,
    items: rows.data?.items,
    total: rows.data?.total,
    resetKey,
    getKey: (row) => row.key,
    isSuccess: rows.isSuccess && !rows.isFetching,
  });
  const items = batches.rows;
  const total = batches.total;
  const sentinel = useIntersectionLoadMore({
    enabled: batches.hasMore,
    loading: rows.isFetching,
    onLoadMore: () => setPage((current) => current + 1),
  });
  const selectedKey = search.get("candidate") ?? "";
  const selectedSymbol =
    market === "crypto"
      ? (search.get("pair") ?? "BTCUSDT").replace(/^cx/, "")
      : search.get("symbol");
  const open = (row: WorkspaceCandidate, index: number) => {
    if (market === "cn-equity" && items.length)
      useMarketSession.getState().setBrowse({
        label: "扫描候选",
        symbols: items.map((item) => item.symbol),
        index,
      });
    router.push(candidateHref(row), { scroll: false });
  };
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <Select
        value={strategy || "all"}
        onValueChange={(v) => {
          setStrategy(v === "all" ? "" : v);
          setPage(0);
        }}
      >
        <SelectTrigger aria-label="扫描策略" className="h-8 w-full text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">全部入场候选</SelectItem>
          {definitions.data?.strategies
            .filter((s) => s.market === market)
            .map((s) => (
              <SelectItem key={`${s.id}:${s.version}`} value={s.id}>
                {strategyDisplayName(s.id)}
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
      {market === "cn-equity" && (
        <label className="flex items-center gap-2 text-[11px] text-nc-text-3">
          <span className="shrink-0">最低 RPS20</span>
          <Input
            aria-label="最低 RPS20"
            type="number"
            min="0"
            max="100"
            placeholder="不过滤"
            className="h-8"
            value={rps}
            onChange={(e) => {
              setRps(e.target.value);
              setPage(0);
            }}
          />
        </label>
      )}
      {definitions.error && (
        <p role="alert" className="text-[11px] text-nc-bad">
          {definitions.error.message}
        </p>
      )}
      <div className="min-h-0 space-y-0.5" aria-label="扫描候选">
        {rows.isLoading && (
          <p className="px-1 py-2 text-[11px] text-nc-text-4">正在读取候选…</p>
        )}
        {rows.error && (
          <p role="alert" className="px-1 py-2 text-[11px] text-nc-bad">
            候选读取失败：{rows.error.message}{" "}
            <Button
              variant="outline"
              size="sm"
              onClick={() => void rows.refetch()}
            >
              重试
            </Button>
          </p>
        )}
        {!rows.isLoading && !rows.error && items.length === 0 && (
          <p className="px-1 py-2 text-[11px] text-nc-text-4">暂无候选。</p>
        )}
        {items.map((row, index) => {
          const code =
            market === "crypto"
              ? row.symbol.replace(/^cx/, "").toUpperCase()
              : row.symbol.toUpperCase();
          const name =
            market === "crypto"
              ? cryptoDisplayName(
                  isCryptoSymbol(row.symbol)
                    ? row.symbol
                    : cryptoSymbol(row.symbol),
                )
              : securityDisplayName(row.symbol, names);
          const active =
            row.key === selectedKey ||
            (!!selectedSymbol &&
              row.symbol.replace(/^cx/, "") === selectedSymbol);
          return (
            <Button
              key={row.key}
              variant="plain"
              type="button"
              aria-current={active ? "true" : undefined}
              title={`${name} · ${strategyDisplayName(row.strategyId)} · 批次 ${row.bar}`}
              className={cn(
                "flex w-full min-w-0 items-center gap-1.5 rounded px-1.5 py-1 text-left hover:bg-nc-inset",
                active && "bg-nc-accent-900",
              )}
              onClick={() => open(row, index)}
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <strong className="truncate text-xs font-medium text-nc-text">
                  {name}
                </strong>
                <span className="truncate text-[11px] text-nc-text-4 tabular">
                  {code}
                </span>
              </span>
              <span
                className="shrink-0 rounded border border-nc-border px-1 text-[10px] text-nc-text-4 tabular"
                title={`扫描批次 ${row.bar}`}
              >
                {batchLabel(row.bar)}
              </span>
            </Button>
          );
        })}
        <div ref={sentinel} aria-hidden="true" className="h-1" />
      </div>
      {batches.hasMore && (
        <Button
          size="sm"
          variant="outline"
          className="w-full"
          disabled={rows.isFetching}
          onClick={() => setPage((current) => current + 1)}
        >
          {rows.isFetching ? "加载中…" : "加载更多"}
        </Button>
      )}
      <p className="text-[11px] text-nc-text-4">
        已显示 {items.length} / {total} 只 · PgUp/PgDn 翻股
      </p>
    </div>
  );
}
/** 右轨计划签：双价锁数值、止损/目标距离与建计划入口。 */
function CandidatePlanRail({
  candidate,
}: {
  candidate: RouterOutputs["workspaceCandidate"];
}) {
  return (
    <div className="space-y-2">
      <div className="rounded border bg-nc-card p-2 text-xs">
        <div className="flex flex-wrap items-center gap-1.5">
          <strong
            className={
              candidate.qualification === "promoted"
                ? "text-nc-ok"
                : "text-nc-warn"
            }
          >
            {qualificationLabel[candidate.qualification]}
          </strong>
          <span className="text-nc-text-3" title={candidate.strategyId}>
            · {strategyDisplayName(candidate.strategyId)}
          </span>
        </div>
        <p className="m-0 mt-1 text-nc-text-2 tabular">
          入场 {formatNumber(candidate.price)} · 止损{" "}
          {formatNumber(candidate.stop)} · 目标 {formatNumber(candidate.target)}
          <span className="text-nc-text-4"> · 原价</span>
        </p>
        <RiskDistanceBar
          price={candidate.price}
          stop={candidate.stop}
          target={candidate.target}
          compact
          className="mt-2"
        />
        <dl className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1 text-[11px]">
          <div>
            <dt className="text-nc-text-4">选股复权参考价</dt>
            <dd className="m-0 tabular">
              {priceOrUnavailable(candidate.signalPrice)}
            </dd>
          </div>
          <div>
            <dt className="text-nc-text-4">计划参考原价</dt>
            <dd
              className={cn(
                "m-0",
                candidate.executionRawPrice === null ||
                  candidate.executionRawPrice === undefined
                  ? "text-nc-warn"
                  : "tabular",
              )}
            >
              {priceOrUnavailable(candidate.executionRawPrice)}
            </dd>
          </div>
        </dl>
        {candidate.signalPriceBasis && (
          <p className="m-0 mt-1 text-[11px] text-nc-text-4">
            复权口径 {chartAdjustmentLabels[candidate.signalPriceBasis]} ·
            原价不复权
          </p>
        )}
        {(candidate.executionRawPrice === null ||
          candidate.executionRawPrice === undefined) && (
          <p className="mt-1 text-[11px] text-nc-warn">
            快照未记录原价：显示不可用，不用复权价推算；建计划前请用原始行情核对。
          </p>
        )}
      </div>
      {candidate.freshness === "stale" ? (
        <StateBanner
          state="warn"
          title="历史批次候选仅供复盘参考，默认不可新建计划"
          asOf={`扫描批次 ${candidate.bar}`}
        >
          该候选来自已过期的历史扫描批次。请选择当前批次；服务端只有在明确允许使用历史候选时才会接受建计划。
        </StateBanner>
      ) : (
        <CandidatePlan key={candidate.key} candidate={candidate} />
      )}
    </div>
  );
}
function ScanResults({ market }: { market: "cn-equity" | "crypto" }) {
  const visible = useTaskVisible();
  const search = useSearchParams();
  const key = search.get("candidate") ?? "";
  const selected = api.workspaceCandidate.useQuery(key, {
    enabled: visible && !!key,
    // A chart load can persist other workspace facts during this versioned read.
    // Retry the read once; plan mutations keep their original version fence.
    retry: 1,
  });
  const selectedSymbol =
    market === "crypto"
      ? (search.get("pair") ?? "BTCUSDT").replace(/^cx/, "")
      : search.get("symbol");
  const candidate =
    selected.data?.market === market &&
    selectedSymbol === selected.data.symbol.replace(/^cx/, "")
      ? selected.data
      : null;
  const levels = candidate
    ? {
        symbol: candidate.symbol,
        entry: candidate.price,
        stop: candidate.stop,
        target: candidate.target,
      }
    : null;
  if (market === "crypto") {
    return (
      <div className="min-w-0 space-y-3">
        {selected.error && (
          <p role="alert" className="text-xs text-nc-bad">
            候选读取失败：{selected.error.message}
          </p>
        )}
        {candidate && <CandidatePlanRail candidate={candidate} />}
        <PlanLevelsProvider value={levels}>
          <Crypto />
        </PlanLevelsProvider>
      </div>
    );
  }
  return (
    <div className="min-w-0 space-y-3">
      {selected.error && (
        <p role="alert" className="text-xs text-nc-bad">
          候选读取失败：{selected.error.message}
        </p>
      )}
      <PlanLevelsProvider value={levels}>
        <Market leftCandidatesSlot={<ScanCandidateRail market="cn-equity" />} />
      </PlanLevelsProvider>
      {candidate && <CandidatePlanRail candidate={candidate} />}
    </div>
  );
}
