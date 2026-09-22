import { connection } from "next/server";
import { tradeDashboard } from "~/server/portfolio/trade-ledger-service";
import { mockEnabled } from "~/server/portfolio/mock/mock-trading-service";
import { TradeLedgerPanel } from "~/components/trade-ledger-panel";
export default async function TradeLedgerPage() {
  await connection();
  return (
    <TradeLedgerPanel data={await tradeDashboard()} enabled={mockEnabled()} />
  );
}
