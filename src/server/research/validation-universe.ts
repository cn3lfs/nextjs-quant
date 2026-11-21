import { z } from "zod";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { scan, readTdxCodeChanges, isAStock } from "tstdx/local";
import { readRecordSnapshot } from "../db";
import { auditUniverse } from "~/lib/screening/universe-audit";
import { researchDateSchema } from "trading-strategies/research/contracts/date";

const cutoff = (end: string) =>
  Date.parse(`${researchDateSchema.parse(end)}T23:59:59.999+08:00`);

const evidenceHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const datedNotice = z.object({
  date: researchDateSchema,
  publishedOn: researchDateSchema,
  source: z.string().url(),
});
const terminalStatusSchema = z.object({
  evidenceHash: evidenceHashSchema,
  lastTrading: datedNotice.nullable(),
  listingEnd: datedNotice.nullable(),
});
const terminalStatusArchive =
  ".test-data/lifecycle-20261116/l3/terminal-status-evidence.json";

export function validationTerminalStatuses(bytes: Buffer, end: string) {
  const archive = z
    .object({
      version: z.literal("lifecycle-terminal-status-evidence-1"),
      events: z.array(
        z
          .object({
            symbol: z.string().refine(isAStock),
            lastTradingDate: researchDateSchema.optional(),
            suspensionFrom: researchDateSchema,
            suspensionNoticePublishedOn: researchDateSchema.optional(),
            suspensionSource: z.string().url(),
            listingEndsOn: researchDateSchema,
            listingNoticePublishedOn: researchDateSchema,
            listingSource: z.string().url(),
          })
          .refine(
            (event) =>
              event.suspensionFrom <= event.listingEndsOn &&
              event.listingNoticePublishedOn <= event.listingEndsOn &&
              (!event.lastTradingDate ||
                event.lastTradingDate < event.suspensionFrom),
          ),
      ),
    })
    .parse(JSON.parse(bytes.toString()));
  const evidenceHash = createHash("sha256").update(bytes).digest("hex");
  const statuses = new Map<string, z.infer<typeof terminalStatusSchema>>();
  const seen = new Set<string>();
  for (const event of archive.events) {
    if (seen.has(event.symbol))
      throw new Error(`Duplicate terminal status evidence: ${event.symbol}`);
    seen.add(event.symbol);
    const lastTrading =
      event.lastTradingDate &&
      event.suspensionNoticePublishedOn &&
      event.suspensionNoticePublishedOn <= end
        ? {
            date: event.lastTradingDate,
            publishedOn: event.suspensionNoticePublishedOn,
            source: event.suspensionSource,
          }
        : null;
    const listingEnd =
      event.listingNoticePublishedOn <= end
        ? {
            date: event.listingEndsOn,
            publishedOn: event.listingNoticePublishedOn,
            source: event.listingSource,
          }
        : null;
    if (lastTrading || listingEnd)
      statuses.set(event.symbol, { evidenceHash, lastTrading, listingEnd });
  }
  return statuses;
}

const lifecycleSchema = z
  .object({
    version: z.literal("security-lifecycle-2"),
    symbol: z.string(),
    source: z.string().min(1),
    fetchedAt: z.number().int().nonnegative(),
    evidenceHash: evidenceHashSchema,
    listingDate: researchDateSchema.nullable(),
    delistingDate: researchDateSchema.nullable(),
  })
  .refine(
    (r) =>
      !r.listingDate || !r.delistingDate || r.listingDate <= r.delistingDate,
  );

export function validationLifecycleEvidence(
  records: Iterable<unknown>,
  end: string,
) {
  const endTime = cutoff(end);
  const lifecycle = new Map<string, z.infer<typeof lifecycleSchema>>();
  let late = 0;
  for (const value of records) {
    const row = lifecycleSchema.safeParse(value);
    if (!row.success || !isAStock(row.data.symbol)) continue;
    const evidence = row.data;
    if (evidence.fetchedAt > endTime) {
      late++;
      continue;
    }
    if (lifecycle.has(evidence.symbol))
      throw new Error(`Duplicate lifecycle evidence: ${evidence.symbol}`);
    lifecycle.set(evidence.symbol, evidence);
  }
  return { lifecycle, late };
}

