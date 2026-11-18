/**
 * F18.09 soft-gated long-only strategy composition.
 *
 * Contract boundaries:
 * - The caller supplies one explicit decision clock (`asOf`), a pre-frozen
 *   gate matrix B and a pre-frozen alpha vector. B rows are state -> child
 *   weights and sum to 1. `a_j = sum_k(alpha_k * B_kj)` is the only gate mix
 *   used here; no state is selected after looking at returns.
 * - `targetWeights` are child-internal fractions of that child's NAV. They sum
 *   to at most 1; the remainder is that child's cash. Invalid children
 *   contribute zero and their share stays cash. Unknown children receive no
 *   new allocation; their traceable actual holdings are carried, not guessed.
 * - `u_i = sum_j(a_j * w_ji)` is capped per symbol at `capPerSymbol`, then the
 *   whole capped vector is scaled down to `grossLimit`. Capping comes first;
 *   a freed invalid-child share is never redistributed.
 * - Protective exit/reduce instructions are processed before the new target,
 *   regardless of the rebalance calendar or gate availability. Their requests
 *   are intents computed from host-supplied actual contributions. This module
 *   never mutates actual contributions and never fabricates fills. Actual
 *   holdings change only when the host feeds back post-fill contributions.
 * - Repeated exit ids are idempotent. A conflicting duplicate is UNKNOWN and
 *   is not acted on. `acknowledgedExitIds` is host-only state; this module
 *   never acknowledges its own output.
 * - An untraceable contribution (conflicting revision for the same fill id, or
 *   an undeclared child) is reported as an UNKNOWN audit issue. Computable
 *   exits are still returned; no equal split is invented.
 *
 * Composition runs in three stages: (1) read actual contributions and
 * independent exit intents, (2) establish new-target eligibility from child
 * configuration and the gate, (3) apply cap/G to the new target. Missing,
 * future-frozen or malformed gate/alpha/child targets are collected as UNKNOWN
 * audits instead of throwing, so a portfolio hard exit and every traceable
 * protective exit survive that evidence gap. A valid child target is required
 * for TARGET; illegal configuration is never admitted as a new allocation.
 * Structural caller errors (missing/mistyped required fields, duplicate child
 * ids, malformed exit instructions, out-of-range cap/G) still throw.
 */
import {
  confirmationEpoch,
  type ConfirmationTime,
} from "./theory-confirmation.js";

const EPSILON = 1e-9;
const SUM_TOLERANCE = 1e-9;

export type CompositionChildStatus = "valid" | "invalid" | "unknown";

export type CompositionChild = {
  childId: string;
  status: CompositionChildStatus;
  /**
   * Required for a valid child: finite non-negative symbol fractions whose sum
   * is at most 1, each relative to that child's own NAV. Invalid/unknown
   * children must not carry this field.
   */
  targetWeights?: Readonly<Record<string, number>>;
};

export type CompositionGate = {
  /** Must not postdate the decision clock. */
  frozenAt: ConfirmationTime;
  /** K state rows x J children; every row is finite non-negative and sums to 1. */
  rows: readonly (readonly number[])[];
};

/** One actual child-symbol contribution, identified by its fill and revision. */
export type CompositionActualContribution = {
  childId: string;
  symbol: string;
  /** Net asset contribution as a fraction of total NAV; long-only means >= 0. */
  contribution: number;
  fillId: string;
  /** Latest revision wins; conflicting values at the same revision are unknown. */
  revision: number;
};

/**
 * A protective exit/reduce intent. `targetContribution` is the desired
 * remaining contribution as a fraction of total NAV; `exit` must target zero.
 * The id is the idempotency key and is never re-minted by this module.
 */
export type CompositionExitInstruction = {
  exitId: string;
  childId: string;
  symbol: string;
  kind: "exit" | "reduce";
  targetContribution: number;
};

export type ComposeLongOnlyStrategiesInput = {
  /** Explicit decision clock with a timezone (epoch ms or ISO timestamp). */
  asOf: ConfirmationTime;
  /** Whether the caller's normal rebalance calendar says a new target is due. */
  rebalanceDue: boolean;
  /** Portfolio hard exit takes priority over every other instruction. */
  hardExit: boolean;
  /** Missing/null means the current gate mix is unknown. */
  gate?: CompositionGate | null;
  /** K state probabilities aligned with gate rows. Missing/null means unknown. */
  alpha?: readonly number[] | null;
  /** J >= 2 children, in the same column order as gate rows. */
  children: readonly CompositionChild[];
  /** Per-symbol long cap c in (0, 1]. */
  capPerSymbol: number;
  /** Total long target G in (0, 1]. */
  grossLimit: number;
  /**
   * Host-authoritative actual contributions. `undefined` means the host did
   * not supply a snapshot (exits become untraceable); `[]` means known zero.
   */
  actualContributions?: readonly CompositionActualContribution[];
  /** Protective intents independent of the rebalance calendar and gate. */
  exitInstructions?: readonly CompositionExitInstruction[];
  /** Only the host can acknowledge an exit id; this module never self-acks. */
  acknowledgedExitIds?: readonly string[];
};

export type CompositionStatus =
  "TARGET" | "KEEP_PREVIOUS_TARGET" | "UNKNOWN" | "HARD_EXIT";

