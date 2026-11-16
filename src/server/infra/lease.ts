import { randomUUID } from "node:crypto";
import { get, put, sqlite } from "../db";

const scope = globalThis as typeof globalThis & {
  quantSchedulerOwner?: string;
};
const owner = (scope.quantSchedulerOwner ??= randomUUID());
/** Internal worker requests carry the host's lease identity, never claim a new lease. */
export function schedulerOwnerId() {
  return owner;
}
export function holdsSchedulerLease(expectedOwner: string) {
  const current = get<{ owner: string; pid: number }>("scheduler-owner");
  return current?.owner === expectedOwner && current.pid === process.pid;
}
export function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
// One local process owns monitoring until it exits. Immediate transactions also
// serialize simultaneous startup across the web and desktop processes.
export function acquireScheduler() {
  return sqlite()
    .transaction(() => {
      const current = get<{ owner: string; pid: number }>("scheduler-owner");
      if (current && current.owner !== owner && processAlive(current.pid))
        return false;
      put("lease", "scheduler-owner", { owner, pid: process.pid });
      return true;
    })
    .immediate();
}
