import { SignalLedgerControls } from "~/components/signal-ledger-controls";
import { SignalLedgerView } from "~/components/signal-ledger-view";
import { sqlite } from "~/server/db";
import { SignalLedgerStore } from "~/server/signal-ledger-store";
import { NotificationPolicyStore } from "~/server/notification-policy-store";
import { connection } from "next/server";

export default async function SignalLedgerPage() {
  await connection();
  const store = new SignalLedgerStore(sqlite());
  const runs = store.runs();
  return (
    <>
      <SignalLedgerControls
        date={runs.find((run) => run.status === "running")?.date}
      />
      <SignalLedgerView
        rows={store.rows()}
        runs={runs}
        notifications={new NotificationPolicyStore(sqlite()).decisions()}
      />
    </>
  );
}
