"use client";
import { useState } from "react";
import { strategyCategories } from "trading-strategies";
import { api } from "~/trpc/react";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "../../ui/select";
import {
  useAccumulatedPages,
  useIntersectionLoadMore,
  useTablePage,
} from "../../ui/use-infinite-table";

export function MethodRegistryWorkspace({
  panelVisible,
  active,
}: {
  panelVisible: boolean;
  active: boolean;
}) {
  const [methodQuery, setMethodQuery] = useState("");
  const [methodCategory, setMethodCategory] = useState("");
  const resetKey = JSON.stringify([methodQuery, methodCategory]);
  const pager = useTablePage(resetKey);
  const methods = api.strategyCenterMethods.useQuery(
    {
      query: methodQuery,
      page: pager.pageIndex,
      category: methodCategory || undefined,
    },
    { enabled: panelVisible && active },
  );
  const batches = useAccumulatedPages({
    pageIndex: pager.pageIndex,
    items: methods.data?.methods,
    total: methods.data?.total,
    resetKey,
    getKey: (m) => m.id,
    isSuccess: methods.isSuccess,
    pageSize: 20,
  });
  const sentinel = useIntersectionLoadMore({
    enabled: panelVisible && active && batches.hasMore && !methods.isError,
    loading: methods.isFetching,
    onLoadMore: pager.loadMore,
  });
  return (
    <>
      <section className="space-y-3 rounded border p-4">
        <h2 className="font-medium">
          已有完整方法清单 · {methods.data?.total ?? "—"}项
        </h2>
        <p className="text-xs text-muted-foreground">
          包含参数变体、风控与研究工具，保留原实现和边界说明；不计作独立可执行策略。
        </p>
        <Input
          aria-label="搜索已有方法"
          placeholder="方法ID或名称"
          value={methodQuery}
          onChange={(event) => setMethodQuery(event.target.value)}
        />
        <Select
          value={methodCategory || "all"}
          onValueChange={(value) =>
            setMethodCategory(value === "all" ? "" : value)
          }
        >
          <SelectTrigger aria-label="已有方法分类">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部方法分类</SelectItem>
            {strategyCategories.map((category) => (
              <SelectItem key={category.id} value={category.id}>
                {category.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {batches.rows.map((method) => (
          <details key={method.id} className="rounded border p-2">
            <summary>
              {method.id} · {method.title}
            </summary>
            <p className="text-xs text-muted-foreground">
              {strategyCategories.find((c) => c.id === method.category)?.name} ·{" "}
              {
                {
                  rule: "规则组件",
                  "risk-policy": "风控政策",
                  analysis: "研究分析",
                  "data-tool": "数据工具",
                }[method.kind]
              }
            </p>
            <p className="my-2 text-xs">{method.boundary}</p>
            <p className="break-all text-xs text-muted-foreground">
              实现：{method.implementation.join("、")}
            </p>
          </details>
        ))}
        <div ref={sentinel} aria-hidden="true" className="h-px" />
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span>
            已加载 {batches.rows.length} / {batches.total} 项
          </span>
          {batches.hasMore && (
            <Button
              variant="outline"
              size="sm"
              disabled={methods.isFetching}
              onClick={pager.loadMore}
            >
              {methods.isFetching ? "加载中…" : "加载更多"}
            </Button>
          )}
        </div>
      </section>
      {methods.error && (
        <p role="alert">
          方法登记读取失败：{methods.error.message}
          <Button variant="outline" onClick={() => void methods.refetch()}>
            重读方法登记
          </Button>
        </p>
      )}
    </>
  );
}
