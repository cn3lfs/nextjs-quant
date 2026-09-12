"use client";

import { useState } from "react";
import type { PaginationState, SortingState } from "@tanstack/react-table";
import { api, type RouterInputs } from "~/trpc/react";
import { rollingPerformanceDefaults } from "~/lib/rolling-performance";
import type { PerformanceBasis } from "~/lib/daily-performance";
import { RollingPerformanceResults } from "./rolling-performance-results";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";

export function RollingPerformanceContainer({
  source,
}: {
  source:
    | { account: string }
    | { id: string; partition: "development" | "validation" };
}) {
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 10,
  });
  const [sorting, setSorting] = useState<SortingState>([
    { id: "endDate", desc: true },
  ]);
  const [basis, setBasis] = useState<PerformanceBasis>("compound");
  const [windowText, setWindowText] = useState(
    String(rollingPerformanceDefaults.window),
  );
  const [minText, setMinText] = useState("");
  const [settings, setSettings] = useState<{
    window: number;
    minPeriods?: number;
  }>({ window: rollingPerformanceDefaults.window });
  const [error, setError] = useState("");
  const page = {
    ...pagination,
    ...settings,
    basis,
    sort: (sorting[0]?.id ??
      "endDate") as RouterInputs["tradeReviewRollingPerformance"]["sort"],
    desc: sorting[0]?.desc ?? true,
  };
  const account = "account" in source;
  const trade = api.tradeReviewRollingPerformance.useQuery(
    { ...page, account: account ? source.account : "" },
    { enabled: account, retry: false },
  );
  const research = api.strategyResearchRollingPerformance.useQuery(
    {
      ...page,
      id: account ? "" : source.id,
      partition: account ? "development" : source.partition,
    },
    { enabled: !account, retry: false },
  );
  const query = account ? trade : research;
  const resetPage = () => setPagination((p) => ({ ...p, pageIndex: 0 }));
  return (
    <section aria-label="滚动绩效" className="space-y-3">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          const window = Number(windowText),
            minPeriods = minText.trim() ? Number(minText) : window;
          if (
            !Number.isInteger(window) ||
            window < 1 ||
            window > 1000000 ||
            !Number.isInteger(minPeriods) ||
            minPeriods < 1 ||
            minPeriods > window
          ) {
            setError(
              "请输入正整数：窗口最多 1000000 个交易日，最少日数不能超过窗口。",
            );
            return;
          }
          setError("");
          setSettings({ window, minPeriods });
          resetPage();
        }}
      >
        <label>
          滚动窗口（交易日）
          <Input
            type="number"
            min={1}
            max={1000000}
            value={windowText}
            onChange={(e) => setWindowText(e.target.value)}
          />
        </label>
        <label>
          最少交易日数（留空等于窗口）
          <Input
            type="number"
            min={1}
            value={minText}
            onChange={(e) => setMinText(e.target.value)}
          />
        </label>
        <Button type="submit">应用窗口</Button>
      </form>
      {error && <p role="alert">{error}</p>}
      <Tabs
        value={basis}
        onValueChange={(value) => {
          setBasis(value as PerformanceBasis);
          resetPage();
        }}
      >
        <TabsList aria-label="滚动收益口径">
          <TabsTrigger value="compound">复利</TabsTrigger>
          <TabsTrigger value="simple">单利对照</TabsTrigger>
        </TabsList>
      </Tabs>
      {query.isLoading && <p role="status">正在计算滚动绩效…</p>}
      {query.error ? (
        <div role="alert">
          <p>{query.error.message}</p>
          <Button onClick={() => void query.refetch()}>重新读取滚动绩效</Button>
        </div>
      ) : (
        query.data && (
          <RollingPerformanceResults
            data={query.data}
            table={{
              pagination,
              sorting,
              onPaginationChange: setPagination,
              onSortingChange: (update) => {
                setSorting(update);
                resetPage();
              },
              loading: query.isFetching,
            }}
          />
        )
      )}
    </section>
  );
}
