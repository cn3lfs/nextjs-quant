import { TradeLedgerPanel } from "~/components/portfolio/trade-ledger-panel";
import { PaperAccountsPanel } from "~/components/portfolio/paper-accounts-panel";
export default function TradeLedgerPage() {
  return (
    <>
      <PaperAccountsPanel />
      <TradeLedgerPanel />
    </>
  );
}
