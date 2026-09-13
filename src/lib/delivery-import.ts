/** Normalizes a parsed 交割单 table into fills, cash flows and explicitly
 * unresolved rows. Pure: no IO, no hashing, no database. Column names differ per
 * terminal (同花顺 / 东方财富 / 通达信) and per counter (恒生 / 顶点 / 金证), so
 * mapping is alias-driven and every unmapped or unrecognized row is reported
 * rather than guessed. Ambiguity is surfaced, never silently resolved. */

import { z } from "zod";
import { cleanCell, type DeliveryTable } from "./delivery-table";

export const deliveryFields = [
  "tradeDate",
  "tradeTime",
  "code",
  "name",
  "summary",
  "side",
  "price",
  "quantity",
  "amount",
  "netAmount",
  "commission",
  "stampTax",
  "transferFee",
  "otherFee",
  "feeTotal",
  "balanceShares",
  "balanceCash",
  "orderId",
  "dealId",
  "businessFlag",
  "currency",
  "note",
  "account",
] as const;
export type DeliveryField = (typeof deliveryFields)[number];

/** Ordered: the first alias that matches a header wins, and longer aliases are
 * listed before the short ones they contain. */
const fieldAliases: Record<DeliveryField, string[]> = {
  tradeDate: [
    "成交日期",
    "交收日期",
    "清算日期",
    "发生日期",
    "交割日期",
    "业务日期",
    "交易日期",
    "委托日期",
    "日期",
  ],
  tradeTime: ["成交时间", "委托时间", "发生时间", "时间"],
  code: ["证券代码", "股票代码", "证券编码", "代码"],
  name: ["证券名称", "股票名称", "证券简称", "名称"],
  summary: [
    "转帐类别名称",
    "转账类别",
    "业务名称",
    "交易类别",
    "委托类别",
    "摘要",
    "业务类别",
    "操作",
  ],
  side: ["买卖标志", "买卖方向", "买卖类别", "方向", "买卖"],
  price: ["成交价格", "成交均价", "成交价", "委托价格", "价格"],
  quantity: ["成交数量", "成交股数", "发生数量", "成交量", "数量"],
  amount: ["成交金额", "成交额", "成交总额"],
  netAmount: [
    "变动资金",
    "发生金额",
    "资金发生数",
    "资金发生额",
    "清算金额",
    "净金额",
    "交收金额",
  ],
  commission: ["净佣金", "佣金", "手续费"],
  stampTax: ["印花税"],
  transferFee: ["过户费"],
  otherFee: [
    "其他杂费",
    "杂费",
    "其他费用",
    "其它费用",
    "其他费",
    "其它费",
    "规费",
    "经手费",
    "证管费",
    "结算费",
    "交易规费",
    "附加费",
  ],
  feeTotal: ["费用合计", "总费用", "费用总计"],
  balanceShares: [
    "可用余额",
    "后证余额",
    "股份余额",
    "证券余额",
    "股票余额",
    "剩余数量",
  ],
  balanceCash: ["资金余额", "后资金额", "本次余额", "资金本次余额"],
  orderId: ["合同编号", "合同号", "委托编号"],
  dealId: ["成交编号", "流水序号", "流水号", "成交序号"],
  businessFlag: ["业务标志", "业务代码", "业务标识"],
  currency: ["货币类别", "货币代码", "币种"],
  note: ["备注", "说明"],
  account: [
    "资金账号",
    "资金帐号",
    "股东代码",
    "股东账号",
    "股东帐号",
    "客户号",
  ],
};

const normalizeHeader = (header: string) =>
  cleanCell(header)
    .replace(/\s+/g, "")
    .replace(/[（(【［][^）)】］]*[）)】］]/g, "")
    .replace(/[:：]$/, "");

const feeFields = [
  "commission",
  "stampTax",
  "transferFee",
  "otherFee",
  "feeTotal",
] as const;
type FeeField = (typeof feeFields)[number];
const failedFlowTokens = ["作废", "失败", "余额不足"] as const;

