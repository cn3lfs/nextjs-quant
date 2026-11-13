"use client";

import { Scales } from "@phosphor-icons/react/ssr";
import { PageGrid, Panel, Segmented } from "../panels";
import { PanelVisibility } from "../workbench/keep-alive";
import { useEffect, useRef, useState } from "react";
import type { PaginationState, SortingState } from "@tanstack/react-table";
import { api, type RouterInputs } from "~/trpc/react";
import type { CostMethod } from "~/lib/portfolio/trade-review";
import { DeliveryWorkspace } from "./delivery-workspace";
import { TradeReviewResults } from "./trade-review-results";
import { KeyTradesResults } from "./key-trades-results";
import { PositionRiskContainer } from "../backtest/position-risk-container";
import { RollingPerformanceContainer } from "../backtest/rolling-performance-container";
import { PeriodPerformanceContainer } from "../backtest/period-performance-container";
import { StrategyAdmissionContainer } from "../research/strategy-admission-container";
import { ExecutionQualityContainer } from "./execution-quality-container";
import { CashReconciliationContainer } from "./cash-reconciliation-container";
import { DisciplineContainer } from "./discipline-container";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

const reviewSections = [
  { value: "overview", label: "概览" },
  { value: "rounds", label: "交易轮次" },
  { value: "periods", label: "分段表现" },
  { value: "rolling", label: "滚动表现" },
  { value: "risk", label: "持仓风险" },
  { value: "execution", label: "执行质量" },
  { value: "cash", label: "现金核对" },
  { value: "discipline", label: "纪律与准入" },
] as const;
type ReviewSection = (typeof reviewSections)[number]["value"];
export function TradeReviewContainer() {
  const [workspace, setWorkspace] = useState<"import" | "batches" | "review">(
    "import",
  );
  const [deliveryView, setDeliveryView] = useState<"import" | "batches">(
    "import",
  );
  const [section, setSection] = useState<ReviewSection>("overview");
  const [disciplineView, setDisciplineView] = useState<
    "admission" | "discipline"
  >("admission");
  const utils = api.useUtils();
  const [batchRevision, setBatchRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [accountDraft, setAccountDraft] = useState("");
  const [account, setAccount] = useState("");
  const currentAccount = useRef(account);
  currentAccount.current = account;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [cashBatch, setCashBatch] = useState<{
    id: string;
    revision: number;
    /** Where the batch was opened from, for the return button. */
    from?: "cash" | "execution";
  } | null>(null);
  const cashReturn = useRef({ id: "", scroll: 0 });
  const [keyTradesN, setKeyTradesN] = useState(3);
  const [method, setMethod] = useState<CostMethod>("movingAverage");
  const [monthSorting, setMonthSorting] = useState<SortingState>([]);
  const [monthPagination, setMonthPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 12,
  });
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 20,
  });
  const [sorting, setSorting] = useState<SortingState>([
    { id: "openingDate", desc: false },
  ]);
  const [pointPagination, setPointPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 10,
  });
  const [pointSorting, setPointSorting] = useState<SortingState>([
    { id: "fillIndex", desc: false },
  ]);
  const [attributionPagination, setAttributionPagination] =
    useState<PaginationState>({ pageIndex: 0, pageSize: 10 });
  const [attributionSorting, setAttributionSorting] = useState<SortingState>([
    { id: "dimension", desc: false },
  ]);
  const [drawdownsOpen, setDrawdownsOpen] = useState(false);
  const [drawdownPagination, setDrawdownPagination] = useState<PaginationState>(
    { pageIndex: 0, pageSize: 10 },
  );
  const [drawdownSorting, setDrawdownSorting] = useState<SortingState>([
    { id: "drawdown", desc: true },
  ]);
  const resetDetailPages = () => {
    setDrawdownsOpen(false);
    setDrawdownPagination((p) => ({ ...p, pageIndex: 0 }));
    setPointPagination((p) => ({ ...p, pageIndex: 0 }));
    setAttributionPagination((p) => ({ ...p, pageIndex: 0 }));
    setMonthPagination((p) => ({ ...p, pageIndex: 0 }));
  };
  const review = api.tradeReviewSnapshot.useQuery(
    {
      account,
      method,
      keyTradesN,
      ...pagination,
      pointPageIndex: pointPagination.pageIndex,
      pointPageSize: pointPagination.pageSize,
      pointSort: pointSorting[0]
        ?.id as RouterInputs["tradeReviewSnapshot"]["pointSort"],
      pointDesc: pointSorting[0]?.desc ?? false,
      attributionPageIndex: attributionPagination.pageIndex,
      attributionPageSize: attributionPagination.pageSize,
      attributionSort: attributionSorting[0]
        ?.id as RouterInputs["tradeReviewSnapshot"]["attributionSort"],
      attributionDesc: attributionSorting[0]?.desc ?? false,
      drawdownPageIndex: drawdownPagination.pageIndex,
      drawdownPageSize: drawdownPagination.pageSize,
      drawdownSort: drawdownSorting[0]
        ?.id as RouterInputs["tradeReviewSnapshot"]["drawdownSort"],
      drawdownDesc: drawdownSorting[0]?.desc ?? true,
      monthPageIndex: monthPagination.pageIndex,
      monthOrder: monthSorting[0]
        ? { id: monthSorting[0].id, desc: monthSorting[0].desc }
        : null,
      sort: sorting[0]?.id as RouterInputs["tradeReviewSnapshot"]["sort"],
      desc: sorting[0]?.desc ?? false,
    },
    { enabled: !!account, retry: false },
  );
  const run = async (work: () => Promise<void>) => {
    if (lock.current) return false;
    lock.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const refresh = async (changedAccount: string) => {
    await utils.deliveryBatchPage.invalidate();
    if (changedAccount !== account) return;
    setBatchRevision((value) => value + 1);
    await Promise.all([
      utils.tradeReviewSnapshot.invalidate(),
      utils.tradeReviewPeriodPerformance.invalidate(),
      utils.tradeReviewRollingPerformance.invalidate(),
      utils.tradeReviewPositionRisk.invalidate(),
      utils.tradeReviewHoldingsCorrelation.invalidate(),
      utils.tradeReviewAdmission.invalidate(),
      utils.tradeReviewAdmissionExport.invalidate(),
      utils.tradeReviewExecution.invalidate(),
      utils.tradeReviewCashReconciliation.invalidate(),
      utils.cashWorkspace.invalidate({ account }),
    ]);
  };
  return (
    <PageGrid>
      <div className="nc-span-12">
        <Segmented
          label="交割复盘工作区"
          value={workspace}
          onChange={(next) => {
            setWorkspace(next);
            if (next !== "review") setDeliveryView(next);
          }}
          options={[
            { value: "import", label: "导入文件" },
            { value: "batches", label: "历史批次" },
            { value: "review", label: "账户复盘" },
          ]}
        />
      </div>
      {error && (
        <p
          role="alert"
          className="notice nc-span-12 m-0 border-nc-bad-edge text-nc-bad"
        >
          {error}。请核对后重试。
        </p>
      )}
      {message && (
        <p role="status" className="nc-span-12 m-0 text-[13px] text-nc-ok">
          {message}
        </p>
      )}
      <PanelVisibility visible={workspace !== "review"}>
        <div
          hidden={workspace === "review"}
          id="cash-delivery-workspace"
          className="nc-span-12 min-w-0"
        >
          <DeliveryWorkspace
            view={deliveryView}
            onViewChange={(next) => {
              setDeliveryView(next);
              setWorkspace(next);
            }}
            cashBatch={cashBatch}
            returnLabel={
              cashBatch?.from === "execution"
                ? "返回执行质量"
                : "返回现金核对证据"
            }
            onReturnToCash={() => {
              setWorkspace("review");
              setSection(
                cashBatch?.from === "execution" ? "execution" : "cash",
              );
              const from = cashBatch?.from;
              setCashBatch(null);
              requestAnimationFrame(() => {
                const target =
                  document.getElementById(cashReturn.current.id) ??
                  document.querySelector<HTMLElement>(
                    from === "execution"
                      ? 'section[aria-label="成交依据"] h3'
                      : 'section[aria-label="现金核对"] h2',
                  );
                target?.focus({ preventScroll: true });
                window.scrollTo({ top: cashReturn.current.scroll });
              });
            }}
            onSaved={refresh}
            onReview={(next) => {
              setWorkspace("review");
              setSection("overview");
              setCashBatch(null);
              setAccountDraft(next);
              setAccount(next);
              resetDetailPages();
              setPagination((value) => ({ ...value, pageIndex: 0 }));
            }}
          />
        </div>
      </PanelVisibility>
      <PanelVisibility visible={workspace === "review"}>
        <div hidden={workspace !== "review"} className="nc-span-12 min-w-0">
          <Panel icon={Scales} title="账户复盘" bodyClassName="space-y-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-2">
                <Label htmlFor="review-account">复盘账户别名</Label>
                <Input
                  id="review-account"
                  value={accountDraft}
                  maxLength={64}
                  disabled={busy}
                  onChange={(e) => setAccountDraft(e.target.value)}
                />
              </div>
              <Button
                disabled={busy || !accountDraft.trim()}
                onClick={() => {
                  const next = accountDraft.trim();
                  if (next !== account) setCashBatch(null);
                  setPagination((p) => ({ ...p, pageIndex: 0 }));
                  setAccount(next);
                  resetDetailPages();
                  setMonthPagination((p) => ({ ...p, pageIndex: 0 }));
                  if (next === account) void review.refetch();
                }}
              >
                查看复盘
              </Button>
              <Button
                variant="outline"
                disabled={busy || !account || review.isFetching || !review.data}
                onClick={() => {
                  void run(async () => {
                    const exportAccount = account;
                    const json = await utils.tradeReviewExport.fetch(
                      { account: exportAccount },
                      { staleTime: 0 },
                    );
                    if (
                      !mounted.current ||
                      currentAccount.current !== exportAccount
                    )
                      return;
                    const url = URL.createObjectURL(
                      new Blob([json], {
                        type: "application/json;charset=utf-8",
                      }),
                    );
                    const link = document.createElement("a");
                    link.href = url;
                    link.download = `交易复盘-${account.replace(/[<>:"/\\|?*]/g, "_")}.json`;
                    try {
                      document.body.appendChild(link);
                      link.click();
                      setMessage("已生成完整复盘 JSON。");
                    } finally {
                      link.remove();
                      setTimeout(() => URL.revokeObjectURL(url), 1000);
                    }
                  });
                }}
              >
                导出全账户完整JSON
              </Button>
            </div>
            {account && (
              <p role="status" className="text-[13px] text-muted-foreground">
                当前查询账户：{account}
                {accountDraft.trim() !== account
                  ? " · 输入已更改，点击查看复盘后生效"
                  : ""}
              </p>
            )}
            {!account && <p>输入已导入的账户别名后查看复盘。</p>}
            <fieldset disabled={!account}>
              <Segmented
                label="账户复盘分析区"
                value={section}
                onChange={setSection}
                options={reviewSections}
              />
            </fieldset>
            <div hidden={section !== "overview" && section !== "rounds"}>
              {review.isFetching && (
                <p role="status">正在读取行情并计算复盘…</p>
              )}
              {review.error && (
                <div role="alert">
                  {review.error.message}
                  <Button
                    variant="outline"
                    onClick={() => void review.refetch()}
                  >
                    重试复盘
                  </Button>
                </div>
              )}
            </div>
            <PanelVisibility
              visible={section === "overview" || section === "rounds"}
            >
              <div hidden={section !== "overview" && section !== "rounds"}>
                {review.data && !review.error && (
                  <TradeReviewResults
                    section={section === "rounds" ? "rounds" : "overview"}
                    roundExtras={
                      <KeyTradesResults
                        data={review.data.keyTrades}
                        onNChange={setKeyTradesN}
                        loading={review.isFetching}
                      />
                    }
                    data={review.data}
                    drawdownsOpen={drawdownsOpen}
                    onDrawdownsOpenChange={(open) => {
                      setDrawdownsOpen(open);
                      if (!open)
                        setDrawdownPagination({ pageIndex: 0, pageSize: 10 });
                    }}
                    drawdownTable={{
                      pagination: drawdownPagination,
                      sorting: drawdownSorting,
                      onPaginationChange: setDrawdownPagination,
                      onSortingChange: (value) => {
                        setDrawdownSorting(value);
                        setDrawdownPagination((p) => ({ ...p, pageIndex: 0 }));
                      },
                    }}
                    pointTable={{
                      pagination: pointPagination,
                      sorting: pointSorting,
                      onPaginationChange: setPointPagination,
                      onSortingChange: (value) => {
                        setPointSorting(value);
                        setPointPagination((p) => ({ ...p, pageIndex: 0 }));
                      },
                    }}
                    attributionTable={{
                      pagination: attributionPagination,
                      sorting: attributionSorting,
                      onPaginationChange: setAttributionPagination,
                      onSortingChange: (value) => {
                        setAttributionSorting(value);
                        setAttributionPagination((p) => ({
                          ...p,
                          pageIndex: 0,
                        }));
                      },
                    }}
                    method={method}
                    onMethodChange={(value) => {
                      setMethod(value);
                      resetDetailPages();
                      setPagination((p) => ({ ...p, pageIndex: 0 }));
                    }}
                    pagination={pagination}
                    monthPagination={monthPagination}
                    onMonthPaginationChange={setMonthPagination}
                    monthSorting={monthSorting}
                    onMonthSortingChange={(value) => {
                      setMonthSorting(value);
                      setMonthPagination((p) => ({ ...p, pageIndex: 0 }));
                    }}
                    sorting={sorting}
                    onPaginationChange={setPagination}
                    onSortingChange={(value) => {
                      setSorting(value);
                      setPagination((p) => ({ ...p, pageIndex: 0 }));
                    }}
                    loading={review.isFetching}
                  />
                )}
              </div>
            </PanelVisibility>
            {account && (
              <>
                <PanelVisibility visible={section === "periods"}>
                  <div
                    hidden={section !== "periods"}
                    className="min-w-0 space-y-4"
                  >
                    <PeriodPerformanceContainer
                      key={`${account}:${batchRevision}`}
                      source={{ account }}
                    />
                  </div>
                </PanelVisibility>
                <PanelVisibility visible={section === "rolling"}>
                  <div
                    hidden={section !== "rolling"}
                    className="min-w-0 space-y-4"
                  >
                    <RollingPerformanceContainer
                      key={`rolling:${account}:${batchRevision}`}
                      source={{ account }}
                    />
                  </div>
                </PanelVisibility>
                <PanelVisibility visible={section === "risk"}>
                  <div
                    hidden={section !== "risk"}
                    className="min-w-0 space-y-4"
                  >
                    <PositionRiskContainer
                      key={`position-risk:${account}:${batchRevision}`}
                      account={account}
                    />
                  </div>
                </PanelVisibility>
                <PanelVisibility visible={section === "execution"}>
                  <div
                    hidden={section !== "execution"}
                    className="min-w-0 space-y-4"
                  >
                    {account && (
                      <ExecutionQualityContainer
                        key={`${account}:${batchRevision}`}
                        account={account}
                        onBatch={(id) => {
                          setDeliveryView("batches");
                          setWorkspace("batches");
                          cashReturn.current = {
                            id: document.activeElement?.id ?? "",
                            scroll: window.scrollY,
                          };
                          setCashBatch((value) => ({
                            id,
                            revision: (value?.revision ?? 0) + 1,
                            from: "execution",
                          }));
                          requestAnimationFrame(() =>
                            document
                              .getElementById("cash-delivery-workspace")
                              ?.scrollIntoView({ block: "start" }),
                          );
                        }}
                      />
                    )}
                  </div>
                </PanelVisibility>
                <PanelVisibility visible={section === "cash"}>
                  <div
                    hidden={section !== "cash"}
                    className="min-w-0 space-y-4"
                  >
                    {account && (
                      <CashReconciliationContainer
                        key={`cash:${account}`}
                        account={account}
                        onBatch={(id) => {
                          setDeliveryView("batches");
                          setWorkspace("batches");
                          cashReturn.current = {
                            id: document.activeElement?.id ?? "",
                            scroll: window.scrollY,
                          };
                          setCashBatch((value) => ({
                            id,
                            revision: (value?.revision ?? 0) + 1,
                          }));
                          requestAnimationFrame(() =>
                            document
                              .getElementById("cash-delivery-workspace")
                              ?.scrollIntoView({ block: "start" }),
                          );
                        }}
                      />
                    )}
                  </div>
                </PanelVisibility>
                <PanelVisibility visible={section === "discipline"}>
                  <div
                    hidden={section !== "discipline"}
                    className="min-w-0 space-y-4"
                  >
                    <Segmented
                      label="纪律与准入视图"
                      value={disciplineView}
                      onChange={setDisciplineView}
                      options={[
                        { value: "admission", label: "准入判定" },
                        { value: "discipline", label: "纪律反事实" },
                      ]}
                    />
                    <PanelVisibility visible={disciplineView === "admission"}>
                      <div hidden={disciplineView !== "admission"}>
                        <StrategyAdmissionContainer
                          key={`admission:${account}:${batchRevision}`}
                          source={{ account }}
                        />
                      </div>
                    </PanelVisibility>
                    <PanelVisibility visible={disciplineView === "discipline"}>
                      <div hidden={disciplineView !== "discipline"}>
                        {account && (
                          <DisciplineContainer
                            key={`discipline:${account}:${batchRevision}`}
                            account={account}
                          />
                        )}
                      </div>
                    </PanelVisibility>
                  </div>
                </PanelVisibility>
              </>
            )}
          </Panel>
        </div>
      </PanelVisibility>
    </PageGrid>
  );
}
