import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  DIAGNOSE_SAMPLE_LIMIT,
  DIAGNOSE_SCENARIO_PRESETS,
  diagnoseArchiveSummarySchema,
  diagnoseSampleFillSchema,
  diagnoseSampleOrderSchema,
  diagnoseSampleRejectionSchema,
  diagnoseScenarioMetricsSchema,
  type DiagnoseArchiveDetail,
  type DiagnoseArchiveSummary,
  type DiagnoseScenarioCellGroup,
  type DiagnoseScenarioMetrics,
} from "~/lib/research/diagnose-contract";
import {
  checked,
  directories,
  readBounded,
  safeSegment,
  UnsafeArchivePath,
} from "./archive-fs";

const cellFiles = [
  "run.json",
  "summary.json",
  "diagnostics.json",
  "orders.csv",
  "fills.csv",
  "rejections.csv",
  "bars.csv",
  "equity.csv",
  "positions.json",
];
type CliLocation = string[];
const locationId = (parts: CliLocation) =>
  parts.length === 1
    ? `cli-${parts[0]}`
    : `cli-~${Buffer.from(parts.join("/")).toString("base64url")}`;

export function decodeCliLocation(id: string): CliLocation {
  if (!id.startsWith("cli-") || id.length > 4096)
    throw new Error("非法诊断归档 ID");
  const parts = id.startsWith("cli-~")
    ? Buffer.from(id.slice(5), "base64url").toString("utf8").split("/")
    : [id.slice(4)];
  if (
    locationId(parts) !== id ||
    !parts.every(safeSegment) ||
    parts.length > 4 ||
    (parts.length > 1 && parts[0] !== "backtest-diagnose")
  )
    throw new Error("非法诊断归档路径");
  return parts;
}

async function flatCells(path: string) {
  const cells: string[] = [];
  for (const name of await directories(path)) {
    // Other .test-data tools also produce run.json. Only index diagnostic cells.
    const run = await metadata(
      join(/*turbopackIgnore: true*/ path, name),
      "run.json",
      new Set(),
      "",
    );
    if (typeof run.strategyKey === "string" && Array.isArray(run.symbols))
      cells.push(name);
  }
  return cells;
}

async function isReport(path: string) {
  for (const mode of ["per-symbol", "portfolio"])
    if (await checked(join(/*turbopackIgnore: true*/ path, mode), "directory"))
      return true;
  const header = await readBounded(
    join(/*turbopackIgnore: true*/ path, "report.md"),
    1024,
  );
  if (header?.text.startsWith("# 回测诊断报告")) return true;
  const issues = new Set<string>();
  const run = await metadata(path, "run.json", issues, "");
  if (typeof run.strategyKey === "string" && Array.isArray(run.symbols))
    return true;
  const summary = await metadata(path, "summary.json", issues, "");
  if (
    ["ok", "blocked", "failed"].includes(String(summary.status)) &&
    "bars" in object(summary.counts)
  )
    return true;
  return (await flatCells(path)).length > 0;
}

/** Ordinary directories are inspected only at the root. The CLI's own
 * backtest-diagnose/<batch>/[<variant>/]<run> layout is explicitly recognized. */
export async function discoverCliArchives(
  root: string,
): Promise<CliLocation[]> {
  const reports: CliLocation[] = [];
  async function inspect(parts: string[]) {
    const path = join(/*turbopackIgnore: true*/ root, ...parts);
    try {
      if (await isReport(path)) {
        reports.push(parts);
        return;
      }
    } catch (error) {
      if (error instanceof UnsafeArchivePath) return;
      throw error;
    }
    if (parts[0] !== "backtest-diagnose" || parts.length >= 4) return;
    for (const name of await directories(path)) {
      if (["native-cache", "data", "tools"].includes(name)) continue;
      await inspect([...parts, name]);
    }
  }
  for (const entry of await directories(root)) await inspect([entry]);
  return reports;
}

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
const stringValue = (value: unknown) =>
  typeof value === "string" ? value.slice(0, 1024) : undefined;
const numberValue = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .filter((v): v is string => typeof v === "string")
        .slice(0, 256)
        .map((v) => v.slice(0, 1024))
    : [];

async function metadata(
  path: string,
  name: string,
  issues: Set<string>,
  cell: string,
) {
  const content = await readBounded(
    join(/*turbopackIgnore: true*/ path, name),
    2 * 1024 * 1024,
  );
  if (content && !content.truncated) {
    try {
      return object(JSON.parse(content.text));
    } catch {
      /* incomplete CLI artifact */
    }
  }
  issues.add([cell, name].filter(Boolean).join("/"));
  return {};
}