export type ColumnMapping = {
  /** First matched column; feeColumns below explicitly lists all fee inputs. */
  columns: Partial<Record<DeliveryField, number>>;
  /** All miscellaneous fee columns contribute, including repeated aliases. */
  otherFeeColumns: number[];
  feeColumns: Record<FeeField, number[]>;
  /** Dedicated status headers, plus 摘要 (which can coexist with business type). */
  statusColumns: number[];
  /** Headers that matched a field already taken by an earlier column. */
  duplicates: { field: DeliveryField; header: string; index: number }[];
  /** Headers no alias matched. Kept for diagnostics, never guessed at. */
  unmapped: { header: string; index: number }[];
  /** `手续费` may mean net commission or total fees depending on the counter. */
  warnings: string[];
};

export function mapDeliveryColumns(header: string[]): ColumnMapping {
  const columns: ColumnMapping["columns"] = {};
  const duplicates: ColumnMapping["duplicates"] = [];
  const unmapped: ColumnMapping["unmapped"] = [];
  const warnings: string[] = [];
  const feeColumns: ColumnMapping["feeColumns"] = {
    commission: [],
    stampTax: [],
    transferFee: [],
    otherFee: [],
    feeTotal: [],
  };
  const otherFeeColumns = feeColumns.otherFee;
  const statusColumns: number[] = [];
  header.forEach((raw, index) => {
    const name = normalizeHeader(raw);
    if (!name) return;
    if (["状态", "交易状态", "转账状态", "处理状态", "摘要"].includes(name)) {
      statusColumns.push(index);
      if (name !== "摘要") return;
    }
    let matched: DeliveryField | null = null;
    for (const field of deliveryFields)
      if (fieldAliases[field].some((alias) => name === alias)) {
        matched = field;
        break;
      }
    if (!matched)
      for (const field of deliveryFields)
        if (fieldAliases[field].some((alias) => name.includes(alias))) {
          matched = field;
          break;
        }
    if (!matched) {
      unmapped.push({ header: raw, index });
      return;
    }
    if (matched === "commission" && name.includes("手续费"))
      warnings.push(
        `列「${raw}」按佣金处理；部分柜台的“手续费”是费用合计，请与费用合计列核对`,
      );
    if (feeFields.includes(matched as FeeField)) {
      feeColumns[matched as FeeField].push(index);
      columns[matched] ??= index;
      return;
    }
    if (columns[matched] !== undefined) {
      duplicates.push({ field: matched, header: raw, index });
      return;
    }
    columns[matched] = index;
  });
  return {
    columns,
    otherFeeColumns,
    feeColumns,
    statusColumns,
    duplicates,
    unmapped,
    warnings,
  };
}

export const requiredFields = ["tradeDate", "quantity", "price"] as const;

export const rowKinds = [
  "buy",
  "sell",
  "dividend",
  "transferIn",
  "transferOut",
  "interest",
  "fee",
  "subscription",
  "neutral",
] as const;
export type RowKind = (typeof rowKinds)[number];

/** Longest-match-first summary vocabulary. `担保品买入` must be tested before
 * `买入`, and `利息税` before `利息`. Unknown summaries are never coerced. */
const summaryVocabulary: [RowKind, string[]][] = [
  ["fee", ["股息红利扣税", "股息红利税差异化处理资金下账"]],
  ["subscription", ["新股中签资金扣款"]],
  [
    "buy",
    [
      "证券买入",
      "担保品买入",
      "融资买入",
      "质押买入",
      "基金申购",
      "买入",
      "证买",
      "申购成交",
    ],
  ],
  [
    "sell",
    [
      "证券卖出",
      "担保品卖出",
      "融券卖出",
      "基金赎回",
      "卖出",
      "证卖",
      "赎回成交",
    ],
  ],
  [
    "dividend",
    ["红利入账", "股息入账", "股息红利", "现金红利", "派息", "分红", "红利"],
  ],
  [
    "transferIn",
    ["银行转存", "银证转入", "银行转证券", "资金转入", "转账转入", "银衍转入"],
  ],
  [
    "transferOut",
    ["银行转取", "银证转出", "证券转银行", "资金转出", "转账转出", "银衍转出"],
  ],
  ["fee", ["利息税", "手续费扣收", "费用扣收", "扣款", "过户费扣收"]],
  ["interest", ["利息归本", "活期利息", "存款利息", "利息结转", "利息"]],
  [
    "subscription",
    [
      "新股申购",
      "新股缴款",
      "新股入账",
      "新股中签",
      "配号",
      "中签",
      "申购配号",
      "配售缴款",
    ],
  ],
  ["neutral", ["验资", "查询", "指定交易", "开户", "对账"]],
];

