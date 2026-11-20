"use client";
import { Button } from "../ui/button";
import { useIntersectionLoadMore } from "../ui/use-infinite-table";

export const cashReadOptions = {
  retry: false,
  staleTime: 0,
  gcTime: 0,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  refetchOnMount: false,
} as const;
export const cashMoney = (value: number | null, signed = false) =>
  value === null
    ? "未知"
    : `${signed && value > 0 ? "+" : ""}${value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export function CashPager({
  page,
  onPage,
  busy,
  label,
}: {
  page: { pageIndex: number; pageSize: number; total: number };
  onPage: (page: number) => void;
  busy: boolean;
  label: string;
}) {
  const loaded = Math.min((page.pageIndex + 1) * page.pageSize, page.total);
  const hasMore = loaded < page.total;
  const sentinel = useIntersectionLoadMore({
    enabled: hasMore,
    loading: busy,
    onLoadMore: () => onPage(page.pageIndex + 1),
  });
  return (
    <nav
      aria-label={label}
      className="flex flex-wrap items-center gap-2 text-sm"
    >
      <div ref={sentinel} aria-hidden="true" className="h-px w-full" />
      <span className="text-muted-foreground">
        已加载 {loaded} / 共 {page.total} 项
      </span>
      {hasMore && (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => onPage(page.pageIndex + 1)}
        >
          {busy ? "加载中…" : "加载更多"}
        </Button>
      )}
    </nav>
  );
}
