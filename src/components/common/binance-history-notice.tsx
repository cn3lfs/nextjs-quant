"use client";
import Link from "next/link";
import { api } from "~/trpc/react";
export function BinanceHistoryNotice() {
  const status = api.binancePublicDataStatus.useQuery(undefined, {
    staleTime: 300000,
  });
  if (!status.data?.needsBackfill) return null;
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