const sideTokens: [RowKind, string[]][] = [
  ["buy", ["买入", "买", "b", "1"]],
  ["sell", ["卖出", "卖", "s", "2"]],
];

export function classifyRow(
  summary: string,
  side: string,
  note = "",
): RowKind | null {
  for (const [index, value] of [note, summary].entries()) {
    const text = cleanCell(value).replace(/\s+/g, "");
    for (const [kind, words] of summaryVocabulary)
      // Free-text projected repo interest is not an interest posting.
      if (
        words.some((word) =>
          index === 0 && word === "利息" ? text === word : text.includes(word),
        )
      )
        return kind;
  }
  const direction = cleanCell(side).replace(/\s+/g, "").toLowerCase();
  // The numeric 1/2 convention is the counter's entrust_bs and is only trusted
  // when it comes from a dedicated direction column, never from a summary.
  if (direction)
    for (const [kind, tokens] of sideTokens)
      if (tokens.some((token) => direction === token)) return kind;
  return null;
}

const digits = (value: string) => value.replace(/\D/g, "");

/** Accepts 20210811, 2021-08-11, 2021/8/11, 2021.08.11 and 2021年8月11日. */
export function parseDeliveryDate(raw: string) {
  const value = cleanCell(raw);
  if (!value) return null;
  const parts = /^(\d{4})\D?(\d{1,2})\D?(\d{1,2})/.exec(value);
  if (!parts) return null;
  const [, year, month, day] = parts;
  const iso = `${year}-${month!.padStart(2, "0")}-${day!.padStart(2, "0")}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === iso
    ? iso
    : null;
}

/** Accepts 110351, 11:03:51, 1103 and 11:03. Three and four digits are HHMM —
 * padding them to six would read 1103 as 00:11:03 and reorder the day's fills. */
export function parseDeliveryTime(raw: string) {
  const value = digits(cleanCell(raw));
  if (value.length < 3 || value.length > 6) return null;
  const padded =
    value.length <= 4 ? `${value.padStart(4, "0")}00` : value.padStart(6, "0");
  const [hour, minute, second] = [
    padded.slice(0, 2),
    padded.slice(2, 4),
    padded.slice(4, 6),
  ];
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59)
    return null;
  return `${hour}:${minute}:${second}`;
}

/** Thousands separators, currency marks, parenthesised negatives and the
 * full-width minus all appear in real exports. */
export function parseDeliveryNumber(raw: string) {
  let value = cleanCell(raw)
    .replace(/[,，\s¥￥]/g, "")
    .replace(/[－−—]/g, "-");
  if (!value || value === "-" || value === "--") return null;
  let sign = 1;
  const wrapped = /^\((.*)\)$/.exec(value);
  if (wrapped) {
    sign = -1;
    value = wrapped[1]!;
  }
  if (!/^[-+]?\d*(\.\d+)?$/.test(value) || !/\d/.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed * sign : null;
}

export const instrumentKinds = [
  "stock",
  "convertible",
  "fund",
  "reverseRepo",
  "other",
] as const;
export type InstrumentKind = (typeof instrumentKinds)[number];

/** Market and instrument from the 6-digit code. Shanghai and Shenzhen share the
 * leading `1`/`2` digits, so the full prefix decides; anything unrecognized
 * returns null market and is excluded from per-security analysis upstream. */
export function classifyCode(raw: string) {
  const code = digits(cleanCell(raw));
  if (code.length !== 6)
    return { code, market: null, instrument: "other" as const };
  const three = code.slice(0, 3);
  const two = code.slice(0, 2);
  const table: [string[], "sh" | "sz" | "bj", InstrumentKind][] = [
    [["600", "601", "603", "605", "688", "689", "900"], "sh", "stock"],
    [["000", "001", "002", "003", "300", "301", "200"], "sz", "stock"],
    [["110", "111", "112", "113", "118", "119"], "sh", "convertible"],
    [["123", "127", "128", "120"], "sz", "convertible"],
    [
      [
        "510",
        "511",
        "512",
        "513",
        "515",
        "516",
        "517",
        "518",
        "560",
        "561",
        "562",
        "563",
        "588",
        "501",
        "502",
        "506",
        "508",
      ],
      "sh",
      "fund",
    ],
    [
      [
        "159",
        "150",
        "160",
        "161",
        "162",
        "163",
        "164",
        "165",
        "166",
        "167",
        "168",
        "169",
        "184",
      ],
      "sz",
      "fund",
    ],
    [["204"], "sh", "reverseRepo"],
    [["131"], "sz", "reverseRepo"],
  ];
  for (const [prefixes, market, instrument] of table)
    if (prefixes.includes(three)) return { code, market, instrument };
  if (["43", "83", "87", "88", "92"].includes(two))
    return { code, market: "bj" as const, instrument: "stock" as const };
  return { code, market: null, instrument: "other" as const };
}

export type ParsedFill = {
  kind: "buy" | "sell";
  rowIndex: number;
  tradeDate: string;
  tradeTime: string | null;
  code: string;
  symbol: string | null;
  instrument: InstrumentKind;
  name: string | null;
  price: number;
  quantity: number;
  amount: number;
  fees: {
    commission: number | null;
    stampTax: number | null;
    transferFee: number | null;
    otherFee: number | null;
    total: number | null;
  };
  netAmount: number | null;
  balanceShares: number | null;
  balanceCash: number | null;
  orderId: string | null;
  dealId: string | null;
  businessFlag: string | null;
  summary: string;
  /** Deterministic string the storage layer hashes into the idempotency key. */
  fingerprintSource: string;
  anomalies: string[];
};

export type ParsedCashFlow = {
  /** Raw quantity evidence; older imports may omit it. Not a confirmed share delta. */
  quantity?: number | null;
  kind: Exclude<RowKind, "buy" | "sell">;
  rowIndex: number;
  flowDate: string;
  /** Legacy stored flows may omit time; newly parsed flows always contain it. */
  flowTime?: string | null;
  /** Older stored flows may omit counter identifiers. */
  orderId?: string | null;
  dealId?: string | null;
  code: string | null;
  name: string | null;
  amount: number;
  balanceCash: number | null;
  summary: string;
  fingerprintSource: string;
};

export type UnresolvedRow = {
  rowIndex: number;
  reason: string;
  cells: string[];
};

export type DeliveryImport = {
  statementOpeningCash?: number | null;
  counts?: {
    discardedFills: number;
    excludedInterest: number;
    rejectedSigns: number;
    failedFlows: number;
    unresolved: number;
  };
  mapping: ColumnMapping;
  fills: ParsedFill[];
  cashFlows: ParsedCashFlow[];
  unresolved: UnresolvedRow[];
  diagnostics: string[];
};

const money = 0.01;
const close = (a: number, b: number) =>
  Math.abs(a - b) <= Math.max(money, Math.abs(b) * 1e-4);

/** Account columns are read only to redact them: identifiers never reach the
 * database, and the retained raw row has them replaced. Exports carry more than
 * one account column (资金账号 plus 股东代码); every recognized one is redacted,
 * including the duplicates that lost the mapping to an earlier column. */
export function redactRow(cells: string[], mapping: ColumnMapping) {
  const indexes = new Set<number>();
  if (mapping.columns.account !== undefined)
    indexes.add(mapping.columns.account);
  for (const column of mapping.duplicates)
    if (column.field === "account") indexes.add(column.index);
  return cells.map((cell, position) =>
    indexes.has(position)
      ? "***"
      : cell.replace(
          /(股东账号|股东帐号|资金账号|资金帐号|股东代码|账号|帐号)[：:]\s*[0-9A-Za-z]+/g,
          "$1：***",
        ),
  );
}

/** Fingerprints must survive re-export: the same fill appears at a different row
 * when the user exports a different date range, so the row number cannot take
 * part. Rows that share every economic field are indistinguishable by
 * construction, so their position within that group is a stable discriminator.
 */
function occurrenceCounter() {
  const counts = new Map<string, number>();
  return (key: readonly unknown[]) => {
    const id = JSON.stringify(key);
    const next = (counts.get(id) ?? 0) + 1;
    counts.set(id, next);
    return next;
  };
}

export function importDeliveryTable(
  table: DeliveryTable,
  options: Pick<ImportOptions, "scope"> = {},
): DeliveryImport {
  const mapping = mapDeliveryColumns(table.header);
  const { columns } = mapping;
  const summaryColumn = table.header.findIndex(
    (h) => normalizeHeader(h) === "摘要",
  );
  const operationColumn = table.header.findIndex(
    (h) => normalizeHeader(h) === "操作",
  );
  const statement =
    summaryColumn >= 0 &&
    table.header.some((h) => normalizeHeader(h) === "资金余额") &&
    operationColumn >= 0 &&
    table.rows.some((row) => cleanCell(row[operationColumn] ?? "") === "其他");
  if (statement) {
    columns.summary = summaryColumn;
    columns.side = operationColumn;
  }
  const counts = {
    discardedFills: 0,
    excludedInterest: 0,
    rejectedSigns: 0,
    failedFlows: 0,
    unresolved: 0,
  };
  const diagnostics = [...mapping.warnings];
  const cashOnly =
    columns.price === undefined &&
    columns.quantity === undefined &&
    (columns.netAmount !== undefined || columns.amount !== undefined) &&
    columns.summary !== undefined;
  const missing = (cashOnly ? (["tradeDate"] as const) : requiredFields).filter(
    (field) => columns[field] === undefined,
  );
  if (missing.length)
    throw new Error(
      `交割单缺少必要列：${missing
        .map((field) => fieldAliases[field][0])
        .join("、")}；已识别列：${table.header.filter((h) => h).join("、")}`,
    );
  if (columns.summary === undefined && columns.side === undefined)
    throw new Error(
      `交割单缺少摘要/业务名称与买卖方向列，无法判定买卖；已识别列：${Object.values(
        columns,
      )
        .map((index) => table.header[index!])
        .join("、")}`,
    );
  diagnostics.push(
    statement
      ? "按对账单形态解析（摘要、资金余额及其他操作）"
      : cashOnly
        ? "按纯资金流水形态解析（无价格/数量列，有金额及业务类别列）"
        : "按成交明细形态解析（有价格及数量列）",
  );
  if (columns.account !== undefined)
    diagnostics.push("已识别账号列，入库前按列脱敏，不保存真实账号");

  const fills: ParsedFill[] = [];
  const cashFlows: ParsedCashFlow[] = [];
  const unresolved: UnresolvedRow[] = [];
  const fillOccurrence = occurrenceCounter();
  const cashOccurrence = occurrenceCounter();
  const at = (cells: string[], field: DeliveryField) => {
    const index = columns[field];
    return index === undefined ? "" : (cells[index] ?? "");
  };
  const num = (cells: string[], field: DeliveryField) =>
    columns[field] === undefined ? null : parseDeliveryNumber(at(cells, field));
  const text = (cells: string[], field: DeliveryField) => {
    const value = cleanCell(at(cells, field));
    if ((field === "dealId" || field === "orderId") && /^[0.]+$/.test(value))
      return null;
    return value || null;
  };

  // Preserve source order at equal timestamps, reversing ties with descending
  // exports. Never use summary wording to choose the posted interest leg.
  const chronological = (statement ? table.rows : []).map((cells, index) => ({
    cells,
    index,
    date: parseDeliveryDate(at(cells, "tradeDate")),
    time: parseDeliveryTime(at(cells, "tradeTime")) ?? "00:00:00",
  }));
  const dated = chronological.filter((row) => row.date !== null);
  const descending =
    dated.length > 1 &&
    `${dated[0]!.date} ${dated[0]!.time}` >
      `${dated.at(-1)!.date} ${dated.at(-1)!.time}`;
  chronological.sort(
    (a, b) =>
      `${a.date ?? ""} ${a.time}`.localeCompare(`${b.date ?? ""} ${b.time}`) ||
      (descending ? b.index - a.index : a.index - b.index),
  );
  const previousBalances = new Map<number, number | null>();
  chronological.forEach((row, i) =>
    previousBalances.set(
      row.index,
      i > 0 ? num(chronological[i - 1]!.cells, "balanceCash") : null,
    ),
  );
  const first = chronological[0];
  const openingBalance = first ? num(first.cells, "balanceCash") : null;
  const openingAmount = first ? num(first.cells, "netAmount") : null;
  const statementOpeningCash =
    first?.date && openingBalance !== null && openingAmount !== null
      ? Math.round((openingBalance - openingAmount) * 100) / 100
      : null;

  table.rows.forEach((cells, index) => {
    const rowIndex = index + 1;
    const summary = cleanCell(at(cells, "summary"));
    let kind = classifyRow(summary, at(cells, "side"), at(cells, "note"));
    if (statement) {
      const operation = cleanCell(at(cells, "side"));
      if (summary.includes("银行返回码")) {
        const amount = num(cells, "netAmount");
        kind =
          /银行返回码\s*[:：]?\s*000000000000(?!\d)/.test(summary) &&
          summary.includes("交易成功") &&
          amount !== null &&
          amount !== 0
            ? amount > 0
              ? "transferIn"
              : "transferOut"
            : null;
      } else if (summary.includes("融券回购购回日")) {
        kind =
          operation === "卖出" ? "sell" : operation === "买入" ? "buy" : null;
      } else if (summary.includes("结息") || summary.includes("利息结转")) {
        kind = "interest";
      } else {
        // Only explicit cash vocabulary may override the operation column.
        const cashKind = classifyRow(summary, "");
        kind =
          cashKind && cashKind !== "buy" && cashKind !== "sell"
            ? cashKind
            : operation === "买入"
              ? "buy"
              : operation === "卖出"
                ? "sell"
                : null;
      }
    }
    const date = parseDeliveryDate(at(cells, "tradeDate"));
    if (
      (cashOnly || (kind !== "buy" && kind !== "sell")) &&
      mapping.statusColumns.length
    ) {
      const status = mapping.statusColumns
        .map((i) => cleanCell(cells[i] ?? ""))
        .join("；");
      if (failedFlowTokens.some((token) => status.includes(token))) {
        counts.failedFlows++;
        unresolved.push({
          rowIndex,
          reason: `资金流水状态「${status}」为失败/作废，不计入现金流`,
          cells,
        });
        return;
      }
    }
    if (!date) {
      unresolved.push({ rowIndex, reason: "日期无法解析", cells });
      return;
    }
    // R8: explicit zero amounts contradict a positive-price, positive-quantity
    // market fill. Keep recognized cash events; never guess an unknown business.
    if (
      (kind === null || kind === "buy" || kind === "sell") &&
      (num(cells, "price") ?? 0) > 0 &&
      (num(cells, "quantity") ?? 0) > 0 &&
      num(cells, "amount") === 0 &&
      num(cells, "netAmount") === 0
    ) {
      unresolved.push({
        rowIndex,
        reason:
          "价量为正但成交金额与发生金额均为 0，不是市场成交；业务类型无法确定",
        cells,
      });
      return;
    }
    if (!kind) {
      // A zero-amount unknown row cannot move the cash curve; say so instead of
      // leaving the user to guess whether the gap matters.
      const moved = num(cells, "netAmount") ?? num(cells, "amount");
      unresolved.push({
        rowIndex,
        reason: `未知业务类型「${summary || at(cells, "side") || "空"}」${
          moved === 0 ? "（金额为 0，不影响资金重建）" : ""
        }`,
        cells,
      });
      return;
    }
    if (cashOnly && (kind === "buy" || kind === "sell")) {
      unresolved.push({
        rowIndex,
        reason: "纯资金流水中的买卖业务无法确认为资金类型",
        cells,
      });
      return;
    }
    if (kind !== "buy" && kind !== "sell") {
      // Cash side. The signed 发生金额 is authoritative; direction words only
      // decide the sign when the column carries an unsigned value.
      const raw = num(cells, "netAmount") ?? num(cells, "amount");
      if (raw === null) {
        unresolved.push({ rowIndex, reason: "资金流水缺少发生金额", cells });
        return;
      }
      if (statement && kind === "interest") {
        const previous = previousBalances.get(index) ?? null;
        const balance = num(cells, "balanceCash");
        if (previous === null || balance === null) {
          unresolved.push({
            rowIndex,
            reason: "利息缺少前一条资金余额或本条余额，无法确证入账",
            cells,
          });
          return;
        }
        // Compare at the statement's cent precision, not relative price tolerance.
        if (
          Math.round(balance * 100) !==
          Math.round(previous * 100) + Math.round(raw * 100)
        ) {
          counts.excludedInterest++;
          return;
        }
      }
      // Types with an unambiguous direction are forced to the correct sign;
      // 新股申购/配号 keep whatever sign the counter wrote, since the same
      // summary covers both the debit and the later refund.
      const negative = kind === "transferOut" || kind === "fee";
      const positive =
        kind === "transferIn" || kind === "dividend" || kind === "interest";
      const amount =
        statement && kind === "interest"
          ? raw
          : negative
            ? -Math.abs(raw)
            : positive
              ? Math.abs(raw)
              : raw;
      const cashKey = [date, kind, amount, text(cells, "code")] as const;
      cashFlows.push({
        quantity: num(cells, "quantity"),
        kind,
        rowIndex,
        flowDate: date,
        flowTime: parseDeliveryTime(at(cells, "tradeTime")),
        orderId: text(cells, "orderId"),
        dealId: text(cells, "dealId"),
        code: text(cells, "code"),
        name: text(cells, "name"),
        amount,
        balanceCash: num(cells, "balanceCash"),
        summary: summary || kind,
        fingerprintSource: JSON.stringify([
          "cash",
          ...cashKey,
          cashOccurrence(cashKey),
        ]),
      });
      return;
    }

    const quantity = num(cells, "quantity");
    if (
      statement &&
      (quantity === null ||
        quantity === 0 ||
        Math.sign(quantity) !== (kind === "buy" ? 1 : -1))
    ) {
      counts.rejectedSigns++;
      unresolved.push({
        rowIndex,
        reason: "对账单数量缺失、为零或符号与操作不一致（买入须正、卖出须负）",
        cells,
      });
      return;
    }
    if (options.scope === "cashFlowsOnly") {
      counts.discardedFills++;
      return;
    }
    const price = num(cells, "price");
    if (price === null || quantity === null || price <= 0 || quantity === 0) {
      unresolved.push({
        rowIndex,
        reason: "成交价格或数量缺失/非法",
        cells,
      });
      return;
    }
    const { code, market, instrument } = classifyCode(at(cells, "code"));
    if (code.length !== 6) {
      unresolved.push({ rowIndex, reason: "证券代码非六位", cells });
      return;
    }
    const shares = Math.abs(quantity);
    const declared = num(cells, "amount");
    const gross = declared !== null ? Math.abs(declared) : price * shares;
    const anomalies: string[] = [];
    // Convertible bonds quote per 100 yuan of face value, but the quantity unit
    // differs by exchange: Shanghai reports 手 (1 手 = 10 张), Shenzhen reports
    // 张. Accept either multiplier rather than flagging every Shanghai bond,
    // and still report a mismatch when neither fits.
    const multipliers = instrument === "convertible" ? [1, 10] : [1];
    if (
      instrument !== "reverseRepo" &&
      declared !== null &&
      !multipliers.some((factor) =>
        close(Math.abs(declared), price * shares * factor),
      )
    )
      anomalies.push(
        `成交金额 ${declared} 与 价格×数量${
          instrument === "convertible" ? "（按张或按手）" : ""
        } ${(price * shares).toFixed(2)} 不符`,
      );
    if (market === null)
      anomalies.push(`代码 ${code} 不属于已知沪深北品种，不参与个股分析`);
    const sumFee = (field: FeeField) => {
      const values = mapping.feeColumns[field].map((i) =>
        parseDeliveryNumber(cells[i] ?? ""),
      );
      return values.length && values.every((value) => value !== null)
        ? values.reduce<number>((sum, value) => sum + Math.abs(value!), 0)
        : null;
    };
    const totals = mapping.feeColumns.feeTotal
      .map((i) => cleanCell(cells[i] ?? ""))
      .filter((value) => value !== "")
      .map(parseDeliveryNumber);
    if (
      totals.length > 1 &&
      totals.some((value) => value === null || value !== totals[0])
    )
      anomalies.push(
        `重复费用合计列值不一致：${totals.join("、")}；取第一个非空列`,
      );
    const fees = {
      commission: sumFee("commission"),
      stampTax: sumFee("stampTax"),
      transferFee: sumFee("transferFee"),
      otherFee: sumFee("otherFee"),
      total: totals[0] ?? null,
    };
    const parts = [
      fees.commission,
      fees.stampTax,
      fees.transferFee,
      fees.otherFee,
    ].filter((value): value is number => value !== null);
    const summed = parts.length
      ? parts.reduce((sum, value) => sum + Math.abs(value), 0)
      : null;
    if (
      fees.total !== null &&
      summed !== null &&
      !close(Math.abs(fees.total), summed)
    )
      anomalies.push(
        `费用合计 ${fees.total} 与分项之和 ${summed.toFixed(2)} 不符`,
      );
    const total = fees.total !== null ? Math.abs(fees.total) : summed;
    const netAmount = num(cells, "netAmount");
    // Repo prices are annualized rates; proceeds include principal and interest.
    // Stock settlement equations cannot validate either repo leg.
    if (instrument !== "reverseRepo" && netAmount !== null && total !== null) {
      const expected = kind === "buy" ? -(gross + total) : gross - total;
      if (!close(netAmount, expected))
        anomalies.push(
          `发生金额 ${netAmount} 与 ${kind === "buy" ? "成交金额+费用" : "成交金额-费用"} ${expected.toFixed(2)} 不符`,
        );
    }
    if (instrument !== "reverseRepo" && netAmount !== null && netAmount !== 0) {
      const expectedSign = kind === "buy" ? -1 : 1;
      if (Math.sign(netAmount) !== expectedSign)
        anomalies.push(
          `发生金额符号与${kind === "buy" ? "买入" : "卖出"}方向矛盾`,
        );
    }
    // Cash direction is part of the economic identity. A repo lend and its
    // redemption are both recorded as 卖出 with identical date, code, price and
    // quantity, so without the sign they collapse into one group and their
    // order — which differs between a settlement export and a trade export —
    // decides which is which. The sign keeps them apart across files.
    const fillKey = [
      date,
      code,
      kind,
      price,
      shares,
      Math.sign(netAmount ?? 0),
    ] as const;
    fills.push({
      kind,
      rowIndex,
      tradeDate: date,
      tradeTime: parseDeliveryTime(at(cells, "tradeTime")),
      code,
      symbol: market ? `${market}${code}` : null,
      instrument,
      name: text(cells, "name"),
      price,
      quantity: shares,
      amount: gross,
      fees: { ...fees, total },
      netAmount,
      balanceShares: num(cells, "balanceShares"),
      balanceCash: num(cells, "balanceCash"),
      orderId: text(cells, "orderId"),
      dealId: text(cells, "dealId"),
      businessFlag: text(cells, "businessFlag"),
      summary: summary || kind,
      anomalies,
      // Counter identifiers differ across export formats; retain them only as
      // evidence. Occurrence preserves multiple economically identical fills.
      fingerprintSource: JSON.stringify([
        "fill",
        ...fillKey,
        fillOccurrence(fillKey),
      ]),
    });
  });

  if (!mapping.statusColumns.length && (cashOnly || cashFlows.length))
    diagnostics.push("未找到状态列，无法排除失败流水");

  const reverseRepos = fills.filter(
    (fill) => fill.instrument === "reverseRepo",
  ).length;
  if (reverseRepos)
    diagnostics.push(
      `${reverseRepos} 笔逆回购豁免价格×数量、股票发生金额及符号核对；费用合计与分项核对保留`,
    );
  if (table.dropped.length)
    diagnostics.push(
      `表格层跳过 ${table.dropped.length} 行（重复表头或汇总行）`,
    );
  const excluded = fills.filter((fill) => fill.symbol === null).length;
  if (excluded)
    diagnostics.push(
      `${excluded} 笔成交为非沪深北股票品种，计入资金但不参与个股分析`,
    );
  if (statement || options.scope === "cashFlowsOnly") {
    counts.unresolved = unresolved.length;
    diagnostics.push(
      `范围排除成交 ${counts.discardedFills} 条；余额恒等式排除利息 ${counts.excludedInterest} 条；数量符号拒绝 ${counts.rejectedSigns} 条；失败流水 ${counts.failedFlows} 条；未解析 ${counts.unresolved} 条`,
    );
  }
  return {
    mapping,
    fills,
    cashFlows,
    unresolved,
    diagnostics,
    ...(statement ? { statementOpeningCash } : {}),
    ...(statement || options.scope === "cashFlowsOnly" ? { counts } : {}),
  };
}

export const importOptionsSchema = z.object({
  account: z.string().trim().min(1).max(64),
  source: z.enum(["ths", "eastmoney", "tdx", "generic"]),
  scope: z.enum(["all", "cashFlowsOnly"]).optional(),
});
export type ImportOptions = z.infer<typeof importOptionsSchema>;
