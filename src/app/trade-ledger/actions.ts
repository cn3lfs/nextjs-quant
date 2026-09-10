"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  recordLocalTrade,
  recordBonusListing,
} from "~/server/trade-ledger-service";
import {
  mockDiagnostics,
  refreshMockShareholders,
  setMockEnabled,
  openMockAccount,
  reconcileMock,
  previewMockOrder,
  confirmMockOrder,
} from "~/server/mock-trading-service";
import { put } from "~/server/db";
export async function saveTrade(input: unknown) {
  await recordLocalTrade(input);
  revalidatePath("/trade-ledger");
}
export async function saveBonusListing(
  symbol: string,
  eventDate: string,
  date: string,
  source: string,
) {
  await recordBonusListing(symbol, eventDate, date, source);
  revalidatePath("/trade-ledger");
}
export async function toggleMock(enabled: boolean) {
  setMockEnabled(z.boolean().parse(enabled));
  revalidatePath("/trade-ledger");
}
export async function createMockAccount() {
  await openMockAccount();
}
export async function reconcileAccount() {
  return reconcileMock();
}
export async function previewOrder(input: unknown) {
  return previewMockOrder(input);
}
export async function confirmOrder(id: string) {
  return confirmMockOrder(id);
}
export async function updateStop(symbol: string, stop: number) {
  z.string()
    .regex(/^(sh|sz|bj)\d{6}$/)
    .parse(symbol);
  z.number().finite().positive().parse(stop);
  put("trade-stop", `trade-stop-${symbol}`, { stop });
  revalidatePath("/trade-ledger");
}

export async function readMockDiagnostics() { return mockDiagnostics(); }
export async function recoverMockAccount() { await refreshMockShareholders(); }
