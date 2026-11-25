import { z } from "zod";
import {
  SW_ALL_SECTORS,
  SW_L1_SECTORS,
  SW_L2_SECTORS,
  type SwSectorDef,
} from "~/lib/financial/sw-sector-codes";
import {
  swSectorValuationInput,
  type SwSectorValuationResult,
  type SwSectorValuationRow,
} from "~/lib/financial/sw-sector-valuation";
import {
  query,
  WestockError,
  westockScriptPath,
} from "../data-sources/westock/westock-data";

export const SW_VALUATION_BATCH_SIZE = 30;
export const SW_VALUATION_CACHE_TTL_MS = 10 * 60_000;

const knownCodes = new Set(SW_ALL_SECTORS.map(({ code }) => code));
const l1Names = SW_L1_SECTORS.map(({ name }) => name);
const counts = { l1: SW_L1_SECTORS.length, l2: SW_L2_SECTORS.length };

const sourceCode = z
  .string()
  .trim()
  .regex(/^(?:pt01)?\d{6}$/i)
  .transform((code) => `pt01${code.slice(-6)}`)
  .catch("");
const sourceDate = z
  .union([z.string(), z.number().int()])
  .transform((date) =>
    String(date).replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3"),
  )
  .pipe(z.string().date())
  .nullable()
  .catch(null);
const sourceNumber = z.number().finite().nullable().catch(null);

function percentileField(value: number | null) {
  return value !== null && value >= 0 && value <= 100 ? value : null;
}

const sourcePercentile = sourceNumber.transform(percentileField);
const sourceBatch = z.array(z.unknown());
const sourceRow = z.object({
  code: sourceCode,
  IndustryCode: sourceCode,
  EndDate: sourceDate,
  PeTTM: sourceNumber,
  PeTTMPct: sourcePercentile,
  PeTTMPrevM: sourceNumber,
  PeTTMPrevY: sourceNumber,
  PbLF: sourceNumber,
  PbLFPct: sourcePercentile,
  PbLFPrevM: sourceNumber,
  PbLFPrevY: sourceNumber,
  DivTTM: sourceNumber,
  DivTTMPct: sourcePercentile,
  DivTTMPrevM: sourceNumber,
  DivTTMPrevY: sourceNumber,
});

type SourceRow = z.output<typeof sourceRow>;
type Execute = (args: string[], signal?: AbortSignal) => Promise<unknown>;
type ValuationSnapshot = {
  rows: SwSectorValuationRow[];
  asOfDate: string | null;
  available: boolean;
  warning: string | null;
  fetchedAt: number;
};

let cachedSnapshot: ValuationSnapshot | undefined;

export function clearSwSectorValuationCache() {
  cachedSnapshot = undefined;
}

function executeWestock(args: string[], signal?: AbortSignal) {
  return query(westockScriptPath(), args, signal, true);
}

function canRetry(error: unknown) {
  if (error instanceof WestockError)
    return !/^SKILL_001(?:_|$)/.test(error.code);
  return (
    !(error instanceof Error) ||
    !["腾讯查询工具无法启动", "腾讯响应超出限制"].includes(error.message)
  );
}

async function fetchBatch(
  codes: string[],
  execute: Execute,
  signal?: AbortSignal,
): Promise<unknown[] | null> {
  const args = ["sector", "valuation", codes.join(",")];
  for (let attempt = 0; attempt < 2; attempt++) {
    signal?.throwIfAborted();
    try {
      const raw = await execute(args, signal);
      signal?.throwIfAborted();
      return sourceBatch.parse(raw);
    } catch (error) {
      signal?.throwIfAborted();
      if (!canRetry(error)) break;
    }
  }
  return null;
}

function toRow(
  { code, swCode, name, level, parentL1 }: SwSectorDef,
  source: SourceRow | undefined,
): SwSectorValuationRow {
  const values = {
    pe: source?.PeTTM ?? null,
    pePct: source?.PeTTMPct ?? null,
    pePrevM: source?.PeTTMPrevM ?? null,
    pePrevY: source?.PeTTMPrevY ?? null,
    pb: source?.PbLF ?? null,
    pbPct: source?.PbLFPct ?? null,
    pbPrevM: source?.PbLFPrevM ?? null,
    pbPrevY: source?.PbLFPrevY ?? null,
    div: source?.DivTTM ?? null,
    divPct: source?.DivTTMPct ?? null,
    divPrevM: source?.DivTTMPrevM ?? null,
    divPrevY: source?.DivTTMPrevY ?? null,
  };
  return {
    code,
    swCode,
    name,
    level,
    parentL1,
    endDate: source?.EndDate ?? null,
    ...values,
    missing: Object.values(values).every((value) => value === null),
  };
}

