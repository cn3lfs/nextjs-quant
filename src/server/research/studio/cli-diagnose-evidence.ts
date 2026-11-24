import { join } from "node:path";
import { evaluatePerformance, topDrawdownEpisodes } from "quant-performance";
import {
  diagnoseFullFillSchema,
  diagnosePerformanceSchema,
  diagnoseScenarioEvidenceSchema,
  type DiagnoseScenarioCellGroup,
  type DiagnoseScenarioMetrics,
} from "~/lib/research/diagnose-contract";
import { parseTmtCsv } from "../../strategies/sentiment/tmt-cache";
import { readOptionalArchiveEvidence } from "../diagnose/archive-fs";
import {
  cliTradeExcursions,
  type EvidenceBar,
  type EvidenceFill,
} from "./diagnose-evidence";

function csvNumber(value: string | undefined) {
  return value && /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)
    ? Number(value)
    : NaN;
}

const csvFiles = {
  "equity.csv": { mib: 4, columns: ["date", "equity"] },
  "fills.csv": {
    mib: 8,
    columns: [
      "orderId",
      "strategyId",
      "sleeve",
      "symbol",
      "date",
      "side",
      "price",
      "quantity",
      "fee",
      "holdingAfter",
    ],
  },
  "bars.csv": { mib: 20, columns: ["date", "symbol", "high", "low", "close"] },
};
async function records(
  dir: string,
  name: keyof typeof csvFiles,
  notes: string[],
) {
  const { mib, columns } = csvFiles[name];
  const limit = mib * 1024 * 1024;
  const file = await readOptionalArchiveEvidence(
    join(/* turbopackIgnore: true */ dir, name),
    limit,
  );
  if (file && !file.truncated) {
    const header = file.text
      .slice(0, 1024)
      .split(/\r?\n/, 1)[0]!
      .replace(/^\uFEFF/, "")
      .split(",");
    if (columns.every((c) => header.includes(c))) {
      try {
        return parseTmtCsv(file.text);
      } catch {
        /* malformed evidence */
      }
    }
  }
  notes.push(`${name} 缺失、超限或格式无效`);
  return undefined;
}

/** All paths are fixed filenames under the cell selected by the archive reader.
 * Never open a path or market data source supplied by run.json. */
export async function enrichCliScenario(
  dir: string,
  cell: DiagnoseScenarioCellGroup,
  scenario: DiagnoseScenarioMetrics,
  run: Record<string, unknown> | undefined,
  summary: Record<string, unknown> | undefined,
) {
  const archived = diagnosePerformanceSchema.safeParse(summary?.overview);
  if (archived.success) scenario.performance = archived.data;
  if (!archived.success && scenario.status !== "ok") return;
  const notes: string[] = [];
  const equityRows = await records(dir, "equity.csv", notes);
  let calendar: string[] = [];
  if (equityRows?.length) {
    const equity = equityRows.map((row) => ({
      date: row.date!,
      value: csvNumber(row.equity),
    }));
    const initial = run?.initial ?? scenario.performance?.initial;
    const valid =
      diagnoseScenarioEvidenceSchema.shape.equity.unwrap().safeParse(equity)
        .success && equity.every((p, i) => !i || p.date > equity[i - 1]!.date);
    if (valid) {
      scenario.equity = equity;
      if (
        archived.success &&
        (equity.length !== archived.data.days ||
          equity[0]?.date !== archived.data.start ||
          equity.at(-1)?.date !== archived.data.end)
      ) {
        notes.push("可读权益序列与归档记录的交易日覆盖不符，仅保留已观测权益");
      } else {
        // The CLI writer emits one account valuation per frozen benchmark session.
        calendar = equity.map((point) => point.date);
        if (
          typeof initial === "number" &&
          Number.isFinite(initial) &&
          initial > 0 &&
          (!archived.success || archived.data.initial === initial)
        ) {
          scenario.performance ??= evaluatePerformance(initial, equity);
          scenario.topDrawdowns = topDrawdownEpisodes(initial, equity);
        } else notes.push("缺少可核实的期初本金，无法从权益计算回撤");
      }
    } else notes.push("权益日期顺序或金额无效");
  }
  const fillRows = await records(dir, "fills.csv", notes);
  if (fillRows && fillRows.length === scenario.counts.fills) {
    const fills: EvidenceFill[] = [];
    for (const row of fillRows) {
      const parsed = diagnoseFullFillSchema.safeParse({
        ...row,
        orderId: csvNumber(row.orderId),
        price: csvNumber(row.price),
        quantity: csvNumber(row.quantity),
        fee: csvNumber(row.fee),
        holdingAfter: csvNumber(row.holdingAfter),
        cashAfter: csvNumber(row.cashAfter),
        capacityClipped:
          row.capacityClipped === undefined
            ? undefined
            : row.capacityClipped === "true"
              ? true
              : row.capacityClipped === "false"
                ? false
                : row.capacityClipped,
      });
      if (
        !parsed.success ||
        !cell.symbols.includes(parsed.data.symbol) ||
        (fills.length > 0 && parsed.data.date < fills.at(-1)!.date)
      )
        break;
      fills.push(parsed.data);
    }
    if (fills.length === fillRows.length) {
      scenario.fullFills = fills;
      const closures = fills.filter((f) => f.holdingAfter === 0).length;
      if (closures !== scenario.counts.closedTrades) {
        scenario.evidenceNotes = [
          ...notes,
          "持仓归零次数与归档闭合交易计数不一致",
        ];
        return;
      }
      if (closures * calendar.length > 40_000_000) {
        scenario.evidenceNotes = [
          ...notes,
          "历史回合与交易日历超出读取计算预算，已保留完整成交",
        ];
        return;
      }
      const bars: Record<string, EvidenceBar[]> = Object.create(null);
      if (closures && calendar.length) {
        const raw = await records(dir, "bars.csv", notes);
        const adjusted =
          run?.corporateActionCoverage === "included" &&
          typeof run.signalBasis === "string" &&
          /GBBQ|forward|qfq/i.test(run.signalBasis);
        const symbols = new Set(fills.map((f) => f.symbol));
        for (const row of raw ?? []) {
          if (
            !row.symbol ||
            !symbols.has(row.symbol) ||
            !row.date ||
            row.date < calendar[0]! ||
            row.date > calendar.at(-1)!
          )
            continue;
          (bars[row.symbol] ??= []).push({
            date: row.date,
            high: csvNumber(row.high),
            low: csvNumber(row.low),
            close: csvNumber(row.close),
            signalClose: adjusted ? csvNumber(row.signalClose) : undefined,
          });
        }
      }
      try {
        scenario.tradeExcursions = cliTradeExcursions(fills, calendar, bars);
      } catch {
        notes.push("成交顺序无法还原完整持仓回合");
      }
    } else notes.push("完整成交记录字段、顺序或证券归属无效");
  } else if (fillRows) notes.push("成交文件笔数与冻结计数不一致");
  if (notes.length) scenario.evidenceNotes = notes;
}
