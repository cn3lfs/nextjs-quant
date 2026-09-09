import { SignalLedgerView } from "~/components/signal-ledger-view";
import { sqlite } from "~/server/db";
import { SignalLedgerStore } from "~/server/signal-ledger-store";
import { connection } from "next/server";

export default async function SignalLedgerPage() {
  await connection();
  const store = new SignalLedgerStore(sqlite());
  return <SignalLedgerView rows={store.rows()} runs={store.runs()} />;
}
