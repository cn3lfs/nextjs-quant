"use client";

import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/** An input change and its first page take effect in the same render. */
export function useTablePage(resetKey: string) {
  const [cursor, setCursor] = useState({ resetKey, pageIndex: 0 });
  if (cursor.resetKey !== resetKey) setCursor({ resetKey, pageIndex: 0 });
  const pageIndex = cursor.resetKey === resetKey ? cursor.pageIndex : 0;
  return {
    pageIndex,
    loadMore: () =>
      setCursor((current) =>
        current.resetKey === resetKey && current.pageIndex === pageIndex
          ? { resetKey, pageIndex: pageIndex + 1 }
          : current,
      ),
    restart: () =>
      setCursor((current) =>
        current.resetKey === resetKey && current.pageIndex !== 0
          ? { resetKey, pageIndex: 0 }
          : current,
      ),
  };
}

type Page<T> = {
  items: readonly T[];
  total: number;
  snapshotKey?: string | number | null;
};

/** Supply items from the successful observer for this exact query key.
 * Placeholder data from the previous query is never an accepted page. */
export function useAccumulatedPages<T, M = undefined>({
  pageIndex,
  items,
  total,
  resetKey,
  getKey,
  metadata,
  isSuccess = true,
  responsePageIndex = pageIndex,
  responseResetKey = resetKey,
  snapshotKey,
  onSnapshotDrift,
  pageSize,
  offset = 0,
}: {
  pageIndex: number;
  items?: readonly T[];
  total?: number;
  resetKey: string;
  getKey: (row: T) => string | number;
  metadata?: M;
  isSuccess?: boolean;
  responsePageIndex?: number;
  responseResetKey?: string;
  snapshotKey?: string | number | null;
  onSnapshotDrift?: () => void;
  /** Defaults to the size of the first batch for fixed-size offset queries. */
  pageSize?: number;
  /** Rows preceding an explicit deep-link starting page. */
  offset?: number;
}) {
  const empty = {
    resetKey,
    pages: [] as Page<T>[],
    metadata: undefined as M | undefined,
  };
  // Only committed renders can publish a batch. Reading an inline items array
  // never schedules another render, and abandoned renders cannot write here.
  const committed = useRef(empty);
  let buffer =
    committed.current.resetKey === resetKey ? committed.current : empty;
  // Returning to the first page also discards the tail on a pending refresh.
  if (pageIndex === 0 && buffer.pages.length > 1) buffer = empty;
  let drifted = false;
  if (
    isSuccess &&
    items &&
    total !== undefined &&
    responsePageIndex === pageIndex &&
    responseResetKey === resetKey &&
    pageIndex >= 0 &&
    pageIndex >= buffer.pages.length - 1 &&
    pageIndex <= buffer.pages.length
  ) {
    const prior = buffer.pages[pageIndex];
    const first = buffer.pages[0];
    if (
      pageIndex > 0 &&
      first &&
      (first.snapshotKey !== snapshotKey ||
        (snapshotKey !== undefined && first.total !== total))
    ) {
      buffer = empty;
      drifted = true;
    } else if (
      prior?.items !== items ||
      prior.total !== total ||
      prior.snapshotKey !== snapshotKey ||
      buffer.metadata !== metadata
    ) {
      buffer = {
        resetKey,
        pages: [
          ...buffer.pages.slice(0, pageIndex),
          { items, total, snapshotKey },
        ],
        metadata,
      };
    }
  }
  const { pages } = buffer;
  const rows = useMemo(() => {
    const unique = new Map<string | number, T>();
    for (const page of pages) {
      for (const item of page.items) unique.set(getKey(item), item);
    }
    return [...unique.values()];
  }, [pages, getKey]);
  const last = pages.at(-1);
  const size = pageSize ?? pages[0]?.items.length ?? 0;
  const missingRows = !!last && offset + rows.length < last.total;
  const fullPage = !!last && size > 0 && last.items.length >= size;
  // A short tail with missing identities can expose offset drift even when
  // an insertion and a removal left the feed's total unchanged.
  if (
    pages.length > 1 &&
    last?.snapshotKey !== undefined &&
    missingRows &&
    !fullPage
  ) {
    buffer = empty;
    drifted = true;
  }
  useLayoutEffect(() => {
    committed.current = buffer;
    if (drifted) onSnapshotDrift?.();
  }, [buffer, drifted, onSnapshotDrift]);
  return {
    rows: drifted ? [] : rows,
    total: buffer.pages.at(-1)?.total ?? 0,
    metadata: buffer.metadata,
    hasMore: drifted || (fullPage && missingRows),
  };
}

export function useInfiniteSlice<T>(
  items: readonly T[],
  batchSize = 50,
  resetKey?: string,
) {
  const size = Number.isFinite(batchSize)
    ? Math.max(1, Math.floor(batchSize))
    : 50;
  const cursor = useTablePage(JSON.stringify([resetKey, size]));
  const limit = size * (cursor.pageIndex + 1);
  return {
    rows: useMemo(() => items.slice(0, limit), [items, limit]),
    hasMore: items.length > limit,
    onLoadMore: cursor.loadMore,
  };
}

export function useIntersectionLoadMore({
  enabled,
  loading,
  onLoadMore,
  rootMargin,
}: {
  enabled: boolean;
  loading: boolean;
  onLoadMore: () => void;
  rootMargin?: string;
}) {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const load = useEffectEvent(() => {
    if (enabled && !loading) onLoadMore();
  });
  useEffect(() => {
    if (
      !node ||
      !enabled ||
      loading ||
      typeof IntersectionObserver === "undefined"
    )
      return;
    let active = true;
    const scrollRoot = node.closest<HTMLElement>(
      '[data-slot="table-container"], [data-infinite-scroll-root], .nc-table-scroll, .table-wrap',
    );
    const effectiveRootMargin = rootMargin ?? (scrollRoot ? "120px" : "240px");
    const observer = new IntersectionObserver(
      (entries) => {
        if (active && entries.some((entry) => entry.isIntersecting)) load();
      },
      { root: scrollRoot ?? null, rootMargin: effectiveRootMargin },
    );
    observer.observe(node);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [node, enabled, loading, rootMargin]);
  return setNode;
}
