/** Broker delivery-order files are exported by terminals (同花顺 / 东方财富 /
 * 通达信 and the 恒生·顶点·金证 counters behind them) in three shapes: delimited
 * text, UTF-16 tab-separated text named `.xls`, and HTML `<table>` also named
 * `.xls`. All three are decoded here into a header row plus body rows; nothing
 * in this module knows what a trade is. */

export const tableFormats = ["csv", "tsv", "html"] as const;
export type TableFormat = (typeof tableFormats)[number];

export type DeliveryTable = {
  format: TableFormat;
  encoding: string;
  /** Lines above the header row: broker name, account, date range, etc. */
  preamble: string[];
  header: string[];
  /** Body rows padded/truncated to the header width, cells trimmed. */
  rows: string[][];
  /** Rows dropped before the header row was located, with their reason. */
  dropped: { line: number; reason: string; cells: string[] }[];
};

const utf8 = (bytes: Uint8Array, offset = 0) =>
  new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset));

/** BOM wins. Otherwise strict UTF-8 first: a GB18030 decoder accepts almost any
 * byte sequence, so trying it first would silently mojibake valid UTF-8. */
export function decodeDeliveryBytes(bytes: Uint8Array) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return { text: utf8(bytes, 3), encoding: "utf-8-bom" };
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return {
      text: new TextDecoder("utf-16le", { fatal: true }).decode(
        bytes.subarray(2),
      ),
      encoding: "utf-16le",
    };
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return {
      text: new TextDecoder("utf-16be", { fatal: true }).decode(
        bytes.subarray(2),
      ),
      encoding: "utf-16be",
    };
  try {
    return { text: utf8(bytes), encoding: "utf-8" };
  } catch {
    /* Not UTF-8; fall through to the mainland terminal default. */
  }
  try {
    return {
      text: new TextDecoder("gb18030", { fatal: true }).decode(bytes),
      encoding: "gb18030",
    };
  } catch {
    throw new Error("文件编码无法识别（已尝试 UTF-8/UTF-16/GB18030）");
  }
}

const entities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};
const decodeEntities = (s: string) =>
  s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith("#")) {
      const code =
        body.startsWith("#x") || body.startsWith("#X")
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0
        ? String.fromCodePoint(code)
        : match;
    }
    return entities[body.toLowerCase()] ?? match;
  });

/** Terminals write leading apostrophes, `="000001"` guards and full-width
 * spaces to stop Excel from eating leading zeros. Strip them, keep the value. */
export function cleanCell(raw: string) {
  let cell = raw.replace(/ |　/g, " ").trim();
  const excel = /^=?"(.*)"$/s.exec(cell);
  if (excel) cell = excel[1]!.trim();
  if (cell.startsWith("'")) cell = cell.slice(1).trim();
  return cell;
}

function parseHtmlRows(text: string) {
  const rows: string[][] = [];
  for (const [, body] of text.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells: string[] = [];
    for (const [, cell] of body!.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi))
      cells.push(
        cleanCell(
          decodeEntities(cell!.replace(/<[^>]*>/g, "").replace(/\s+/g, " ")),
        ),
      );
    if (cells.length) rows.push(cells);
  }
  return rows;
}

/** RFC4180 quoting, tolerant of the stray unterminated quote these exports
 * occasionally contain (the field then runs to end of line). */
function parseDelimited(text: string, delimiter: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char !== '"') cell += char;
      else if (text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = false;
      continue;
    }
    if (char === '"' && !cell.trim()) {
      quoted = true;
      cell = "";
      continue;
    }
    if (char === delimiter) {
      row.push(cleanCell(cell));
      cell = "";
      continue;
    }
    if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(cleanCell(cell));
      cell = "";
      if (row.some((value) => value)) rows.push(row);
      row = [];
      continue;
    }
    cell += char;
  }
  row.push(cleanCell(cell));
  if (row.some((value) => value)) rows.push(row);
  return rows;
}

const delimiters = ["\t", ",", ";", "|"] as const;

/** Pick the delimiter that yields the most consistent column count across the
 * first lines, not merely the most occurrences: Chinese security names contain
 * no delimiters but summary fields sometimes contain commas. */
function detectDelimiter(text: string) {
  const sample = text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(0, 20);
  let best: { delimiter: string; score: number } = {
    delimiter: ",",
    score: -1,
  };
  for (const delimiter of delimiters) {
    const counts = sample.map((line) => line.split(delimiter).length);
    const width = Math.max(...counts, 0);
    if (width < 2) continue;
    const agreeing = counts.filter((count) => count === width).length;
    const score = width * agreeing;
    if (score > best.score) best = { delimiter, score };
  }
  return best.delimiter;
}

const headerHints = [
  "日期",
  "时间",
  "代码",
  "名称",
  "数量",
  "价格",
  "金额",
  "资金",
  "余额",
  "摘要",
  "操作",
  "方向",
  "类别",
  "标志",
  "佣金",
  "费",
  "税",
  "编号",
  "合同",
  "业务",
  "备注",
  "股东",
];

/** The header row is the first row where several cells look like column names
 * and no cell looks like a data value. Broker exports put a title line, the
 * account number and the queried date range above it. */
function locateHeader(rows: string[][]) {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const cells = rows[i]!.filter((cell) => cell);
    if (cells.length < 3) continue;
    const hits = cells.filter((cell) =>
      headerHints.some((hint) => cell.includes(hint)),
    ).length;
    // A header cell is a short label; a data row has numbers and long values.
    const numeric = cells.filter((cell) =>
      /^[-+]?\d[\d,]*(\.\d+)?$/.test(cell),
    ).length;
    if (hits >= 3 && hits > numeric) return i;
  }
  return -1;
}

export function parseDeliveryTable(input: Uint8Array | string): DeliveryTable {
  const decoded =
    typeof input === "string"
      ? { text: input, encoding: "utf-8" }
      : decodeDeliveryBytes(input);
  const html = /<table[\s>]/i.test(decoded.text);
  const delimiter = html ? "" : detectDelimiter(decoded.text);
  const format: TableFormat = html
    ? "html"
    : delimiter === "\t"
      ? "tsv"
      : "csv";
  const all = html
    ? parseHtmlRows(decoded.text)
    : parseDelimited(decoded.text, delimiter);
  const headerIndex = locateHeader(all);
  if (headerIndex < 0)
    throw new Error(
      "未找到交割单表头行（需要包含日期、代码、数量等列名的一行）",
    );
  const header = all[headerIndex]!.map((cell) => cell.replace(/\s+/g, ""));
  const width = header.length;
  const rows: string[][] = [];
  const dropped: DeliveryTable["dropped"] = [];
  for (let i = headerIndex + 1; i < all.length; i++) {
    const cells = all[i]!;
    if (!cells.some((cell) => cell)) continue;
    // Repeated headers appear when a terminal exports several date ranges into
    // one file; trailing totals/notes rows have far fewer populated cells.
    if (
      cells.every(
        (cell, index) => !cell || cell.replace(/\s+/g, "") === header[index],
      )
    ) {
      dropped.push({ line: i + 1, reason: "重复表头", cells });
      continue;
    }
    const populated = cells.filter((cell) => cell).length;
    if (populated < Math.min(3, width)) {
      dropped.push({ line: i + 1, reason: "有效单元格过少", cells });
      continue;
    }
    rows.push(Array.from({ length: width }, (_, index) => cells[index] ?? ""));
  }
  return {
    format,
    encoding: decoded.encoding,
    preamble: all.slice(0, headerIndex).map((cells) => cells.join(" ").trim()),
    header,
    rows,
    dropped,
  };
}