interface CellLocation {
  parts: string[];
  mode: DiagnoseScenarioCellGroup["mode"];
  strategy?: string;
  symbol?: string;
}

async function cellLocations(root: string) {
  const cells: CellLocation[] = [];
  for (const mode of ["per-symbol", "portfolio"] as const)
    for (const strategy of await directories(
      join(/*turbopackIgnore: true*/ root, mode),
      true,
    ))
      for (const leaf of await directories(
        join(/*turbopackIgnore: true*/ root, mode, strategy),
        true,
      )) {
        cells.push({
          parts: [mode, strategy, leaf],
          mode,
          strategy,
          symbol: mode === "per-symbol" ? leaf : undefined,
        });
      }
  if (cells.length) return cells;
  for (const name of await flatCells(root))
    cells.push({ parts: [name], mode: "per-symbol" });
  if (cells.length) return cells;
  if (
    (await checked(join(/*turbopackIgnore: true*/ root, "run.json"), "file")) ||
    (await checked(
      join(/*turbopackIgnore: true*/ root, "summary.json"),
      "file",
    ))
  )
    cells.push({ parts: [], mode: "per-symbol" });
  return cells;
}

// Handles quoted separators/newlines and doubled quotes from the CLI writer.
// End-of-input inside a truncated row is discarded.
function* csvRecords(text: string, truncated: boolean) {
  let row: string[] = [],
    field = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && c === ",") {
      row.push(field);
      field = "";
    } else if (!quoted && c === "\n") {
      row.push(field.replace(/\r$/, ""));
      yield row;
      row = [];
      field = "";
    } else field += c;
  }
  if (!truncated && !quoted && (field || row.length))
    yield [...row, field.replace(/\r$/, "")];
  if (!truncated && quoted) yield []; // Unterminated record in the file itself.
}

const csvSchemas = {
  orders: diagnoseSampleOrderSchema,
  fills: diagnoseSampleFillSchema,
  rejections: diagnoseSampleRejectionSchema,
};
const numericCsvFields = new Set([
  "id",
  "orderId",
  "attempts",
  "price",
  "quantity",
  "fee",
  "cashAfter",
  "holdingAfter",
]);
async function csvDetails(
  path: string,
  name: keyof typeof csvSchemas,
  warnings: Set<string>,
  missing: Set<string>,
  cell: string,
) {
  const data = await readBounded(
    join(/*turbopackIgnore: true*/ path, `${name}.csv`),
    2 * 1024 * 1024,
  );
  const sample: JsonObject[] = [],
    reasons = new Map<string, number>();
  let fees: number | null = 0;
  if (!data || data.truncated) fees = null;
  if (data?.truncated)
    warnings.add(`${name}.csv 超出读取上限，仅显示已读取样本`);
  const records = csvRecords(data?.text ?? "", data?.truncated ?? false);
  const header = records.next().value;
  let rowNumber = 1;
  let malformed = false;
  if (header)
    for (const fields of records) {
      rowNumber++;
      const row = Object.fromEntries(
        header.map((key, index) => {
          const raw = fields[index] ?? "";
          return [
            key,
            raw === ""
              ? key === "due" || key === "reason"
                ? null
                : undefined
              : numericCsvFields.has(key)
                ? /^-?[0-9.]+(?:e[+-]?\d+)?$/i.test(raw)
                  ? Number(raw)
                  : undefined
                : key === "capacityClipped"
                  ? raw === "true"
                    ? true
                    : raw === "false"
                      ? false
                      : raw
                  : raw.slice(0, 1024),
          ];
        }),
      );
      const parsed = csvSchemas[name].safeParse(row);
      if (!parsed.success || fields.length !== header.length) {
        if (!malformed) {
          const file = [cell, `${name}.csv`].filter(Boolean).join("/");
          const issue = parsed.success
            ? "列数不匹配"
            : `字段 ${parsed.error.issues[0]?.path.join(".")} 无效`;
          missing.add(file);
          warnings.add(`${file}: 第 ${rowNumber} 行${issue}，已跳过无效记录`);
        }
        malformed = true;
        fees = null;
        continue;
      }
      if ("fee" in parsed.data && fees !== null) {
        const nextFees = fees + parsed.data.fee;
        if (Number.isFinite(nextFees)) fees = nextFees;
        else {
          const file = [cell, `${name}.csv`].filter(Boolean).join("/");
          missing.add(file);
          warnings.add(`${file}: 费用汇总溢出，已忽略总费用`);
          fees = null;
        }
      }
      if (name === "rejections" && typeof row.reason === "string")
        reasons.set(row.reason, (reasons.get(row.reason) ?? 0) + 1);
      if (sample.length < DIAGNOSE_SAMPLE_LIMIT) sample.push(parsed.data);
    }
  return {
    sample,
    fees,
    reasons:
      data?.truncated || malformed
        ? []
        : [...reasons]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 100)
            .map(([reason, count]) => ({ reason, count })),
  };
}

