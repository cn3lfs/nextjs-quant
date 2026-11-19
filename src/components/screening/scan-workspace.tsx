"use client";
import { useSearchParams, useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { Suspense, useState } from "react";
import { api } from "~/trpc/react";
import { PanelCache } from "../workbench/keep-alive";
import { Segmented } from "../panels";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Input } from "../ui/input";
import {
  CandidateTable,
  candidateHref,
  qualificationLabel,
} from "../overview/candidate-table";
import { CandidatePlan } from "../signals/candidate-plan";
import { PlanLevelsProvider } from "../market/plan-levels";
import { useTaskVisible } from "../workbench/use-task-visible";
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
const tabs = [
  { value: "chart", label: "扫描与图表" },
  { value: "pool", label: "证券池" },
  { value: "formula", label: "条件选股" },
  { value: "rps", label: "RPS 数据管理" },
  { value: "sentiment", label: "打板情绪" },
  { value: "valuation", label: "板块估值" },
];
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
  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          label="扫描市场"
          value={market}
          onChange={(v) =>
            router.push(v === "cn-equity" ? "/scan" : `/scan?tab=${v}`, {
              scroll: false,
            })
          }
          options={[
            { value: "cn-equity", label: "A 股" },
            { value: "crypto", label: "BTC / ETH" },
            { value: "futures", label: "期货浏览" },
          ]}
        />
        {market === "cn-equity" && (
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
        )}
      </div>
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
  return (
    <div className="grid min-w-0 gap-4 xl:grid-cols-2">
      <div className="min-w-0 [&_.inline-form]:flex-wrap! [&_.inline-form>input]:basis-full!">
        <Formula />
      </div>
      <section
        aria-label="公式候选图表"
        className="min-w-0 self-start space-y-3 xl:sticky xl:top-20"
      >
        {search.has("screenSnapshot") ? (
          <>
            <ScreenPlan />
            <Market embedded />
          </>
        ) : (
          <p className="rounded border bg-nc-card p-4">
            在公式结果中选择“个股研究”，在右侧核对冻结图表并加入计划。
          </p>
        )}
      </section>
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
    <div className="rounded border bg-nc-card p-3">
      <p className="text-sm text-nc-warn">
        公式候选 · 研究中。原公式未指定保护位，加入计划时须明确止损与目标。
      </p>
      <Button
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
function ScanResults({ market }: { market: "cn-equity" | "crypto" }) {
  const visible = useTaskVisible();
  const router = useRouter();
  const search = useSearchParams();
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
  const key = search.get("candidate") ?? "";
  const selected = api.workspaceCandidate.useQuery(key, {
    enabled: visible && !!key,
    // A chart load can persist other workspace facts during this versioned read.
    // Retry the read once; plan mutations keep their original version fence.
    retry: 1,
  });
  const prepare = api.prepareScreenPlan.useMutation({
    onSuccess: (c) =>
      router.push(
        `/scan?symbol=${encodeURIComponent(c.symbol)}&adjustment=none&candidate=${encodeURIComponent(c.key)}`,
        { scroll: false },
      ),
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
  return (
    <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[180px_minmax(0,1fr)]">
      <aside className="space-y-3 rounded-lg border bg-nc-card p-3">
        <h2 className="font-semibold">策略或公式</h2>
        <Select
          value={strategy || "all"}
          onValueChange={(v) => {
            setStrategy(v === "all" ? "" : v);
            setPage(0);
          }}
        >
          <SelectTrigger aria-label="扫描策略">
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
        {definitions.error && <p role="alert">{definitions.error.message}</p>}
        {market === "cn-equity" && (
          <>
            <label className="block text-sm">
              最低 RPS20
              <Input
                aria-label="最低 RPS20"
                type="number"
                min="0"
                max="100"
                value={rps}
                onChange={(e) => {
                  setRps(e.target.value);
                  setPage(0);
                }}
              />
            </label>
            <p className="text-xs text-nc-text-3">
              后复权排名，空白不过滤；无排名不补零。
            </p>
            <a className="block text-sm underline" href="/scan?tab=formula">
              选择或编辑公式
            </a>
          </>
        )}
        <p className="text-xs text-nc-text-3">
          结果来自统一引擎最近收盘扫描与影子观察。研究中候选仅供核对。
        </p>
      </aside>
      <div className="grid min-w-0 items-start gap-4">
        <section className="min-w-0 rounded-lg border bg-nc-card p-3 [&_table]:table-fixed [&_td]:whitespace-normal [&_td_p]:break-all [&_th]:whitespace-normal [&_th:first-child]:w-[30%] [&_th:nth-child(2)]:w-[25%]">
          <h2 className="mb-2 font-semibold">结果列表</h2>
          <CandidateTable
            data={rows.data?.items ?? []}
            total={rows.data?.total ?? 0}
            page={page}
            onPage={setPage}
            loading={rows.isLoading}
            error={rows.error?.message}
            onRetry={() => void rows.refetch()}
            onSelect={(r) => router.push(candidateHref(r), { scroll: false })}
          />
        </section>
        <section aria-label="候选图表" className="min-w-0 space-y-3">
          {selected.error && (
            <p role="alert">候选读取失败：{selected.error.message}</p>
          )}
          {market === "cn-equity" && search.has("screenSnapshot") && (
            <div className="rounded border bg-nc-card p-3">
              <p className="text-sm text-nc-warn">
                公式候选 ·
                研究中。原公式未指定保护位，加入计划时须明确止损与目标。
              </p>
              <Button
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
          )}
          {candidate && (
            <>
              <div className="rounded border bg-nc-card p-3 text-sm">
                <strong
                  className={
                    candidate.qualification === "promoted"
                      ? "text-nc-ok"
                      : "text-nc-warn"
                  }
                >
                  {qualificationLabel[candidate.qualification]}
                </strong>{" "}
                · {candidate.strategyId}
                <p>
                  入场 {formatNumber(candidate.price)} · 止损{" "}
                  {formatNumber(candidate.stop)} · 目标{" "}
                  {formatNumber(candidate.target)} · 参考线均为原价
                </p>
              </div>
              <CandidatePlan key={candidate.key} candidate={candidate} />
            </>
          )}
          <PlanLevelsProvider value={levels}>
            {market === "crypto" ? <Crypto /> : <Market embedded />}
          </PlanLevelsProvider>
        </section>
      </div>
    </div>
  );
}
