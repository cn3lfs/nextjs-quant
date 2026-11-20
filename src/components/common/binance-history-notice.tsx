"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { api } from "~/trpc/react";

export function isBinanceNoticeRoute(
  pathname: string,
  tab: string | null,
): boolean {
  return (
    pathname === "/system" ||
    pathname === "/accounts/crypto" ||
    pathname === "/crypto" ||
    pathname.startsWith("/crypto/") ||
    ((pathname === "/scan" || pathname === "/accounts") && tab === "crypto")
  );
}

export function BinanceHistoryNotice() {
  const pathname = usePathname();
  const search = useSearchParams();
  const shouldShow = isBinanceNoticeRoute(pathname, search.get("tab"));
  const status = api.binancePublicDataStatus.useQuery(undefined, {
    enabled: shouldShow,
    staleTime: 300000,
  });
  if (!shouldShow || !status.data?.needsBackfill) return null;
  return (
    <p
      role="status"
      className="mb-3 rounded-md border bg-muted px-3 py-2 text-sm text-muted-foreground"
    >
      BTC、ETH 本地历史行情尚未补齐。
      <Link className="ml-2 underline" href="/system">
        在数据与连接中回填
      </Link>
    </p>
  );
}
