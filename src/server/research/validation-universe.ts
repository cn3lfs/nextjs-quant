import { z } from "zod";
import { scan, readTdxCodeChanges, isAStock } from "tstdx/local";
import { readRecordSnapshot } from "../db";
import { auditUniverse } from "~/lib/screening/universe-audit";
import { researchDateSchema } from "trading-strategies/research/contracts/date";

const lifecycleSchema = z
  .object({
    version: z.literal("security-lifecycle-2"),
    symbol: z.string(),
    source: z.string().min(1),
    fetchedAt: z.number().finite(),
    evidenceHash: z.string().min(1),
    listingDate: researchDateSchema.nullable(),
    delistingDate: researchDateSchema.nullable(),
  })
  .refine(
    (r) =>
      !r.listingDate || !r.delistingDate || r.listingDate <= r.delistingDate,
  );

/** The best observable local roster, not a claim to enumerate removed securities.
 * Unlike the read-only audit page, this research capture explicitly scans local
 * files, then freezes the roster. First local bar is never a listing date.
 */
export async function captureValidationUniverse(
  root: string,
  start: string,
  end: string,
) {
  const [coverage, changes] = await Promise.all([
    scan(root),
    readTdxCodeChanges(root),
  ]);
  const lifecycles = readRecordSnapshot<
    unknown,
    z.infer<typeof lifecycleSchema>[]
  >("security-lifecycle", (records) => {
    const rows: z.infer<typeof lifecycleSchema>[] = [];
    for (const value of records) {
      const parsed = lifecycleSchema.safeParse(value);
      if (parsed.success && isAStock(parsed.data.symbol))
        rows.push(parsed.data);
    }
    return rows;
  });
  const lifecycle = new Map(lifecycles.map((r) => [r.symbol, r]));
  const names = new Map(coverage.securities.map((s) => [s.symbol, s.name]));
  const localSymbols = coverage.securities
    .filter((s) => s.period === "day" && isAStock(s.symbol))
    .map((s) => s.symbol);
  const mapped = Object.entries(changes.changes)
    .flatMap(([old, change]) => [old, `bj${change.targetCode}`])
    .filter(isAStock);
  const symbols = [
    ...new Set([...localSymbols, ...lifecycle.keys(), ...mapped]),
  ].sort();
  const audit = auditUniverse({
    symbols,
    source:
      "Read-only local scan + existing lifecycle cache + TDX code-change records",
    start,
    end,
    rosterAsOf: null,
    rosterAsOfReason: "No historical roster effective-date archive",
    rosterIsCurrentSnapshot: true,
    evidence: symbols.map((symbol) => ({
      symbol,
      listingDate: lifecycle.get(symbol)?.listingDate ?? null,
      delistingDate: lifecycle.get(symbol)?.delistingDate ?? null,
      lifecycleSource:
        lifecycle.get(symbol)?.source ?? "No trustworthy lifecycle cache",
      localFirstDate: null,
      localSource: "Local file existence only; not listing evidence",
      codeChanges: Object.entries(changes.changes)
        .filter(([old, c]) => old === symbol || `bj${c.targetCode}` === symbol)
        .map(([_old, c]) => ({
          date: c.recordedDate,
          source: `TDX supplier record / ${changes.hash}`,
        })),
    })),
  });
  const members = symbols.map((symbol) => ({
    symbol,
    name: names.get(symbol) ?? symbol,
    listingDate: lifecycle.get(symbol)?.listingDate ?? null,
    delistingDate: lifecycle.get(symbol)?.delistingDate ?? null,
    local: localSymbols.includes(symbol),
    evidenceHash: lifecycle.get(symbol)?.evidenceHash ?? null,
  }));
  return {
    version: "free-local-universe-1" as const,
    members,
    audit,
    codeChanges: changes,
    grade:
      lifecycles.length === symbols.length && symbols.length > 0
        ? "bounded-dated-local"
        : ("incomplete-local" as const),
    knownDelisted: members.filter(
      (m) => m.delistingDate && m.delistingDate <= end,
    ).length,
    gaps: [
      "Removed securities without local data or lifecycle cache cannot be enumerated; delisted count is a lower bound",
      "Unknown listing dates remain unknown; local first bar is only observed coverage",
      "Code-change record dates are not certified effective dates; SH/SZ mappings incomplete",
      "Current names/ST/IPO/queue status and historical universe completeness unverified",
    ],
  };
}
export type ValidationUniverse = Awaited<
  ReturnType<typeof captureValidationUniverse>
>;
export function validationMembersAt(
  universe: ValidationUniverse,
  date: string,
) {
  return universe.members
    .filter(
      (m) =>
        (!m.listingDate || m.listingDate <= date) &&
        (!m.delistingDate || m.delistingDate > date),
    )
    .map((m) => m.symbol);
}