async function fetchSnapshot(
  execute: Execute,
  signal?: AbortSignal,
  now?: number,
): Promise<ValuationSnapshot> {
  const latestByCode = new Map<string, SourceRow>();
  let failedBatches = 0;
  for (let i = 0; i < SW_ALL_SECTORS.length; i += SW_VALUATION_BATCH_SIZE) {
    const codes = SW_ALL_SECTORS.slice(i, i + SW_VALUATION_BATCH_SIZE).map(
      ({ code }) => code,
    );
    const batch = await fetchBatch(codes, execute, signal);
    if (batch === null) {
      failedBatches++;
      continue;
    }
    for (const item of batch) {
      const parsed = sourceRow.safeParse(item);
      if (!parsed.success) continue;
      const row = parsed.data;
      const code = knownCodes.has(row.code) ? row.code : row.IndustryCode;
      if (!knownCodes.has(code)) continue;
      const previous = latestByCode.get(code);
      if (!previous || (row.EndDate ?? "") >= (previous.EndDate ?? ""))
        latestByCode.set(code, row);
    }
  }
  signal?.throwIfAborted();

  const rows = SW_ALL_SECTORS.map((sector) =>
    toRow(sector, latestByCode.get(sector.code)),
  );
  let asOfDate: string | null = null;
  for (const { endDate, missing } of rows) {
    if (!missing && endDate && endDate > (asOfDate ?? "")) asOfDate = endDate;
  }
  return {
    rows,
    asOfDate,
    available:
      failedBatches === 0 &&
      rows.some((row) => row.level === "l1" && !row.missing),
    warning: failedBatches
      ? `腾讯自选股有 ${failedBatches} 批板块估值查询失败，部分板块数据暂缺`
      : null,
    fetchedAt: now ?? Date.now(),
  };
}

function peGroup(pe: number | null) {
  if (pe === null) return 2;
  return pe > 0 ? 0 : 1;
}

export async function swSectorValuation(
  rawInput: unknown,
  options?: { signal?: AbortSignal; now?: number; execute?: Execute },
): Promise<SwSectorValuationResult> {
  const { level, search, sort, descending, refresh, parentL1 } =
    swSectorValuationInput.parse(rawInput ?? {});
  const parent = level === "l2" ? parentL1 || null : null;
  const { signal, now = Date.now(), execute = executeWestock } = options ?? {};
  signal?.throwIfAborted();
  const hit =
    !refresh &&
    cachedSnapshot &&
    now - cachedSnapshot.fetchedAt < SW_VALUATION_CACHE_TTL_MS
      ? cachedSnapshot
      : undefined;
  const snapshot = hit ?? (await fetchSnapshot(execute, signal, options?.now));
  signal?.throwIfAborted();
  if (!hit && snapshot.available) cachedSnapshot = snapshot;

  const needle = search.toLowerCase();
  const rows = snapshot.rows
    .filter(
      (row) =>
        row.level === level &&
        (parent === null || row.parentL1 === parent) &&
        [row.name, row.swCode, row.parentL1].some((text) =>
          text?.toLowerCase().includes(needle),
        ),
    )
    .map((row) => ({ ...row }));
  rows.sort((a, b) => {
    if (sort === "pePct") {
      const groupOrder = peGroup(a.pe) - peGroup(b.pe);
      if (groupOrder !== 0) return groupOrder;
    }
    const left = a[sort];
    const right = b[sort];
    if (left === null || right === null) {
      return (
        Number(left === null) - Number(right === null) ||
        a.code.localeCompare(b.code)
      );
    }
    if (sort === "pe") {
      const leftLoss = left <= 0;
      const rightLoss = right <= 0;
      if (leftLoss !== rightLoss) return leftLoss ? 1 : -1;
    }
    return (
      (descending ? right - left : left - right) || a.code.localeCompare(b.code)
    );
  });

  return {
    version: "sw-sector-valuation-1",
    source: "tencent/westock-data",
    available: snapshot.available,
    reason: snapshot.available
      ? null
      : (snapshot.warning ??
        "腾讯自选股（westock-data）板块估值暂不可得，请检查网络或稍后重试"),
    level,
    parentL1: parent,
    search,
    sort,
    descending,
    counts: { ...counts },
    l1Names: [...l1Names],
    asOfDate: snapshot.asOfDate,
    fetchedAt: snapshot.fetchedAt,
    cached: hit !== undefined,
    missingCount: rows.filter((row) => row.missing).length,
    warning: snapshot.warning,
    rows,
    total: rows.length,
  };
}
