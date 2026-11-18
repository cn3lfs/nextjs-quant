import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { dailyEquity } from "~/lib/backtest/daily-equity";
import { list, put } from "../db";
import { financialReplayTaskRows } from "../db/jobs";
import {
  researchJsonHash,
  writeResearchJsonAtomic,
} from "../research/research-run";
import {
  financialReplayResultDirectory,
  type FinancialReplayConfig,
} from "./financial-replay-source";
import {
  financialReplaySemanticHash,
  type FinancialReplayDiagnostics,
  type FinancialReplayResult,
} from "./financial-replay-core";
import {
  financialReplayInput,
  type FinancialReplayInput,
} from "~/lib/financial/financial-replay";

export type FinancialReplayJobResult = {
  reportId: string;
  status: "completed" | "blocked";
  hash: string;
  blockedReason: string | null;
  years: {
    year: number;
    status: "ready" | "blocked";
    positions: number;
    reason: string | null;
  }[];
};

export type FinancialReplayIndex = {
  id: string;
  identity: string;
  annualIdentity: string;
  hash: string;
  createdAt: number;
  checkedAt: string;
  status: "completed" | "blocked";
  input: FinancialReplayInput;
  years: FinancialReplayJobResult["years"];
  blockedReason: string | null;
  boundary: string;
};

export function financialReplayJobResult(
  result: FinancialReplayResult,
): FinancialReplayJobResult {
  return {
    reportId: result.id,
    status: result.status,
    hash: result.hash,
    blockedReason: result.blockedReason,
    years: result.years.map((year) => ({
      year: year.year,
      status: year.status,
      positions: year.positions,
      reason: year.reason,
    })),
  };
}

export function financialReplayIndex(
  result: FinancialReplayResult,
): FinancialReplayIndex {
  return {
    id: result.id,
    identity: result.identity,
    annualIdentity: result.annualIdentity,
    hash: result.hash,
    createdAt: result.createdAt,
    checkedAt: result.diagnostics.checkedAt,
    status: result.status,
    input: result.input,
    years: financialReplayJobResult(result).years,
    blockedReason: result.blockedReason,
    boundary: result.boundary,
  };
}

export function financialReplayResultPath(identity: string) {
  return join(financialReplayResultDirectory(identity), "result.json");
}

function validateStoredResult(
  value: unknown,
  expectedIdentity?: string,
): FinancialReplayResult {
  if (!value || typeof value !== "object")
    throw new Error("财务回放结果格式非法");
  const result = value as FinancialReplayResult;
  if (result.version !== "financial-replay-v1")
    throw new Error("财务回放结果版本不符");
  if (expectedIdentity && result.identity !== expectedIdentity)
    throw new Error("财务回放结果身份不符");
  if (result.id !== `financial-replay-${result.identity}`)
    throw new Error("财务回放结果ID不符");
  if (!result.annualIdentity || !/^[a-f0-9]{64}$/.test(result.annualIdentity))
    throw new Error("财务回放结果缺少年度身份");
  if (!result.diagnostics || typeof result.diagnostics.checkedAt !== "string")
    throw new Error("财务回放结果缺少运行诊断");
  if (!Array.isArray(result.readinessByInstrument))
    throw new Error("财务回放结果缺少逐标的就绪证据");
  const { hash, createdAt: _createdAt, ...content } = result;
  if (financialReplaySemanticHash(content) !== hash)
    throw new Error("财务回放结果内容哈希不符");
  if (result.status === "completed") {
    if (!result.request || !result.result || !result.summary)
      throw new Error("财务回放完成结果缺少冻结请求或回放结果");
  } else if (result.request || result.result || result.summary) {
    throw new Error("财务回放阻断结果不得携带组合回放");
  }
  return result;
}

