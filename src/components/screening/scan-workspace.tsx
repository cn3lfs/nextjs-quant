"use client";
import { useSearchParams, useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { Suspense, useState } from "react";
import { api, type RouterOutputs } from "~/trpc/react";
import { PanelCache } from "../workbench/keep-alive";
import {
  FilterDivider,
  FilterGroup,
  FilterToolbar,
  MethodologyPopover,
  Segmented,
  StateBanner,
} from "../panels";
import { chartAdjustmentLabels } from "~/lib/chart/chart-adjustment";
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
import { cryptoDisplayName } from "~/lib/market/crypto";
import { useMarketSession } from "~/lib/stores/market-session";
import { cn } from "~/lib/common/classnames";
import { formatNumber } from "trading-strategy-core/format-number";
import { Button } from "../ui/button";
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
const Valuation = dynamic(() =>
  import("../market/sector-valuation-view").then((m) => m.SectorValuationView),
);
const Crypto = dynamic(() =>
  import("../market/crypto-view").then((m) => m.CryptoQuotes),
);
const Futures = dynamic(() =>
  import("../market/futures-view").then((m) => m.FuturesView),
);
/** Missing prices stay "不可用"; never derive a raw price from an adjusted one. */
function priceOrUnavailable(value: number | null | undefined) {
  return value === null || value === undefined
    ? "不可用"
    : formatNumber(value, 2);
}
const tabs = [
  { value: "chart", label: "扫描与图表" },
  { value: "pool", label: "证券池" },
  { value: "formula", label: "条件选股" },
  { value: "rps", label: "RPS 数据管理" },
  { value: "sentiment", label: "打板情绪" },
  { value: "valuation", label: "板块估值" },
];
const marketOptions = [
  { value: "cn-equity", label: "A 股" },
  { value: "crypto", label: "数字货币" },
  { value: "futures", label: "期货" },
] as const;
const scanMethodology = [
  {
    label: "市场范围",
    detail:
      "A 股使用本地行情与统一扫描引擎；数字货币与期货为独立数据源，不混用自选、RPS 与台账。",
  },
  {
    label: "扫描候选",
    detail:
      "来自最近收盘扫描与影子观察。历史批次候选仅供复盘，不能直接新建计划；缺失不会生成计划。",
  },
  {
    label: "筛选口径",
    detail:
      "RPS20 为后复权排名，留空不过滤；无排名不补零。缺失价格显示不可用，不凭复权价推算原价。",
  },
] as const;
export function ScanWorkspace() {
  return (
    <Suspense fallback={<p role="status">正在读取扫描与图表…</p>}>
      <ScanWorkspaceBody />
    </Suspense>
  );
}
function ScanWorkspaceBody() {
  const search = useSearchParams();
  const router = useRouter();
  const tab = search.get("tab") ?? "chart";
  const market =
    tab === "crypto" ? "crypto" : tab === "futures" ? "futures" : "cn-equity";
  const switchMarket = (next: "cn-equity" | "crypto" | "futures") =>
    router.push(next === "cn-equity" ? "/scan" : `/scan?tab=${next}`, {
      scroll: false,
    });
  return (
    <div className="min-w-0 space-y-3">
      <FilterToolbar label="行情视图">
        <FilterGroup label="市场">
          <Segmented
            label="扫描市场"
            value={market}
            onChange={switchMarket}
            options={marketOptions}
          />
        </FilterGroup>
        {market === "cn-equity" && (
          <>
            <FilterDivider />
            <Segmented
              label="扫描视图"
              value={tab}
              onChange={(v) =>
                router.push(v === "chart" ? "/scan" : `/scan?tab=${v}`, {
                  scroll: false,
                })
              }
              options={tabs}
            />
          </>
        )}
        <div className="ml-auto shrink-0">
          <MethodologyPopover items={scanMethodology} />
        </div>
      </FilterToolbar>
      <PanelCache
        pinned={["chart", "formula"]}
        active={tab}
        panels={{
          chart: <ScanResults market="cn-equity" />,
          crypto: <ScanResults market="crypto" />,
          formula: <FormulaResults />,
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
  return (
    <div
      className={cn(
        "grid min-w-0 gap-4",
        hasSnapshot && "xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]",
      )}
    >
      <div className="min-w-0 [&_.inline-form]:flex-wrap! [&_.inline-form>input]:basis-full!">
        <Formula />
        {!hasSnapshot && (
          <p className="mt-2 text-xs text-nc-text-4">
            在公式结果中选择“个股研究”后，右侧会自动展开冻结图表复核抽屉。
          </p>
        )}
      </div>
      {hasSnapshot && (
        <section
          aria-label="公式候选图表"
          className="min-w-0 self-start space-y-3 xl:sticky xl:top-20"
        >
          <ScreenPlan />
          <Market embedded />
        </section>
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
  const items = rows.data?.items ?? [];
  const total = rows.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / 20));
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
                {s.id}
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
          <p className="px-1 py-2 text-[11px] text-nc-text-4">
            暂无候选。先补齐数据并登记策略；缺失不会生成计划。
          </p>
        )}
        {items.map((row, index) => {
          const code =
            market === "crypto"
              ? row.symbol.replace(/^cx/, "").toUpperCase()
              : row.symbol.toUpperCase();
          const name =
            market === "crypto"
              ? cryptoDisplayName(row.symbol)
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
              title={`${name} · ${row.strategyId} · 批次 ${row.bar}`}
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
      </div>
      <div className="flex items-center justify-between gap-1 border-t border-nc-border-soft pt-1.5 text-[11px] text-nc-text-4">
        <Button
          size="sm"
          variant="ghost"
          className="px-1.5"
          disabled={page === 0}
          onClick={() => setPage((current) => Math.max(0, current - 1))}
        >
          上一页
        </Button>
        <span className="tabular">
          {page + 1}/{pages}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="px-1.5"
          disabled={page + 1 >= pages}
          onClick={() => setPage((current) => current + 1)}
        >
          下一页
        </Button>
      </div>
      <p className="text-[11px] text-nc-text-4">
        共 {total} 只 · 点击即加载 · 图表内 PgUp/PgDn 翻股
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
          <span className="text-nc-text-3">· {candidate.strategyId}</span>
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
  const hasSnapshot = market === "cn-equity" && search.has("screenSnapshot");
  if (market === "crypto") {
    return (
      <div className="grid min-w-0 items-start gap-3 lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="nc-market-rail" aria-label="扫描候选">
          <div className="border-b border-nc-border px-2 py-1.5 text-xs font-medium text-nc-text-2">
            扫描候选
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-2">
            <ScanCandidateRail market="crypto" />
          </div>
        </aside>
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
      </div>
    );
  }
  return (
    <PlanLevelsProvider value={levels}>
      <Market
        leftCandidatesSlot={<ScanCandidateRail market="cn-equity" />}
        rightPlanSlot={
          <div className="space-y-2">
            {selected.error && (
              <p role="alert" className="text-xs text-nc-bad">
                候选读取失败：{selected.error.message}
              </p>
            )}
            {hasSnapshot && <ScreenPlan />}
            {candidate && <CandidatePlanRail candidate={candidate} />}
            {!candidate && !hasSnapshot && (
              <p className="text-xs text-nc-text-3">
                从左侧扫描候选选择个股后，这里显示双价锁、止损/目标距离与交易计划。历史批次候选仅供复盘。
              </p>
            )}
          </div>
        }
        hasActivePlan={!!candidate || hasSnapshot}
      />
    </PlanLevelsProvider>
  );
}
