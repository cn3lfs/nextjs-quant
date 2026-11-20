"use client";
import { useSearchParams } from "next/navigation";
import { SimAccountsPanel } from "./sim-accounts-panel";
import { TradeLedgerPanel } from "./trade-ledger-panel";
import { WeeklyReview } from "./account-review-panels";
import { AccountTrades } from "./account-workspace/account-trades";
import { AccountAttribution } from "./account-workspace/attribution";
import { HoldingsExplorer } from "./account-workspace/holdings-explorer";
import { MonthlyReview } from "./account-workspace/monthly-review";

export function AccountWorkspace() {
  const search = useSearchParams(),
    tab = search.get("tab"),
    position = search.get("position");
  if (tab === "ledger") return <TradeLedgerPanel />;
  if (tab === "trades") return <AccountTrades />;
  if (tab === "paper") return <SimAccountsPanel />;
  if (tab === "attribution") return <AccountAttribution />;
  if (tab === "monthly") return <MonthlyReview />;
  if (tab === "weekly") return <WeeklyReview />;
  return <HoldingsExplorer search={search.toString()} position={position} />;
}
