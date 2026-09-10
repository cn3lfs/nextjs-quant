import { connection } from "next/server";
import { tradeDashboard } from "~/server/trade-ledger-service";
import { mockEnabled } from "~/server/mock-trading-service";
import { TradeLedgerPanel } from "~/components/trade-ledger-panel";
export default async function TradeLedgerPage() {
  await connection();
  return (
    <TradeLedgerPanel data={await tradeDashboard()} enabled={mockEnabled()} />
  );
}