/** The best observable local roster, not a claim to enumerate removed securities.
 * Unlike the read-only audit page, this research capture explicitly scans local
 * files, then freezes the roster. First local bar is never a listing date.
 */
export async function captureValidationUniverse(
  root: string,
  start: string,
  end: string,
) {
  const [coverage, changes, notices] = await Promise.all([
    scan(root),
    readTdxCodeChanges(root),
    readFile(terminalStatusArchive)
      .then((bytes) => ({
        statuses: validationTerminalStatuses(bytes, end),
        gap: null,
      }))
      .catch((error: unknown) => ({
        statuses: new Map<string, z.infer<typeof terminalStatusSchema>>(),
        gap:
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? "Local terminal status evidence archive unavailable"
            : `Local terminal status evidence archive not usable: ${String(error)}`,
      })),
  ]);
  const { lifecycle, late } = readRecordSnapshot(
    "security-lifecycle",
    (records) => validationLifecycleEvidence(records, end),
  );
  const names = new Map(coverage.securities.map((s) => [s.symbol, s.name]));
  const localSymbols = new Set(
    coverage.securities
      .filter((s) => s.period === "day" && isAStock(s.symbol))
      .map((s) => s.symbol),
  );
  const mapped = Object.entries(changes.changes)
    .flatMap(([old, change]) => [old, `bj${change.targetCode}`])
    .filter(isAStock);
  const symbols = [
    ...new Set([
      ...localSymbols,
      ...lifecycle.keys(),
      ...notices.statuses.keys(),
      ...mapped,
    ]),
  ].sort();
  const members: ValidationMember[] = symbols.map((symbol) => {
    const terminalStatus = notices.statuses.get(symbol);
    return {
      symbol,
      name: names.get(symbol) ?? symbol,
      listingDate: lifecycle.get(symbol)?.listingDate ?? null,
      delistingDate: lifecycle.get(symbol)?.delistingDate ?? null,
      local: localSymbols.has(symbol),
      evidenceHash: lifecycle.get(symbol)?.evidenceHash ?? null,
      fetchedAt: lifecycle.get(symbol)?.fetchedAt ?? null,
      ...(terminalStatus ? { terminalStatus } : {}),
    };
  });
  const audit = auditUniverse({
    symbols,
    source:
      "Read-only local scan + lifecycle cache + archived exchange notices + TDX code-change records",
    start,
    end,
    rosterAsOf: null,
    rosterAsOfReason: "No historical roster effective-date archive",
    rosterIsCurrentSnapshot: true,
    evidence: members.map((member) => ({
      symbol: member.symbol,
      listingDate: member.listingDate,
      delistingDate: validationListingEnd(member),
      lifecycleSource:
        member.terminalStatus?.listingEnd?.source ??
        lifecycle.get(member.symbol)?.source ??
        "No trustworthy lifecycle cache",
      localFirstDate: null,
      localSource: "Local file existence only; not listing evidence",
      codeChanges: Object.entries(changes.changes)
        .filter(
          ([old, c]) =>
            old === member.symbol || `bj${c.targetCode}` === member.symbol,
        )
        .map(([_old, c]) => ({
          date: c.recordedDate,
          source: `TDX supplier record / ${changes.hash}`,
        })),
    })),
  });
  const universe = {
    version: "free-local-universe-1" as const,
    lifecycleEvidenceThrough: end,
    members,
    audit,
    codeChanges: changes,
    grade:
      members.length > 0 &&
      members.every((member) => member.listingDate !== null)
        ? "bounded-dated-local"
        : ("incomplete-local" as const),
    knownDelisted: members.filter((member) => {
      const listingEnd = validationListingEnd(member);
      return listingEnd !== null && listingEnd <= end;
    }).length,
    gaps: [
      "Removed securities without local data or lifecycle cache cannot be enumerated; delisted count is a lower bound",
      "Unknown listing dates remain unknown; local first bar is only observed coverage",
      "Code-change record dates are not certified effective dates; SH/SZ mappings incomplete",
      "Current names/ST/IPO/queue status and historical universe completeness unverified",
      ...(notices.gap ? [notices.gap] : []),
      ...(late
        ? [
            `${late} lifecycle records fetched after ${end} (Asia/Shanghai) excluded from dated evidence`,
          ]
        : []),
    ],
  };
  validateFrozenValidationUniverse(universe, end);
  return universe;
}

