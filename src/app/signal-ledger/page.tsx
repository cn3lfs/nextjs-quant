import { SignalLedgerControls } from "~/components/signal-ledger-controls";
import { SignalLedgerView } from "~/components/signal-ledger-view";
import { sqlite } from "~/server/db";
import { SignalLedgerStore } from "~/server/monitoring/signal-ledger-store";
import { NotificationPolicyStore } from "~/server/infra/notification-policy-store";
import { connection } from "next/server";
import { z } from "zod";

export default async function SignalLedgerPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  await connection();
  const informationPage = z.coerce
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .catch(1)
    .parse((await searchParams).informationPage);
  const store = new SignalLedgerStore(sqlite());
  const runs = store.runs();
  return (
    <>
      <SignalLedgerControls
        date={runs.find((run) => run.status === "running")?.date}
      />
      <SignalLedgerView
        informationPage={informationPage}
        rows={store.rows()}
        runs={runs}
        notifications={new NotificationPolicyStore(sqlite()).decisions()}
      />
    </>
  );
}