export async function readFinancialReplayResult(
  identity: string,
  expectedIdentity = identity,
): Promise<FinancialReplayResult | null> {
  let body: string;
  try {
    body = await readFile(financialReplayResultPath(identity), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new Error("财务回放结果不是有效JSON");
  }
  return validateStoredResult(value, expectedIdentity);
}

/** Immutable publication through the shared checkpoint helper so a
 * cancellation/source fence runs immediately before the atomic link. A
 * concurrent writer is accepted only for the exact same source identity and
 * semantic content. */
function sameSemanticResult(
  existing: FinancialReplayResult,
  result: FinancialReplayResult,
) {
  return (
    existing.identity === result.identity &&
    existing.annualIdentity === result.annualIdentity &&
    existing.id === result.id &&
    financialReplaySemanticHash(existing) ===
      financialReplaySemanticHash(result)
  );
}

export async function writeFinancialReplayResult(
  result: FinancialReplayResult,
  beforeCommit?: () => void | Promise<void>,
): Promise<FinancialReplayResult> {
  await beforeCommit?.();
  try {
    await writeResearchJsonAtomic(
      financialReplayResultPath(result.identity),
      result,
      { immutable: true, beforeCommit },
    );
    return result;
  } catch (error) {
    // Immutable JSON always differs by createdAt/diagnostics on a duplicate
    // run. Accept only a saved result with the exact same source identity and
    // semantic content; every other filesystem/identity error is rethrown.
    if (
      !(error instanceof Error) ||
      !error.message.startsWith("Immutable research JSON differs:")
    )
      throw error;
    const existing = await readFinancialReplayResult(result.identity);
    if (existing && sameSemanticResult(existing, result)) return existing;
    throw new Error("并发写入的财务回放结果身份或语义内容不一致");
  }
}

export function indexFinancialReplay(result: FinancialReplayResult) {
  return put("financial-replay", result.id, financialReplayIndex(result));
}

const replayIdPattern = /^financial-replay-[a-f0-9]{64}$/;

export async function readFinancialReplay(
  id: string,
): Promise<FinancialReplayResult | null> {
  if (!replayIdPattern.test(id)) throw new Error("财务回放ID格式非法");
  const identity = id.slice("financial-replay-".length);
  return readFinancialReplayResult(identity);
}

export type FinancialReplayTask = {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  progress: number;
  phase: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  input: FinancialReplayInput | null;
  reportId: string | null;
};

/** Active and terminal replay jobs survive a page refresh through the task
 * records; the panel restores the frozen normalized input explicitly. */
export function financialReplayTasks(limit = 50): FinancialReplayTask[] {
  return financialReplayTaskRows(limit).map(({ input, ...row }) => {
    let decoded: FinancialReplayInput | null = null;
    if (input) {
      try {
        const parsed = financialReplayInput.safeParse(JSON.parse(input));
        decoded = parsed.success ? parsed.data : null;
      } catch {
        // A malformed legacy input makes only this task's input unknown.
        decoded = null;
      }
    }
    return {
      ...row,
      status: row.status as FinancialReplayTask["status"],
      progress:
        typeof row.progress === "number" && Number.isFinite(row.progress)
          ? row.progress
          : 0,
      phase: row.phase?.slice(0, 200) ?? null,
      error: row.error?.slice(0, 200) ?? null,
      input: decoded,
    };
  });
}

export async function financialReplayActivity(
  id: string,
  fillPage: number,
  rejectionPage: number,
  pageSize: number,
) {
  const result = await readFinancialReplay(id);
  if (!result?.result) return null;
  const fills = result.result.fills,
    rejections = result.result.rejections,
    offset = (page: number) => page * pageSize;
  return {
    id: result.id,
    status: result.status,
    initial: result.input.initial,
    equity: dailyEquity(result.result.curve),
    summary: result.summary ?? null,
    fills: {
      rows: fills.slice(offset(fillPage), offset(fillPage + 1)),
      total: fills.length,
      pageIndex: fillPage,
      pageSize,
    },
    rejections: {
      rows: rejections.slice(offset(rejectionPage), offset(rejectionPage + 1)),
      total: rejections.length,
      pageIndex: rejectionPage,
      pageSize,
    },
  };
}

export function financialReplayHistory(limit = 100) {
  return list<FinancialReplayIndex>("financial-replay", Math.min(limit, 100))
    .map(({ input, years, ...item }) => ({
      ...item,
      preset: input.preset,
      symbolCount: input.symbols.length,
      firstYear: input.firstYear,
      lastYear: input.lastYear,
      years: years.length,
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Task polling receives evidence without the run curve and frozen request;
 * the explicit export returns the complete replay document. */
export function financialReplayView(result: FinancialReplayResult) {
  const { request: _request, result: _result, ...view } = result;
  return view;
}

export type FinancialReplayReuseCheck = {
  resultIdentity: string;
  annualIdentity: string;
  financialSourceHash: string;
  calendarHash: string;
  researchCodeHash: string;
  poolHash: string;
  input: FinancialReplayInput;
};

export async function reuseFinancialReplayResult(
  check: FinancialReplayReuseCheck,
): Promise<FinancialReplayResult | null> {
  const existing = await readFinancialReplayResult(check.resultIdentity);
  if (!existing) return null;
  if (
    existing.annualIdentity !== check.annualIdentity ||
    existing.config.financialSourceHash !== check.financialSourceHash ||
    existing.config.calendarHash !== check.calendarHash ||
    existing.config.researchCodeHash !== check.researchCodeHash ||
    existing.config.poolHash !== check.poolHash ||
    researchJsonHash(existing.input) !== researchJsonHash(check.input)
  )
    throw new Error("财务回放结果来源身份不符，拒绝复用");
  return existing;
}

export type { FinancialReplayConfig, FinancialReplayDiagnostics };
