import { patternBreakoutKinds } from "trading-strategies";
import type { Candidate, Snapshot } from "~/lib/domain";
import {
  buildScanToLabHandoffHref,
  ScanToLabHandoffSchema,
  type ScanToLabHandoff,
} from "~/lib/research/diagnose-contract";

/** A candidate's identity inside one confirmed result page. */
export type ScreenCandidateIdentity = Pick<Candidate, "symbol" | "snapshotId">;

/**
 * Index of the URL's current candidate in the confirmed result page. Requiring
 * both the symbol and the snapshot id rejects an old URL or a different frozen
 * chart that happens to share the same symbol.
 */
export function currentScreenCandidateIndex(
  candidates: readonly ScreenCandidateIdentity[],
  current: { symbol: string | null; snapshotId: string | null },
) {
  if (!current.symbol || !current.snapshotId) return -1;
  return candidates.findIndex(
    (candidate) =>
      candidate.symbol === current.symbol &&
      candidate.snapshotId === current.snapshotId,
  );
}

/**
 * The frozen candidate URL opened by a row and its neighbouring buttons.
 * A snapshot whose id or symbol differs from the candidate is refused; only
 * MarketPage may accept it as the chart's frozen evidence.
 */
export function screenCandidateHref(
  candidate: ScreenCandidateIdentity,
  jobId: string,
  snapshot: Pick<Snapshot, "id" | "symbol" | "adjustment">,
) {
  if (
    !jobId ||
    snapshot.id !== candidate.snapshotId ||
    snapshot.symbol !== candidate.symbol
  )
    return null;
  return `/scan?${new URLSearchParams({
    tab: "formula",
    // ScreenRouteSelection restores the task from `job`; `screenJob` keeps the
    // frozen candidate tied to the same task for plan validation.
    job: jobId,
    symbol: candidate.symbol,
    screenSnapshot: snapshot.id,
    screenJob: jobId,
    adjustment: snapshot.adjustment ?? "none",
  })}`;
}

/** URL identity of the frozen workspace. Compared with the browser's native
 * location so a back/forward committed before React re-renders cannot leak a
 * late response onto the new page. */
export function screenCandidateUrlKey(search: {
  get(name: string): string | null;
}) {
  return JSON.stringify([
    search.get("tab"),
    search.get("job"),
    search.get("screenJob"),
    search.get("symbol"),
    search.get("screenSnapshot"),
  ]);
}

export type ScreenCandidateOpenOutcome =
  | { status: "opened" }
  | { status: "ignored" }
  | { status: "invalid"; message: string }
  | { status: "failed"; message: string };

/**
 * Reads a candidate's stored snapshot and navigates only while this is still
 * the latest request and the task/query page still owns the candidate. A late
 * response is dropped instead of replacing the chart the user is looking at.
 */
export async function openScreenCandidate(input: {
  candidate: ScreenCandidateIdentity;
  jobId: string;
  pageKey: string;
  fetchSnapshot: (id: string) => Promise<Snapshot>;
  readPageKey: () => string;
  containsCandidate: () => boolean;
  isLatest: () => boolean;
  navigate: (href: string) => void;
}): Promise<ScreenCandidateOpenOutcome> {
  // The same minimal ownership guard gates the read and both return paths; a
  // page that already exited never starts a load or keeps its old error.
  const owns = () =>
    input.isLatest() &&
    input.readPageKey() === input.pageKey &&
    input.containsCandidate();
  if (!owns()) return { status: "ignored" };
  let snapshot: Snapshot;
  try {
    snapshot = await input.fetchSnapshot(input.candidate.snapshotId);
  } catch (error) {
    if (!owns()) return { status: "ignored" };
    return {
      status: "failed",
      message: error instanceof Error ? error.message : "读取候选快照失败",
    };
  }
  if (!owns()) return { status: "ignored" };
  const href = screenCandidateHref(input.candidate, input.jobId, snapshot);
  if (!href)
    return {
      status: "invalid",
      message: "候选快照与所选证券不一致，未替换当前图表",
    };
  input.navigate(href);
  return { status: "opened" };
}

type LabCandidate = Pick<ScanToLabHandoff, "symbol" | "returnTo"> & {
  frozenDate?: string | null;
};

function candidateToLabHref(input: ScanToLabHandoff): string | null {
  const { returnTo, ...candidate } = input;
  const safeReturnTo =
    ScanToLabHandoffSchema.shape.returnTo.safeParse(returnTo);
  const result = ScanToLabHandoffSchema.safeParse({
    ...candidate,
    ...(safeReturnTo.success ? { returnTo: safeReturnTo.data } : {}),
  });
  return result.success ? buildScanToLabHandoffHref(result.data) : null;
}

export function formulaCandidateToLabHref({
  formulaLabel,
  frozenDate,
  ...candidate
}: LabCandidate & { formulaLabel?: string }) {
  return candidateToLabHref({
    ...candidate,
    frozenDate: frozenDate ?? undefined,
    label: formulaLabel,
    handoffSource: "formula",
    strategyHint: "formula",
    scope: "single-symbol-diagnose",
  });
}

type PatternMatches = {
  chanCodes?: readonly string[];
  patternKinds?: readonly string[];
  theoryFamilies?: readonly string[];
};

function patternStrategyHint({
  chanCodes,
  patternKinds,
  theoryFamilies,
}: PatternMatches) {
  if (chanCodes?.includes("3B")) return "research-chan";
  if (chanCodes?.includes("1B")) return "research-chan-first";
  if (chanCodes?.includes("2B")) return "research-chan-second";
  if (theoryFamilies?.includes("growth-oneil")) return "research-sepa-pit";
  if (
    patternKinds?.includes("double-breakout") ||
    patternBreakoutKinds.some((kind) => patternKinds?.includes(kind))
  )
    return "double-breakout";
  return "dual-ma";
}

export function patternCandidateToLabHref({
  symbol,
  frozenDate,
  label,
  returnTo,
  ...matches
}: LabCandidate & PatternMatches & { label?: string }) {
  return candidateToLabHref({
    symbol,
    frozenDate: frozenDate ?? undefined,
    label,
    returnTo,
    handoffSource: "pattern",
    strategyHint: patternStrategyHint(matches),
    scope: "single-symbol-diagnose",
  });
}

export function rpsCandidateToLabHref({
  frozenDate,
  period,
  rpsValue,
  ...candidate
}: LabCandidate & { period: number; rpsValue?: number | null }) {
  const value = rpsValue != null && Number.isFinite(rpsValue) ? rpsValue : "—";
  return candidateToLabHref({
    ...candidate,
    frozenDate: frozenDate ?? undefined,
    label: `RPS${period}=${value}`,
    handoffSource: "rps",
    strategyHint: "dual-ma",
    scope: "single-symbol-diagnose",
  });
}