function scenarioDescription(run: JsonObject) {
  const executionProfile = stringValue(run.executionProfile) ?? "strict";
  const maxParticipation = numberValue(run.maxParticipation);
  const capacityPolicy =
    run.capacityPolicy === "clip" || run.capacityPolicy === "reject"
      ? run.capacityPolicy
      : null;
  const scenarioId =
    maxParticipation === null
      ? executionProfile
      : [
          executionProfile === "strict" ? "" : executionProfile,
          "cap",
          Number((100 * maxParticipation).toFixed(8)),
          capacityPolicy ?? "default",
        ]
          .filter((v) => v !== "")
          .join("-");
  const preset = Object.values(DIAGNOSE_SCENARIO_PRESETS).find(
    (item) => item.id === scenarioId,
  );
  return {
    executionProfile,
    maxParticipation,
    capacityPolicy,
    scenarioId,
    label: preset?.label ?? scenarioId,
  };
}

function metricOptions(
  run: JsonObject,
  summary: JsonObject,
  diagnostic: JsonObject,
) {
  const counts = object(summary.counts ?? diagnostic.counts);
  const overview = object(summary.overview);
  const status = summary.status ?? diagnostic.status ?? run.status;
  const checks = Array.isArray(diagnostic.checks)
    ? diagnostic.checks.slice(0, 24).map(object)
    : [];
  // Bound legacy evidence without modifying the status, ID or message.
  for (const check of checks)
    if (
      check.evidence !== undefined &&
      JSON.stringify(check.evidence).length > 2048
    )
      delete check.evidence;
  const capacity = scenarioDescription(run);
  const clipped = numberValue(counts.capacityClippedFills) ?? 0;
  const ratio = checks.find((c) => c.id === "capacityRatio");
  const capacityActive =
    capacity.maxParticipation !== null &&
    (clipped > 0 ||
      (numberValue(object(ratio?.evidence).largestShare) ?? 0) > 0);
  return {
    ...capacity,
    status: (status === "ok" || status === "blocked"
      ? status
      : "failed") as DiagnoseScenarioMetrics["status"],
    layer: stringValue(summary.layer ?? run.layer),
    error: stringValue(run.error ?? summary.error),
    counts: {
      bars: 0,
      warmup: 0,
      signals: 0,
      orders: 0,
      fills: 0,
      rejections: 0,
      closedTrades: 0,
      ...counts,
    },
    totalReturn: numberValue(object(overview.totalReturn).value),
    maxDrawdown: numberValue(object(overview.maxDrawdown).value),
    checks,
    findings: strings(diagnostic.findings ?? summary.findings),
    capacityActive,
    capacityNote:
      capacity.maxParticipation !== null && !capacityActive
        ? "归档中缺少可确认容量约束生效的成交额证据"
        : undefined,
    inputHash: stringValue(run.inputHash),
    timingStatus: stringValue(run.timingStatus),
    nativeChan: run.nativeChan ?? summary.nativeChan,
    canslimPit: run.canslimPit ?? summary.canslimPit,
    growthPit: run.growthPit ?? summary.growthPit,
    wyckoffFunnel: run.wyckoffFunnel ?? summary.wyckoffFunnel,
  };
}

