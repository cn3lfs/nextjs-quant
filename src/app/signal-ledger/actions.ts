"use server";
import { sqlite } from "~/server/db";
import { SignalLedgerStore } from "~/server/monitoring/signal-ledger-store";
export async function cancelLedger(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("无效任务日期");
  new SignalLedgerStore(sqlite()).cancel(date);
}