export type CompositionIssueCode =
  | "INPUT_MISSING"
  | "ASOF_INVALID"
  | "GATE_MISSING"
  | "GATE_INVALID"
  | "ALPHA_MISSING"
  | "ALPHA_INVALID"
  | "VALID_TARGET_UNKNOWN"
  | "CHILD_TARGET_INVALID"
  | "UNKNOWN_CHILD_STATUS"
  | "UNTRACEABLE_CONTRIBUTION"
  | "UNKNOWN_CHILD_CONTRIBUTION"
  | "ACTUAL_INVALID"
  | "CONFLICTING_EXIT_ID"
  | "GROSS_EXCEEDS_LIMIT";

export type CompositionIssue = {
  code: CompositionIssueCode;
  severity: "UNKNOWN" | "INFO";
  childId: string | null;
  symbol: string | null;
  exitId: string | null;
  detail: string;
};

export type CompositionReduction = {
  exitId: string;
  childId: string;
  symbol: string;
  kind: "exit" | "reduce" | "hard-exit";
  /** Actual contribution observed on this call; never mutated by this module. */
  actualContribution: number;
  /** Remaining contribution requested by the instruction (0 for hard exit). */
  targetContribution: number;
  /** Reduction intent; host fills are required before actual changes. */
  requested: number;
  /** Intended actual after this request if the host fills it. */
  remainingContribution: number;
  /**
   * Host-declared acknowledgement only. Acknowledgement is not a fill: an
   * acknowledged intent stays in `requestedReductions` while actual > target.
   */
  acknowledged: boolean;
};

/** An instruction that cannot be quantified because actual evidence is absent. */
export type CompositionPendingUnknownReduction = {
  exitId: string;
  childId: string;
  symbol: string;
  kind: "exit" | "reduce";
  targetContribution: number;
  reason:
    "ACTUAL_SNAPSHOT_MISSING" | "UNTRACEABLE_CONTRIBUTION" | "UNKNOWN_CHILD";
};

export type CompositionAllocation = {
  childId: string;
  status: CompositionChildStatus;
  /** Soft-gate mix a_j actually used; zero for invalid/unknown children. */
  gateWeight: number;
  /** Sum of the child's declared target fractions (informational). */
  rawTargetWeight: number;
  /** Traceable actual contribution carried by this child. */
  heldContribution: number;
};

export type ComposeLongOnlyStrategiesResult = {
  status: CompositionStatus;
  asOf: number | null;
  gateFrozenAt: number | null;
  rebalanceDue: boolean;
  hardExit: boolean;
  /**
   * Raw composed symbol targets when rebalancing with a known gate. Null for
   * KEEP_PREVIOUS_TARGET, UNKNOWN or HARD_EXIT. Never includes carried
   * unknown-child holdings.
   */
  targetContributions: Readonly<Record<string, number>> | null;
  /**
   * Effective target after protective exits and carried unknown holdings.
   * This is an intent only; actual contributions remain unchanged until fills.
   * Null when the host did not supply an actual snapshot and this is not a
   * hard exit: unknown actual is not treated as full cash.
   */
  remainingTargetContributions: Readonly<Record<string, number>> | null;
  /** Null when the remaining target is unknown. */
  grossTarget: number | null;
  /** Null when the remaining target is unknown. */
  cashTarget: number | null;
  /**
   * All pending intents with a quantifiable amount, including host-acknowledged
   * ones that are not yet filled. Repeated calls are idempotent.
   */
  requestedReductions: readonly CompositionReduction[];
  /** Audit subset of requestedReductions marked acknowledged by the host. */
  acknowledgedReductions: readonly CompositionReduction[];
  /** Instructions that exist but cannot be quantified from the current facts. */
  pendingUnknownReductions: readonly CompositionPendingUnknownReduction[];
  allocations: readonly CompositionAllocation[];
  issues: readonly CompositionIssue[];
};

type TraceableFill = {
  childId: string;
  symbol: string;
  contribution: number;
  fillId: string;
  revision: number;
};

type KeyedContribution = {
  childId: string;
  symbol: string;
  contribution: number;
};

