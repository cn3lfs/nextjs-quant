"use client";
import { Button } from "../ui/button";

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
  return (
    <nav
      aria-label={label}
      className="flex flex-wrap items-center gap-2 text-sm"
    >
      <Button
        size="sm"
        variant="outline"
        disabled={busy || page.pageIndex === 0}
        onClick={() => onPage(page.pageIndex - 1)}
      >
        上一页
      </Button>
      <span>
        第 {page.pageIndex + 1} /{" "}
        {Math.max(1, Math.ceil(page.total / page.pageSize))} 页 · 共{" "}
        {page.total} 项
      </span>
      <Button
        size="sm"
        variant="outline"
        disabled={busy || (page.pageIndex + 1) * page.pageSize >= page.total}
        onClick={() => onPage(page.pageIndex + 1)}
      >
        下一页
      </Button>
    </nav>
  );
}
