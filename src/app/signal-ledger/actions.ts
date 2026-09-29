"use server";
import { sqlite } from "~/server/db";
import { SignalLedgerStore } from "~/server/monitoring/signal-ledger-store";
import { ledgerDateSchema } from "~/lib/strategy-facts/signal-ledger-query";
export async function cancelLedger(date: string) {
  return new SignalLedgerStore(sqlite()).cancel(ledgerDateSchema.parse(date));
}