export type ValidationMember = {
  symbol: string;
  name: string;
  listingDate: string | null;
  delistingDate: string | null;
  local: boolean;
  evidenceHash: string | null;
  fetchedAt?: number | null;
  terminalStatus?: z.infer<typeof terminalStatusSchema>;
};

export function validationListingEnd(
  member: Pick<ValidationMember, "delistingDate" | "terminalStatus">,
) {
  return member.terminalStatus?.listingEnd?.date ?? member.delistingDate;
}

export type ValidationUniverse = Omit<
  Awaited<ReturnType<typeof captureValidationUniverse>>,
  "lifecycleEvidenceThrough"
> & {
  lifecycleEvidenceThrough?: string;
};

export function validateFrozenValidationUniverse(
  universe: Pick<ValidationUniverse, "members" | "lifecycleEvidenceThrough">,
  end: string,
) {
  if (universe.lifecycleEvidenceThrough === undefined) return;
  if (universe.lifecycleEvidenceThrough !== end)
    throw new Error("Frozen lifecycle cutoff differs from research end");
  const endTime = cutoff(end);
  const seen = new Set<string>();
  for (const member of universe.members) {
    if (!isAStock(member.symbol) || seen.has(member.symbol))
      throw new Error(
        `Invalid or duplicate frozen roster member: ${member.symbol}`,
      );
    seen.add(member.symbol);
    if (member.terminalStatus !== undefined) {
      const parsed = terminalStatusSchema.safeParse(member.terminalStatus);
      if (
        !parsed.success ||
        [parsed.data.lastTrading, parsed.data.listingEnd].some(
          (notice) => notice && notice.publishedOn > end,
        ) ||
        (parsed.data.lastTrading &&
          parsed.data.listingEnd &&
          parsed.data.lastTrading.date >= parsed.data.listingEnd.date)
      )
        throw new Error(
          `Invalid or late frozen terminal status: ${member.symbol}`,
        );
    }
    if (
      member.fetchedAt === null &&
      member.evidenceHash === null &&
      member.listingDate === null &&
      member.delistingDate === null
    )
      continue;
    if (
      !lifecycleSchema.safeParse({
        ...member,
        version: "security-lifecycle-2",
        source: "frozen lifecycle cache",
      }).success ||
      member.fetchedAt! > endTime
    )
      throw new Error(
        `Invalid or late frozen lifecycle evidence: ${member.symbol}`,
      );
  }
}

type MemberLifecycle = Pick<
  ValidationMember,
  "listingDate" | "delistingDate" | "fetchedAt" | "terminalStatus"
>;

function memberActiveOn(member: MemberLifecycle, day: string, dayEnd: number) {
  const lastTrading = member.terminalStatus?.lastTrading;
  const listingEnd = member.terminalStatus?.listingEnd;
  const cacheKnown = member.fetchedAt != null && member.fetchedAt <= dayEnd;
  const listing = cacheKnown ? member.listingDate : null;
  const cachedDelisting = cacheKnown ? member.delistingDate : null;
  const delisting =
    listingEnd && listingEnd.publishedOn <= day
      ? listingEnd.date
      : cachedDelisting;
  return (
    (!listing || listing <= day) &&
    (!delisting || delisting > day) &&
    (!lastTrading || lastTrading.publishedOn > day || lastTrading.date >= day)
  );
}

export function validationMemberActive(member: MemberLifecycle, date: string) {
  const day = date.slice(0, 10);
  return memberActiveOn(member, day, cutoff(day));
}

export function validationMembersAt(
  universe: Pick<ValidationUniverse, "members">,
  date: string,
) {
  const day = date.slice(0, 10);
  const dayEnd = cutoff(day);
  return universe.members
    .filter((member) => memberActiveOn(member, day, dayEnd))
    .map((m) => m.symbol);
}
