"use client";

import { useState, type ReactNode } from "react";
import type { CostMethod } from "~/lib/portfolio/trade-review";
import type {
  NavDetailRow,
  NavPageKind,
} from "~/server/portfolio/trade-review-nav-page";
import { api } from "~/trpc/react";
import { Button } from "../ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../ui/collapsible";

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
  const [pageIndex, setPageIndex] = useState(0);
  const pages = Math.max(1, Math.ceil(first.total / first.pageSize));
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
          {pageIndex === 0 ? (
            first.rows.map((row, i) => render(row, i))
          ) : (
            <RemotePage
              account={account}
              method={method}
              kind={kind}
              pageIndex={pageIndex}
              render={render}
            />
          )}
          {pages > 1 && (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={pageIndex === 0}
                onClick={() => setPageIndex((p) => Math.max(0, p - 1))}
              >
                上一页
              </Button>
              <span className="text-xs">
                第 {pageIndex + 1} / {pages} 页
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={pageIndex + 1 >= pages}
                onClick={() => setPageIndex((p) => p + 1)}
              >
                下一页
              </Button>
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
  const page = api.tradeReviewNavPage.useQuery(
    { account, method, kind, pageIndex },
    { staleTime: 60000 },
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
