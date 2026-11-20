"use client";

import { useState, type ReactNode } from "react";
import type { CostMethod } from "~/lib/portfolio/trade-review";
import type {
  NavDetailRow,
  NavPageKind,
} from "~/server/portfolio/trade-review-nav-page";
import { api } from "~/trpc/react";
import { useTaskVisible } from "../workbench/use-task-visible";
import { Button } from "../ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../ui/collapsible";
import {
  useIntersectionLoadMore,
  useTablePage,
} from "../ui/use-infinite-table";

type Page<K extends NavPageKind> = {
  pageIndex: number;
  pageSize: number;
  total: number;
  rows: NavDetailRow<K>[];
};

/**
 * A long review detail list read a page at a time: the first page arrives with
 * the review, later pages are fetched when the user turns to them.
 */
export function PagedDetail<K extends NavPageKind>({
  account,
  method,
  kind,
  first,
  label,
  preview = 0,
  empty,
  render,
}: {
  account: string;
  method: CostMethod;
  kind: K;
  first: Page<K>;
  /** Shown with the total count. */
  label: string;
  /** Rows of the first page shown above the collapsed list. */
  preview?: number;
  empty?: ReactNode;
  render: (row: NavDetailRow<K>, index: number) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const pager = useTablePage(JSON.stringify([account, method, kind]));
  const loaded = Math.min((pager.pageIndex + 1) * first.pageSize, first.total);
  const hasMore = loaded < first.total;
  const sentinel = useIntersectionLoadMore({
    enabled: open && hasMore,
    loading: false,
    onLoadMore: pager.loadMore,
  });
  if (!first.total) return <>{empty ?? null}</>;
  return (
    <>
      <div>{first.rows.slice(0, preview).map((row, i) => render(row, i))}</div>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <Button variant="outline">
            {label}，共 {first.total} 条 · {open ? "收起" : "展开查看"}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-2 pt-2">
          {first.rows.map((row, i) => render(row, i))}
          {Array.from({ length: pager.pageIndex }, (_, idx) => (
            <RemotePage
              key={idx + 1}
              account={account}
              method={method}
              kind={kind}
              pageIndex={idx + 1}
              render={render}
            />
          ))}
          <div ref={sentinel} aria-hidden="true" className="h-px" />
          {first.total > first.pageSize && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>
                已加载 {loaded} / 共 {first.total} 条
              </span>
              {hasMore && (
                <Button variant="outline" size="sm" onClick={pager.loadMore}>
                  加载更多
                </Button>
              )}
            </div>
          )}
        </CollapsibleContent>
      </Collapsible>
    </>
  );
}

/** Pages after the first: the only part that talks to the server. */
function RemotePage<K extends NavPageKind>({
  account,
  method,
  kind,
  pageIndex,
  render,
}: {
  account: string;
  method: CostMethod;
  kind: K;
  pageIndex: number;
  render: (row: NavDetailRow<K>, index: number) => ReactNode;
}) {
  const visible = useTaskVisible();
  const page = api.tradeReviewNavPage.useQuery(
    { account, method, kind, pageIndex },
    { enabled: visible, staleTime: 60000 },
  );
  const data = page.data as Page<K> | undefined;
  return (
    <>
      {page.isFetching && <p role="status">正在读取第 {pageIndex + 1} 页…</p>}
      {page.error && (
        <p role="alert">
          {page.error.message}{" "}
          <Button variant="plain" onClick={() => void page.refetch()}>
            重试
          </Button>
        </p>
      )}
      {data?.rows.map((row, i) =>
        render(row, data.pageIndex * data.pageSize + i),
      )}
    </>
  );
}
