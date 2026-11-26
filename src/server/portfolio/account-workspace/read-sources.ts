import { createHash } from "node:crypto";
import { isLocalFund, readGbbq, readSnapshot } from "tstdx/local";
import type { Settings, Snapshot } from "~/lib/domain";
import type { CorporateEvidence } from "~/lib/portfolio/trade-ledger";
import { chinaClock } from "~/lib/strategy-facts/notification-policy";
import type { AccountWorkspaceRepository } from "../../db/account-workspace-repository";
import type { FullDayCachePointer } from "../../db/tdx-cache-ids";
import { readColumnCache } from "../../market/bar-store/column-cache";
import { localCalendarReference } from "../../market/data-health";

export async function readBookContext(
  config: Settings,
  now: number,
  repo: AccountWorkspaceRepository | null | undefined,
) {
  const today = chinaClock(now).date;
  const listings = repo?.bonusListings();
  const calendar = await localCalendarReference(
    config.tdxRoot,
    config.calendar,
  );
  let events: Awaited<ReturnType<typeof readGbbq>>["events"] = new Map();
  let coverageEnd: string | null = null,
    source = "本地 GBBQ 缺失或不可读";
  try {
    const data = await readGbbq(config.tdxRoot);
    events = data.events;
    for (const list of events.values())
      for (const e of list)
        if (!coverageEnd || e.date > coverageEnd) coverageEnd = e.date;
    source = `${data.path}; mtime=${data.modified}; parsedHash=${createHash(
      "sha256",
    )
      .update(JSON.stringify([...events]))
      .digest("hex")}`;
  } catch {
    /* Explicit unknown state; never silently treat missing as no event. */
  }
  return {
    today,
    calendar: calendar.days,
    calendarSource: calendar.source,
    evidence: (symbol: string): CorporateEvidence => ({
      events: events.get(symbol) ?? [],
      coverageEnd,
      source,
      bonusListings: listings?.get(symbol),
    }),
  };
}
export async function readAccountEquitySource(
  root: string,
  symbol: string,
  repo: AccountWorkspaceRepository | null | undefined,
) {
  const local = await readSnapshot(root, symbol, "day", {
    chartFunds: true,
  }).catch(() => null);
  const pointer = repo?.record<FullDayCachePointer>(
    `tdx-full-day-current-${symbol}`,
  );
  const column =
    pointer && readColumnCache(`full-package:${pointer.snapshotId}`);
  const cached = column
    ? ({ ...column.metadata.source, bars: column.bars } as Snapshot)
    : pointer && repo?.record<Snapshot>(pointer.snapshotId);
  const imported =
    cached?.symbol === symbol &&
    cached.period === "day" &&
    cached.adjustment === "none" &&
    cached.source === "tdx-full-package" &&
    (!isLocalFund(symbol) ||
      cached.sourceVersions?.includes("tdx-full-day-fund-3-v1"))
      ? cached
      : null;
  const importedDate = imported?.bars.at(-1)?.date;
  const localDate = local?.bars.at(-1)?.date;
  if (
    imported &&
    importedDate &&
    (!localDate ||
      importedDate > localDate ||
      (importedDate === localDate && pointer?.repairSameDate))
  )
    return imported.bars;
  return local?.bars ?? [];
}
