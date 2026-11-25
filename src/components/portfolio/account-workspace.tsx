"use client";
import { useRouter, useSearchParams } from "next/navigation";
import {
  accountRiskHref,
  accountWorkspaceTabs,
} from "~/lib/portfolio/account-workspace";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { AccountRiskPanel } from "./account-risk-panel";
import { ParallelAccountsHub } from "./parallel-accounts-hub";
import { TradeLedgerPanel } from "./trade-ledger-panel";
import { WeeklyReview } from "./account-review-panels";
import { AccountTrades } from "./account-workspace/account-trades";
import { AccountAttribution } from "./account-workspace/attribution";
import { HoldingsExplorer } from "./account-workspace/holdings-explorer";
import { MonthlyReview } from "./account-workspace/monthly-review";

export function AccountWorkspace() {
  const search = useSearchParams();
  const router = useRouter();
  const current = accountWorkspaceTabs.find(
    ({ value }) => value === search.get("tab"),
  );
  const tab = current?.value ?? "holdings";
  return (
    <Tabs
      value={tab}
      activationMode="manual"
      onValueChange={(value) => {
        if (value === "risk") router.push(accountRiskHref);
        else
          router.push(
            value === "holdings" ? "/accounts" : `/accounts?tab=${value}`,
          );
      }}
    >
      <TabsList
        aria-label="账户工作区"
        className="mb-2 flex-wrap justify-start"
      >
        {accountWorkspaceTabs.map(({ value, label }) => (
          <TabsTrigger key={value} value={value}>
            {label}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent key={tab} value={tab} className="min-w-0">
        <AccountWorkspaceContent
          tab={tab}
          search={search.toString()}
          position={search.get("position")}
        />
      </TabsContent>
    </Tabs>
  );
}

function AccountWorkspaceContent({
  tab,
  search,
  position,
}: {
  tab: (typeof accountWorkspaceTabs)[number]["value"];
  search: string;
  position: string | null;
}) {
  if (tab === "ledger") return <TradeLedgerPanel />;
  if (tab === "trades") return <AccountTrades />;
  if (tab === "paper") return <ParallelAccountsHub />;
  if (tab === "attribution") return <AccountAttribution />;
  if (tab === "monthly") return <MonthlyReview />;
  if (tab === "weekly") return <WeeklyReview />;
  if (tab === "risk") return <AccountRiskPanel />;
  return <HoldingsExplorer search={search} position={position} />;
}
