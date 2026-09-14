"use client";

import { useState } from "react";
import type { PaginationState, SortingState } from "@tanstack/react-table";
import { api, type RouterInputs } from "~/trpc/react";
import { ExecutionQualityResults } from "./execution-quality-results";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import {
  executionDiagnosticCategories,
  executionDiagnosticLabels,
} from "~/lib/execution-quality";

export function ExecutionQualityContainer({ account }: { account: string }) {
  const utils = api.useUtils();
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 10,
  });
  const [groupPagination, setGroupPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 10,
  });
  const [sorting, setSorting] = useState<SortingState>([
    { id: "tradeDate", desc: false },
  ]);
  const [filters, setFilters] = useState({
    search: "",
    side: "all" as "all" | "buy" | "sell",
    adverseOnly: false,
    diagnostic: "all" as RouterInputs["tradeReviewExecution"]["diagnostic"],
    start: "",
    end: "",
    minAmount: 0,
    group: "code" as "code" | "kind" | "month",
  });
  const [exporting, setExporting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const change = (patch: Partial<typeof filters>) => {
    setFilters((v) => ({ ...v, ...patch }));
    setPagination((p) => ({ ...p, pageIndex: 0 }));
    setGroupPagination({ pageIndex: 0, pageSize: 10 });
  };
  const input = {
    account,
    ...filters,
    ...pagination,
    sort: sorting[0]?.id as RouterInputs["tradeReviewExecution"]["sort"],
    desc: sorting[0]?.desc ?? false,
    groupPageIndex: groupPagination.pageIndex,
  };
  const query = api.tradeReviewExecution.useQuery(input, { retry: false });
  return (
    <section className="space-y-4" aria-label="执行质量">
      <h2 className="text-lg font-semibold">执行质量</h2>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <Label htmlFor="execution-search">标的搜索</Label>
          <Input
            id="execution-search"
            value={filters.search}
            onChange={(e) => change({ search: e.target.value })}
          />
        </div>
        <div>
          <Label htmlFor="execution-start">开始日期</Label>
          <Input
            id="execution-start"
            type="date"
            value={filters.start}
            onChange={(e) => change({ start: e.target.value })}
          />
        </div>
        <div>
          <Label htmlFor="execution-end">结束日期</Label>
          <Input
            id="execution-end"
            type="date"
            value={filters.end}
            onChange={(e) => change({ end: e.target.value })}
          />
        </div>
        <div>
          <Label htmlFor="execution-amount">最低成交额（元）</Label>
          <Input
            id="execution-amount"
            type="number"
            min={0}
            value={filters.minAmount}
            onChange={(e) =>
              change({ minAmount: Math.max(0, Number(e.target.value) || 0) })
            }
          />
        </div>
        <Button
          variant={filters.adverseOnly ? "default" : "outline"}
          aria-pressed={filters.adverseOnly}
          onClick={() => change({ adverseOnly: !filters.adverseOnly })}
        >
          日均价不利偏差 &gt; 5 BP
        </Button>
        <Button
          variant="outline"
          disabled={
            exporting || query.isFetching || !query.data || !!query.error
          }
          onClick={async () => {
            setExporting(true);
            setError("");
            setMessage("");
            try {
              const csv = await utils.tradeReviewExecutionExport.fetch(input, {
                staleTime: 0,
              });
              const url = URL.createObjectURL(
                new Blob([csv], { type: "text/csv;charset=utf-8" }),
              );
              const link = document.createElement("a");
              link.href = url;
              link.download = "执行质量.csv";
              try {
                document.body.appendChild(link);
                link.click();
                setMessage("已导出全部筛选成交（不限当前页），账号已脱敏。");
              } finally {
                link.remove();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              }
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setExporting(false);
            }
          }}
        >
          {exporting ? "正在导出…" : "导出 CSV"}
        </Button>
      </div>
      <Tabs
        value={filters.diagnostic}
        onValueChange={(diagnostic) =>
          change({ diagnostic: diagnostic as typeof filters.diagnostic })
        }
      >
        <TabsList aria-label="偏差诊断筛选" className="h-auto flex-wrap">
          <TabsTrigger value="all">全部诊断</TabsTrigger>
          {executionDiagnosticCategories.map((category) => (
            <TabsTrigger key={category} value={category}>
              {executionDiagnosticLabels[category]}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <Tabs
        value={filters.side}
        onValueChange={(side) => change({ side: side as typeof filters.side })}
      >
        <TabsList aria-label="成交方向">
          <TabsTrigger value="all">全部方向</TabsTrigger>
          <TabsTrigger value="buy">买入</TabsTrigger>
          <TabsTrigger value="sell">卖出</TabsTrigger>
        </TabsList>
      </Tabs>
      <Tabs
        value={filters.group}
        onValueChange={(group) =>
          change({ group: group as typeof filters.group })
        }
      >
        <TabsList aria-label="执行质量分组">
          <TabsTrigger value="code">按标的</TabsTrigger>
          <TabsTrigger value="kind">按方向</TabsTrigger>
          <TabsTrigger value="month">按月</TabsTrigger>
        </TabsList>
      </Tabs>
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
      {query.isFetching && <p role="status">正在计算执行质量…</p>}
      {query.error ? (
        <div role="alert">
          {query.error.message}
          <Button onClick={() => void query.refetch()}>重试执行质量</Button>
        </div>
      ) : (
        query.data && (
          <ExecutionQualityResults
            data={query.data}
            table={{
              pagination,
              sorting,
              onPaginationChange: setPagination,
              onSortingChange: (value) => {
                setSorting(value);
                setPagination((p) => ({ ...p, pageIndex: 0 }));
              },
              loading: query.isFetching,
            }}
            groupTable={{
              pagination: groupPagination,
              sorting: [],
              onPaginationChange: setGroupPagination,
              onSortingChange: () => {},
              loading: query.isFetching,
            }}
          />
        )
      )}
    </section>
  );
}