export async function readCliReport(
  base: string,
  parts: CliLocation,
  page: { page: number; pageSize: number; offset: number },
  drift: (hashes: Iterable<string>) => Promise<string[]>,
): Promise<Omit<DiagnoseArchiveDetail, "boundaryState">> {
  const root = join(/*turbopackIgnore: true*/ base, ...parts),
    st = await checked(root, "directory");
  if (!st || !(await isReport(root))) throw new Error("CLI 诊断报告不存在");
  const missing = new Set<string>(),
    warnings = new Set<string>(),
    hashes = new Set<string>();
  const strategyKeys = new Set<string>(),
    allSymbols = new Set<string>(),
    scenarios = new Set<string>();
  const statusCounts = { ok: 0, blocked: 0, failed: 0, zeroSignal: 0 };
  const cells: DiagnoseScenarioCellGroup[] = [];
  const locations = await cellLocations(root);
  let generatedAt: string | undefined, pool: DiagnoseArchiveSummary["pool"];
  const reportHeader = await readBounded(
    join(/*turbopackIgnore: true*/ root, "report.md"),
    4096,
  );
  if (!reportHeader) {
    missing.add("report.md");
  } else {
    const declared = /^-\s*单元：(\d+)\b/m.exec(reportHeader.text);
    if (declared && Number(declared[1]) !== locations.length) {
      missing.add("cells");
    }
  }
  if (!locations.length) missing.add("run.json");
  for (const [index, cell] of locations.entries()) {
    const path = join(/*turbopackIgnore: true*/ root, ...cell.parts),
      label = cell.parts.join("/");
    await checked(path, "directory");
    const entries = await readdir(/*turbopackIgnore: true*/ path, {
      withFileTypes: true,
    });
    for (const name of cellFiles) {
      const entry = entries.find((e) => e.name === name);
      if (!entry) missing.add([label, name].filter(Boolean).join("/"));
      else if (!entry.isFile()) throw new UnsafeArchivePath();
    }
    const [run, summary] = (await Promise.all(
      ["run.json", "summary.json"].map((name) =>
        metadata(path, name, missing, label),
      ),
    )) as [JsonObject, JsonObject];
    const inPage = index >= page.offset && index < page.offset + page.pageSize;
    const diagnostic = inPage
      ? await metadata(path, "diagnostics.json", missing, label)
      : {};
    const scenario = metricOptions(run, summary, diagnostic);
    const strategyKey =
      cell.strategy ??
      stringValue(run.strategyKey)?.replace(/^diag-/, "") ??
      "unknown";
    const symbols = strings(run.symbols);
    if (!symbols.length && cell.symbol) symbols.push(cell.symbol);
    const date = stringValue(run.generatedAt);
    if (date && (!generatedAt || date > generatedAt)) generatedAt = date;
    strategyKeys.add(strategyKey);
    symbols.forEach((symbol) => allSymbols.add(symbol));
    scenarios.add(scenario.scenarioId);
    statusCounts[scenario.status]++;
    if (scenario.status === "ok" && scenario.counts.signals === 0)
      statusCounts.zeroSignal++;
    if (!pool && (run.pool || summary.pool)) {
      const validated = diagnoseArchiveSummarySchema.shape.pool.safeParse(
        run.pool ?? summary.pool,
      );
      if (validated.success) pool = validated.data;
    }
    for (const native of Array.isArray(scenario.nativeChan)
      ? scenario.nativeChan
      : []) {
      const hash = stringValue(object(object(native).identity).dllHash);
      if (hash) hashes.add(hash);
    }
    if (!inPage) continue;
    const [orders, fills, rejections] = await Promise.all([
      csvDetails(path, "orders", warnings, missing, label),
      csvDetails(path, "fills", warnings, missing, label),
      csvDetails(path, "rejections", warnings, missing, label),
    ]);
    const metrics = diagnoseScenarioMetricsSchema.parse({
      ...scenario,
      sampleOrders: orders.sample,
      sampleFills: fills.sample,
      sampleRejections: rejections.sample,
      totalFees: fills.fees,
      rejectionReasons: rejections.reasons,
    });
    cells.push({
      strategyKey,
      symbols,
      mode:
        cell.mode === "portfolio" || run.mode === "portfolio"
          ? "portfolio"
          : "per-symbol",
      start: stringValue(run.start),
      end: stringValue(run.end),
      scenarios: [metrics],
    });
  }
  if (missing.size) warnings.add(`缺少或无法读取 ${missing.size} 个报告文件`);
  const summary = {
    id: locationId(parts),
    source: "cli-report" as const,
    title: parts.join("/"),
    generatedAt: generatedAt ?? st.mtime.toISOString(),
    strategyKeys: [...strategyKeys],
    symbols: [...allSymbols],
    pool,
    scenarios: [...scenarios],
    statusCounts,
    driftWarnings: [...warnings, ...(await drift(hashes))].slice(0, 100),
    missingFiles: [...missing].slice(0, 100),
  };
  return {
    summary,
    cells,
    pagination: {
      page: page.page,
      pageSize: page.pageSize,
      totalCells: locations.length,
    },
  };
}
