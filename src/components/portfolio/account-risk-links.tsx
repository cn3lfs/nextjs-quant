"use client";
import Link from "next/link";
import { api } from "~/trpc/react";
import { accountKindLabels } from "~/lib/portfolio/account-workspace";
export function AccountRiskLinks() {
  const query = api.accountRiskPositions.useQuery();
  return (
    <div className="space-y-2">
      {query.error && (
        <p role="alert">统一账户风险读取失败：{query.error.message}</p>
      )}
      {query.data?.items.map((p) => (
        <p key={p.id}>
          <Link
            className="font-semibold text-nc-bad underline"
            href={`/accounts?position=${encodeURIComponent(p.id)}`}
          >
            复盘风险持仓 {p.symbol} · {p.account} · {accountKindLabels[p.kind]}
          </Link>
        </p>
      ))}
      {(query.data?.total ?? 0) > 20 && (
        <Link href="/accounts">查看全部账户风险</Link>
      )}
    </div>
  );
}