type ResolvedInstruction = CompositionExitInstruction & { order: number };

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isUnitFraction(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

function clean(value: number): number {
  const rounded = Number(value.toFixed(12));
  return Math.abs(rounded) < 1e-12 ? 0 : rounded;
}

function keyOf(childId: string, symbol: string): string {
  return `${childId}\u0000${symbol}`;
}

function splitKey(key: string): { childId: string; symbol: string } {
  const index = key.indexOf("\u0000");
  return { childId: key.slice(0, index), symbol: key.slice(index + 1) };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function issue(
  code: CompositionIssueCode,
  detail: string,
  values: {
    childId?: string | null;
    symbol?: string | null;
    exitId?: string | null;
  } = {},
): CompositionIssue {
  return {
    code,
    severity: "UNKNOWN",
    childId: values.childId ?? null,
    symbol: values.symbol ?? null,
    exitId: values.exitId ?? null,
    detail,
  };
}

function sortIssues(issues: CompositionIssue[]): CompositionIssue[] {
  const seen = new Set<string>();
  const unique = issues.filter((entry) => {
    const key = `${entry.code}\u0000${entry.childId ?? ""}\u0000${entry.symbol ?? ""}\u0000${entry.exitId ?? ""}\u0000${entry.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.sort(
    (left, right) =>
      compareText(left.code, right.code) ||
      compareText(left.childId ?? "", right.childId ?? "") ||
      compareText(left.symbol ?? "", right.symbol ?? "") ||
      compareText(left.exitId ?? "", right.exitId ?? "") ||
      compareText(left.detail, right.detail),
  );
}

function unknownResult(reason: string): ComposeLongOnlyStrategiesResult {
  return {
    status: "UNKNOWN",
    asOf: null,
    gateFrozenAt: null,
    rebalanceDue: false,
    hardExit: false,
    targetContributions: null,
    remainingTargetContributions: null,
    grossTarget: null,
    cashTarget: null,
    requestedReductions: [],
    acknowledgedReductions: [],
    pendingUnknownReductions: [],
    allocations: [],
    issues: [issue("INPUT_MISSING", reason)],
  };
}

/**
 * Configuration evidence, not caller shape: an invalid child target is an
 * UNKNOWN audit so it can never block hard exits or independent exits.
 */
function validateChildTargets(
  child: CompositionChild,
  issues: CompositionIssue[],
): { weights: Readonly<Record<string, number>> | null; sum: number } {
  const invalid = (detail: string): { weights: null; sum: number } => {
    issues.push(
      issue("CHILD_TARGET_INVALID", detail, { childId: child.childId }),
    );
    return { weights: null, sum: 0 };
  };
  if (child.status !== "valid") {
    if (child.targetWeights !== undefined && child.targetWeights !== null)
      return invalid(
        `composition child ${child.childId} is ${child.status} and must not carry target weights`,
      );
    return { weights: null, sum: 0 };
  }
  const weights = child.targetWeights;
  if (weights === undefined || weights === null)
    return { weights: null, sum: 0 };
  if (typeof weights !== "object" || Array.isArray(weights))
    return invalid(
      `composition child ${child.childId} target weights are invalid`,
    );
  let sum = 0;
  for (const [symbol, value] of Object.entries(weights)) {
    if (symbol.trim() === "")
      return invalid(`composition child ${child.childId} has an empty symbol`);
    if (!isFiniteNumber(value) || value < 0)
      return invalid(
        `composition child ${child.childId} weight for ${symbol} must be finite non-negative`,
      );
    sum += value;
  }
  if (sum > 1 + SUM_TOLERANCE)
    return invalid(
      `composition child ${child.childId} target weights sum to ${sum}, above 1`,
    );
  return { weights, sum };
}

/** Informational declared sum, available even before eligibility is decided. */
function declaredTargetSum(child: CompositionChild): number {
  if (child.status !== "valid" || !child.targetWeights) return 0;
  if (
    typeof child.targetWeights !== "object" ||
    Array.isArray(child.targetWeights)
  )
    return 0;
  let sum = 0;
  for (const value of Object.values(child.targetWeights))
    if (isFiniteNumber(value) && value >= 0) sum += value;
  return sum;
}

/** Gate evidence is checked only for new-target eligibility. */
function validateGate(
  gate: CompositionGate,
  asOf: number | null,
  childCount: number,
  issues: CompositionIssue[],
): { frozenAt: number; rows: number[][] } | null {
  const invalid = (detail: string): null => {
    issues.push(issue("GATE_INVALID", detail));
    return null;
  };
  const frozenAt = confirmationEpoch(gate.frozenAt);
  if (frozenAt === null)
    return invalid("composition gate frozenAt must carry an explicit timezone");
  if (asOf === null)
    return invalid(
      "composition gate cannot be checked without a valid decision clock",
    );
  if (frozenAt > asOf)
    return invalid("composition gate frozenAt must not postdate the decision");
  if (!Array.isArray(gate.rows) || gate.rows.length === 0)
    return invalid("composition gate must have at least one state row");
  const rows: number[][] = [];
  for (let rowIndex = 0; rowIndex < gate.rows.length; rowIndex++) {
    const row = gate.rows[rowIndex];
    if (!Array.isArray(row) || row.length !== childCount)
      return invalid(
        `composition gate row ${rowIndex} must have exactly ${childCount} children`,
      );
    let sum = 0;
    const copy: number[] = [];
    for (let columnIndex = 0; columnIndex < row.length; columnIndex++) {
      const value = row[columnIndex];
      if (!isFiniteNumber(value) || value < 0)
        return invalid(
          `composition gate row ${rowIndex} column ${columnIndex} must be finite non-negative`,
        );
      sum += value;
      copy.push(value);
    }
    if (Math.abs(sum - 1) > SUM_TOLERANCE)
      return invalid(`composition gate row ${rowIndex} must sum to 1`);
    rows.push(copy);
  }
  return { frozenAt, rows };
}

/** Alpha evidence is collected as an UNKNOWN audit too. */
function validateAlpha(
  alpha: readonly number[],
  rowCount: number,
  issues: CompositionIssue[],
): number[] | null {
  const invalid = (detail: string): null => {
    issues.push(issue("ALPHA_INVALID", detail));
    return null;
  };
  if (!Array.isArray(alpha) || alpha.length !== rowCount)
    return invalid(
      `composition alpha must have exactly ${rowCount} state probabilities`,
    );
  let sum = 0;
  const copy: number[] = [];
  for (let index = 0; index < alpha.length; index++) {
    const value = alpha[index];
    if (!isFiniteNumber(value) || value < 0)
      return invalid(`composition alpha ${index} must be finite non-negative`);
    sum += value;
    copy.push(value);
  }
  if (Math.abs(sum - 1) > SUM_TOLERANCE)
    return invalid("composition alpha must sum to 1");
  return copy;
}

/**
 * Latest revision per fill id. A fill id is one global identity: reusing it for
 * a different child/symbol is UNKNOWN and is excluded, never counted twice.
 */
function traceFills(
  entries: readonly CompositionActualContribution[],
  childIds: ReadonlySet<string>,
  issues: CompositionIssue[],
): {
  contributionByChildSymbol: Map<string, number>;
  traceable: TraceableFill[];
  untraceableKeys: Set<string>;
  /** True when an entry was skipped, so a complete amount is not claimed. */
  invalidEvidence: boolean;
} {
  type FillGroup = Map<string, TraceableFill[]>;
  const byFill = new Map<string, FillGroup>();
  const untraceableKeys = new Set<string>();
  let invalidEvidence = false;
  const invalid = (
    detail: string,
    values: { childId?: string | null; symbol?: string | null } = {},
  ) => {
    invalidEvidence = true;
    issues.push(issue("ACTUAL_INVALID", detail, values));
    if (isNonEmptyString(values.childId) && isNonEmptyString(values.symbol))
      untraceableKeys.add(keyOf(values.childId, values.symbol));
  };
  for (const entry of entries) {
    if (!entry) {
      invalid("actual contribution entry must not be null");
      continue;
    }
    if (!isNonEmptyString(entry.childId) || !isNonEmptyString(entry.symbol)) {
      invalid("actual contribution childId and symbol must be non-empty");
      continue;
    }
    if (!isFiniteNumber(entry.contribution) || entry.contribution < 0) {
      invalid(
        `actual contribution ${entry.childId}/${entry.symbol} must be finite non-negative`,
        { childId: entry.childId, symbol: entry.symbol },
      );
      continue;
    }
    if (!isNonEmptyString(entry.fillId)) {
      invalid("actual contribution fillId must be non-empty", {
        childId: entry.childId,
        symbol: entry.symbol,
      });
      continue;
    }
    if (!isNonNegativeInteger(entry.revision)) {
      invalid("actual contribution revision must be a non-negative integer", {
        childId: entry.childId,
        symbol: entry.symbol,
      });
      continue;
    }
    let group = byFill.get(entry.fillId);
    if (!group) {
      group = new Map();
      byFill.set(entry.fillId, group);
    }
    const revisionKey = String(entry.revision);
    const list = group.get(revisionKey) ?? [];
    list.push({ ...entry });
    group.set(revisionKey, list);
  }

  const traceable: TraceableFill[] = [];
  for (const [fillId, revisions] of byFill) {
    let latestRevision = -1;
    for (const revisionKey of revisions.keys())
      latestRevision = Math.max(latestRevision, Number(revisionKey));
    const candidates = revisions.get(String(latestRevision)) ?? [];
    const first = candidates[0];
    if (!first) continue;
    const ownershipConflict = candidates.some(
      (candidate) =>
        candidate.childId !== first.childId ||
        candidate.symbol !== first.symbol,
    );
    const contributionConflict = candidates.some(
      (candidate) => candidate.contribution !== first.contribution,
    );
    if (ownershipConflict || contributionConflict) {
      for (const list of revisions.values()) {
        for (const candidate of list)
          untraceableKeys.add(keyOf(candidate.childId, candidate.symbol));
      }
      issues.push(
        issue(
          "UNTRACEABLE_CONTRIBUTION",
          `fill ${fillId} revision ${latestRevision} has conflicting ownership or contribution`,
          ownershipConflict
            ? {}
            : { childId: first.childId, symbol: first.symbol },
        ),
      );
      continue;
    }
    if (!childIds.has(first.childId)) {
      issues.push(
        issue(
          "UNKNOWN_CHILD_CONTRIBUTION",
          `actual contribution references undeclared child ${first.childId}`,
          { childId: first.childId, symbol: first.symbol },
        ),
      );
    }
    traceable.push({ ...first });
  }

  // Deterministic order: child, symbol, fill id, revision.
  traceable.sort(
    (left, right) =>
      compareText(left.childId, right.childId) ||
      compareText(left.symbol, right.symbol) ||
      compareText(left.fillId, right.fillId) ||
      left.revision - right.revision,
  );

  const contributionByChildSymbol = new Map<string, number>();
  for (const fill of traceable) {
    const key = keyOf(fill.childId, fill.symbol);
    contributionByChildSymbol.set(
      key,
      (contributionByChildSymbol.get(key) ?? 0) + fill.contribution,
    );
  }
  return {
    contributionByChildSymbol,
    traceable,
    untraceableKeys,
    invalidEvidence,
  };
}

function resolveInstructions(
  entries: readonly CompositionExitInstruction[],
  issues: CompositionIssue[],
): ResolvedInstruction[] {
  const byId = new Map<string, ResolvedInstruction[]>();
  entries.forEach((entry, order) => {
    if (!entry) throw new Error("exit instruction must not be null");
    if (!isNonEmptyString(entry.exitId))
      throw new Error("exit instruction id must be non-empty");
    if (!isNonEmptyString(entry.childId) || !isNonEmptyString(entry.symbol))
      throw new Error(
        `exit instruction ${entry.exitId} childId and symbol must be non-empty`,
      );
    if (entry.kind !== "exit" && entry.kind !== "reduce")
      throw new Error(`exit instruction ${entry.exitId} kind is invalid`);
    if (
      !isFiniteNumber(entry.targetContribution) ||
      entry.targetContribution < 0 ||
      entry.targetContribution > 1
    )
      throw new Error(
        `exit instruction ${entry.exitId} targetContribution must be in [0, 1]`,
      );
    if (entry.kind === "exit" && entry.targetContribution !== 0)
      throw new Error(`exit instruction ${entry.exitId} must target zero`);
    const list = byId.get(entry.exitId) ?? [];
    list.push({ ...entry, order });
    byId.set(entry.exitId, list);
  });

  const resolved: ResolvedInstruction[] = [];
  for (const [exitId, list] of byId) {
    const first = list[0];
    if (!first) continue;
    if (list.length === 1) {
      resolved.push(first);
      continue;
    }
    const identical = list.every(
      (candidate) =>
        candidate.childId === first.childId &&
        candidate.symbol === first.symbol &&
        candidate.kind === first.kind &&
        candidate.targetContribution === first.targetContribution,
    );
    if (identical) {
      resolved.push(first);
    } else {
      issues.push(
        issue(
          "CONFLICTING_EXIT_ID",
          "duplicate exit id has conflicting content",
          {
            exitId,
          },
        ),
      );
    }
  }
  resolved.sort(
    (left, right) =>
      compareText(left.childId, right.childId) ||
      compareText(left.symbol, right.symbol) ||
      compareText(left.exitId, right.exitId) ||
      left.order - right.order,
  );
  return resolved;
}

/**
 * Waterfall per child-symbol. Each instruction says "reduce to target"; a
 * duplicate or weaker instruction cannot reduce the same contribution twice.
 * A host acknowledgement is recorded but never removes the pending request.
 */
function buildReductions(
  instructionGroups: ReadonlyMap<string, readonly ResolvedInstruction[]>,
  actuals: ReadonlyMap<string, number>,
  acknowledged: ReadonlySet<string>,
  untraceableKeys: ReadonlySet<string>,
): {
  requested: CompositionReduction[];
  pendingUnknown: CompositionPendingUnknownReduction[];
} {
  const requested: CompositionReduction[] = [];
  const pendingUnknown: CompositionPendingUnknownReduction[] = [];
  const keys = [...instructionGroups.keys()].sort(compareText);
  for (const key of keys) {
    const instructions = [...(instructionGroups.get(key) ?? [])].sort(
      (left, right) =>
        left.targetContribution - right.targetContribution ||
        compareText(left.exitId, right.exitId),
    );
    // Untraceable evidence wins over a partial traceable amount: never invent
    // a reduction from a key whose true holding is unknown.
    if (untraceableKeys.has(key)) {
      for (const instruction of instructions) {
        pendingUnknown.push({
          exitId: instruction.exitId,
          childId: instruction.childId,
          symbol: instruction.symbol,
          kind: instruction.kind,
          targetContribution: clean(instruction.targetContribution),
          reason: "UNTRACEABLE_CONTRIBUTION",
        });
      }
      continue;
    }
    const actual = actuals.get(key);
    if (actual === undefined) {
      // A declared known child with no entry is a known zero; no request.
      continue;
    }
    if (actual <= EPSILON) continue;
    let remaining = actual;
    for (const instruction of instructions) {
      const target = Math.min(remaining, instruction.targetContribution);
      const reduction = remaining - target;
      if (reduction <= EPSILON) continue;
      requested.push({
        exitId: instruction.exitId,
        childId: instruction.childId,
        symbol: instruction.symbol,
        kind: instruction.kind,
        actualContribution: clean(actual),
        targetContribution: clean(instruction.targetContribution),
        requested: clean(reduction),
        remainingContribution: clean(remaining - reduction),
        acknowledged: acknowledged.has(instruction.exitId),
      });
      remaining -= reduction;
    }
  }
  const byRecord = (left: CompositionReduction, right: CompositionReduction) =>
    compareText(left.childId, right.childId) ||
    compareText(left.symbol, right.symbol) ||
    compareText(left.exitId, right.exitId);
  requested.sort(byRecord);
  pendingUnknown.sort(
    (left, right) =>
      compareText(left.childId, right.childId) ||
      compareText(left.symbol, right.symbol) ||
      compareText(left.exitId, right.exitId),
  );
  return { requested, pendingUnknown };
}

function aggregateChildSymbolTargets(
  targets: ReadonlyMap<string, number>,
): Readonly<Record<string, number>> {
  const bySymbol = new Map<string, number>();
  for (const [key, value] of targets) {
    const { symbol } = splitKey(key);
    bySymbol.set(symbol, (bySymbol.get(symbol) ?? 0) + value);
  }
  const result: Record<string, number> = {};
  for (const symbol of [...bySymbol.keys()].sort(compareText))
    result[symbol] = clean(bySymbol.get(symbol) ?? 0);
  return result;
}

/**
 * F18.09 pure composition. See the module header for the full contract.
 */
export function composeLongOnlyStrategies(
  input: ComposeLongOnlyStrategiesInput | null | undefined,
): ComposeLongOnlyStrategiesResult {
  if (!input) return unknownResult("composition input is missing");

  // Structural caller shape. These are programming errors, not evidence.
  if (typeof input.rebalanceDue !== "boolean")
    throw new Error("composition rebalanceDue must be an explicit boolean");
  if (typeof input.hardExit !== "boolean")
    throw new Error("composition hardExit must be an explicit boolean");
  if (!Array.isArray(input.children) || input.children.length < 2)
    throw new Error("composition requires at least two children");
  if (
    input.actualContributions !== undefined &&
    !Array.isArray(input.actualContributions)
  )
    throw new Error(
      "composition actualContributions must be an array when supplied",
    );
  if (
    input.acknowledgedExitIds !== undefined &&
    !Array.isArray(input.acknowledgedExitIds)
  )
    throw new Error("composition acknowledgedExitIds must be an array");
  if (
    input.exitInstructions !== undefined &&
    !Array.isArray(input.exitInstructions)
  )
    throw new Error("composition exitInstructions must be an array");

  const issues: CompositionIssue[] = [];
  const childIds = new Set<string>();
  const childStatusById = new Map<string, CompositionChildStatus>();
  const targetWeightByChild = new Map<
    string,
    Readonly<Record<string, number>>
  >();
  const rawTargetSumByChild = new Map<string, number>();
  const gateWeightByChild = new Map<string, number>();
  let gateFrozenAt: number | null = null;
  let validTargetMissing = false;
  let unknownChildPresent = false;

  input.children.forEach((child) => {
    if (!child || !isNonEmptyString(child.childId))
      throw new Error("composition childId must be non-empty");
    if (childIds.has(child.childId))
      throw new Error(`duplicate composition childId ${child.childId}`);
    if (
      child.status !== "valid" &&
      child.status !== "invalid" &&
      child.status !== "unknown"
    )
      throw new Error(
        `composition child ${child.childId} has an invalid status`,
      );
    childIds.add(child.childId);
    childStatusById.set(child.childId, child.status);
  });

  // ---- 1. Actual contributions and independent exit intents. ----
  const asOf = confirmationEpoch(input.asOf);
  if (asOf === null)
    issues.push(
      issue("ASOF_INVALID", "composition asOf must carry an explicit timezone"),
    );

  const actualSnapshot = input.actualContributions;
  const actualSnapshotMissing = actualSnapshot === undefined;
  const actualTrace = traceFills(actualSnapshot ?? [], childIds, issues);
  if (actualSnapshotMissing)
    issues.push(
      issue(
        "UNTRACEABLE_CONTRIBUTION",
        "actual contribution snapshot is missing; exit amounts cannot be quantified",
      ),
    );

  const acknowledgedInput = input.acknowledgedExitIds ?? [];
  const acknowledged = new Set<string>();
  for (const exitId of acknowledgedInput) {
    if (!isNonEmptyString(exitId))
      throw new Error("acknowledged exit id must be non-empty");
    acknowledged.add(exitId);
  }

  const instructions = resolveInstructions(
    input.exitInstructions ?? [],
    issues,
  );
  const instructionGroups = new Map<string, ResolvedInstruction[]>();
  const instructionTargetByKey = new Map<string, number>();
  for (const instruction of instructions) {
    const key = keyOf(instruction.childId, instruction.symbol);
    const group = instructionGroups.get(key) ?? [];
    group.push(instruction);
    instructionGroups.set(key, group);
    const previous = instructionTargetByKey.get(key);
    if (previous === undefined || instruction.targetContribution < previous)
      instructionTargetByKey.set(key, instruction.targetContribution);
  }

  // Allocations are echoed even while configuration evidence is still unknown.
  const buildAllocations = (): CompositionAllocation[] =>
    input.children.map((child) => {
      let held = 0;
      for (const [key, value] of actualTrace.contributionByChildSymbol) {
        const { childId } = splitKey(key);
        if (childId === child.childId) held += value;
      }
      return {
        childId: child.childId,
        status: child.status,
        gateWeight:
          child.status === "valid"
            ? clean(gateWeightByChild.get(child.childId) ?? 0)
            : 0,
        rawTargetWeight: clean(
          rawTargetSumByChild.get(child.childId) ?? declaredTargetSum(child),
        ),
        heldContribution: clean(held),
      };
    });

  const finish = (
    status: CompositionStatus,
    targetContributions: Readonly<Record<string, number>> | null,
    targetByChildSymbol: Map<string, number> | null,
    requestedReductions: CompositionReduction[],
    pendingUnknownReductions: CompositionPendingUnknownReduction[],
  ): ComposeLongOnlyStrategiesResult => {
    let finalStatus = status;
    const remaining = targetByChildSymbol
      ? aggregateChildSymbolTargets(targetByChildSymbol)
      : null;
    let gross: number | null = null;
    let cash: number | null = null;
    if (remaining) {
      let total = 0;
      for (const value of Object.values(remaining)) total += value;
      gross = clean(total);
      cash = clean(Math.max(0, 1 - gross));
      if (gross > 1 + EPSILON) {
        issues.push(
          issue(
            "GROSS_EXCEEDS_LIMIT",
            `remaining long target ${gross} exceeds total NAV`,
          ),
        );
      }
      if (status === "TARGET" && gross > input.grossLimit + EPSILON) {
        issues.push(
          issue(
            "GROSS_EXCEEDS_LIMIT",
            `remaining long target ${gross} exceeds the gross limit ${input.grossLimit} after carrying unknown holdings`,
          ),
        );
      }
    }
    // Unknown audit evidence must never masquerade as a complete target.
    if (
      finalStatus === "TARGET" &&
      issues.some((entry) => entry.severity === "UNKNOWN")
    ) {
      finalStatus = "UNKNOWN";
      targetContributions = null;
    }
    const acknowledgedReductions = requestedReductions.filter(
      (reduction) => reduction.acknowledged,
    );
    pendingUnknownReductions.sort(
      (left, right) =>
        compareText(left.childId, right.childId) ||
        compareText(left.symbol, right.symbol) ||
        compareText(left.exitId, right.exitId),
    );
    return {
      status: finalStatus,
      asOf,
      gateFrozenAt,
      rebalanceDue: input.rebalanceDue,
      hardExit: input.hardExit,
      targetContributions,
      remainingTargetContributions: remaining,
      grossTarget: gross,
      cashTarget: cash,
      requestedReductions,
      acknowledgedReductions,
      pendingUnknownReductions,
      allocations: buildAllocations(),
      issues: sortIssues(issues),
    };
  };

  // A portfolio hard exit always wins. It is a full-cash intent, never a
  // fabricated liquidation. When actual is missing it stays a cash intent but
  // no reduction amount or holding list is invented.
  if (input.hardExit) {
    const requested: CompositionReduction[] = [];
    for (const [key, actual] of [...actualTrace.contributionByChildSymbol].sort(
      (left, right) => compareText(left[0], right[0]),
    )) {
      if (actual <= EPSILON) continue;
      const { childId, symbol } = splitKey(key);
      requested.push({
        exitId: `hard-exit:${childId}:${symbol}`,
        childId,
        symbol,
        kind: "hard-exit",
        actualContribution: clean(actual),
        targetContribution: 0,
        requested: clean(actual),
        remainingContribution: 0,
        acknowledged: false,
      });
    }
    const targetByChildSymbol = new Map<string, number>();
    for (const key of actualTrace.contributionByChildSymbol.keys())
      targetByChildSymbol.set(key, 0);
    return finish("HARD_EXIT", null, targetByChildSymbol, requested, []);
  }

  const reductions = buildReductions(
    instructionGroups,
    actualTrace.contributionByChildSymbol,
    acknowledged,
    actualTrace.untraceableKeys,
  );

  // Instructions against an unknown child with no traceable entry cannot be
  // quantified. Keep them visible rather than silently returning no exit.
  const pendingUnknown = [...reductions.pendingUnknown];
  if (actualSnapshotMissing) {
    for (const instruction of instructions) {
      pendingUnknown.push({
        exitId: instruction.exitId,
        childId: instruction.childId,
        symbol: instruction.symbol,
        kind: instruction.kind,
        targetContribution: clean(instruction.targetContribution),
        reason: "ACTUAL_SNAPSHOT_MISSING",
      });
    }
  } else {
    for (const instruction of instructions) {
      const key = keyOf(instruction.childId, instruction.symbol);
      if (actualTrace.contributionByChildSymbol.has(key)) continue;
      if (actualTrace.untraceableKeys.has(key)) continue;
      const childStatus = childStatusById.get(instruction.childId);
      if (childStatus === "unknown" || childStatus === undefined) {
        pendingUnknown.push({
          exitId: instruction.exitId,
          childId: instruction.childId,
          symbol: instruction.symbol,
          kind: instruction.kind,
          targetContribution: clean(instruction.targetContribution),
          reason:
            childStatus === "unknown"
              ? "UNKNOWN_CHILD"
              : "UNTRACEABLE_CONTRIBUTION",
        });
      }
    }
  }

  // ---- 2. New configuration and gate eligibility. ----
  input.children.forEach((child) => {
    const validated = validateChildTargets(child, issues);
    if (child.status === "valid") {
      if (validated.weights === null) {
        if (child.targetWeights === undefined || child.targetWeights === null)
          validTargetMissing = true;
      } else {
        targetWeightByChild.set(child.childId, validated.weights);
      }
    }
    if (child.status === "unknown") unknownChildPresent = true;
    rawTargetSumByChild.set(child.childId, validated.sum);
  });

  const gate = input.gate;
  const gateResult = gate
    ? validateGate(gate, asOf, input.children.length, issues)
    : null;
  if (!gate) issues.push(issue("GATE_MISSING", "current gate mix is unknown"));
  let alpha: number[] | null = null;
  if (gateResult) {
    if (input.alpha == null)
      issues.push(issue("ALPHA_MISSING", "state probabilities are unknown"));
    else alpha = validateAlpha(input.alpha, gateResult.rows.length, issues);
  }
  if (validTargetMissing)
    issues.push(
      issue(
        "VALID_TARGET_UNKNOWN",
        "a valid child has no declared target weights",
      ),
    );
  if (unknownChildPresent)
    issues.push(
      issue(
        "UNKNOWN_CHILD_STATUS",
        "a child strategy status is unknown; no new allocation is permitted",
      ),
    );
  gateFrozenAt = gateResult?.frozenAt ?? null;
  if (gateResult && alpha) {
    for (let childIndex = 0; childIndex < input.children.length; childIndex++) {
      let weight = 0;
      for (let rowIndex = 0; rowIndex < gateResult.rows.length; rowIndex++) {
        const row = gateResult.rows[rowIndex];
        const probability = alpha[rowIndex];
        if (!row || probability === undefined) continue;
        weight += probability * (row[childIndex] ?? 0);
      }
      gateWeightByChild.set(input.children[childIndex]!.childId, weight);
    }
  }

  // No new composition target: carry traceable actual holdings and apply only
  // protective exit caps. This is used for a non-due date and an unknown gate.
  const holdPrevious = () => {
    const targetByChildSymbol = new Map<string, number>();
    for (const [key, actual] of actualTrace.contributionByChildSymbol) {
      const instructionTarget = instructionTargetByKey.get(key);
      const value =
        instructionTarget === undefined
          ? actual
          : Math.min(actual, instructionTarget);
      targetByChildSymbol.set(key, value);
    }
    return targetByChildSymbol;
  };

  const missingGate =
    !gateResult || !alpha || validTargetMissing || unknownChildPresent;
  const hasUnknownAudit = issues.some((entry) => entry.severity === "UNKNOWN");
  // Unknown configuration or evidence is checked before the rebalance
  // calendar: a non-due date only keeps KEEP_PREVIOUS_TARGET when the current
  // configuration and facts are actually known.
  if (missingGate || hasUnknownAudit || actualSnapshotMissing) {
    return finish(
      "UNKNOWN",
      null,
      !actualSnapshotMissing &&
        !actualTrace.invalidEvidence &&
        actualTrace.untraceableKeys.size === 0
        ? holdPrevious()
        : null,
      reductions.requested,
      pendingUnknown,
    );
  }
  if (!input.rebalanceDue) {
    return finish(
      "KEEP_PREVIOUS_TARGET",
      null,
      holdPrevious(),
      reductions.requested,
      pendingUnknown,
    );
  }

  // ---- 3. Cap and gross limit for the new target. ----
  if (!isUnitFraction(input.capPerSymbol))
    throw new Error("composition capPerSymbol must be in [0, 1]");
  if (!isUnitFraction(input.grossLimit))
    throw new Error("composition grossLimit must be in [0, 1]");

  // Soft gate and per-child contributions.
  const rawBySymbolChild = new Map<
    string,
    { key: string; childId: string; raw: number }[]
  >();
  const u = new Map<string, number>();
  for (const child of input.children) {
    if (child.status !== "valid") continue;
    const weights = targetWeightByChild.get(child.childId);
    if (!weights) continue;
    const gateWeight = gateWeightByChild.get(child.childId) ?? 0;
    if (gateWeight <= 0) continue;
    for (const [symbol, weight] of Object.entries(weights)) {
      const raw = gateWeight * weight;
      if (raw <= 0) continue;
      u.set(symbol, (u.get(symbol) ?? 0) + raw);
      const key = keyOf(child.childId, symbol);
      const bucket = rawBySymbolChild.get(symbol) ?? [];
      bucket.push({ key, childId: child.childId, raw });
      rawBySymbolChild.set(symbol, bucket);
    }
  }

  // Cap first, then scale the whole vector to the gross limit.
  const capped = new Map<string, number>();
  for (const [symbol, value] of u)
    capped.set(symbol, Math.min(value, input.capPerSymbol));
  let cappedTotal = 0;
  for (const value of capped.values()) cappedTotal += value;
  const scale =
    cappedTotal > input.grossLimit + EPSILON
      ? input.grossLimit / cappedTotal
      : 1;
  const composed = new Map<string, number>();
  for (const [symbol, value] of capped)
    composed.set(symbol, clean(value * scale));

  const targetByChildSymbol = new Map<string, number>();
  for (const [symbol, symbolTarget] of composed) {
    const bucket = rawBySymbolChild.get(symbol) ?? [];
    let rawTotal = 0;
    for (const item of bucket) rawTotal += item.raw;
    if (rawTotal <= EPSILON) continue;
    for (const item of bucket) {
      const share = (item.raw / rawTotal) * symbolTarget;
      targetByChildSymbol.set(item.key, share);
    }
  }

  // Unknown children receive no new allocation; carry traceable actual. An
  // undeclared child id is treated the same way and already has an audit issue.
  for (const [key, actual] of actualTrace.contributionByChildSymbol) {
    const { childId } = splitKey(key);
    const status = childStatusById.get(childId) ?? "unknown";
    if (status === "unknown") {
      targetByChildSymbol.set(key, actual);
    } else if (!targetByChildSymbol.has(key)) {
      // A valid child no longer targeting this symbol, or an invalid child,
      // receives an explicit zero target rather than an absent instruction.
      targetByChildSymbol.set(key, 0);
    }
  }

  // Protective exits cap the effective target and forbid new additions while
  // pending. The per-child cap is min(composed, instruction target, actual).
  for (const [key, instructionTarget] of instructionTargetByKey) {
    const current = targetByChildSymbol.get(key) ?? 0;
    const actual = actualTrace.contributionByChildSymbol.get(key) ?? 0;
    targetByChildSymbol.set(key, Math.min(current, instructionTarget, actual));
  }

  const targetContributions: Record<string, number> = {};
  for (const symbol of [...composed.keys()].sort(compareText))
    targetContributions[symbol] = clean(composed.get(symbol) ?? 0);

  return finish(
    "TARGET",
    targetContributions,
    targetByChildSymbol,
    reductions.requested,
    pendingUnknown,
  );
}
