import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  tradeWorkspaceFilters,
  tradeWorkspacePageSchema,
  tradeWorkspaceId,
  tradeSignalOptionsSchema,
  tradeAdjustmentPageSchema,
  type TradeWorkspaceInput,
  type TradeWorkspaceRow,
} from "~/lib/portfolio/trade-workspace";
import type { Trade, CostAdjustment } from "~/lib/portfolio/trade-ledger";

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function tradeAdjustmentPage(db: Database.Database, raw: unknown) {
  const input = tradeAdjustmentPageSchema.parse(raw),
    filter = hash({ symbol: input.symbol ?? null });
  let row: number | null = null;
  if (input.cursor) {
    let cursor;
    try {
      cursor = z
        .object({ row: z.number().int().positive(), filter: z.string() })
        .parse(
          JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")),
        );
    } catch {
      throw new Error("除权依据分页位置无效");
    }
    if (cursor.filter !== filter)
      throw new Error("除权依据筛选已变化，请重新检索");
    row = cursor.row;
  }
  return db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT rowid row,id,symbol,json_extract(payload,'$.event.date') date,
      json_extract(payload,'$.event.name') name,json_extract(payload,'$.beforeQuantity') beforeQuantity,
      json_extract(payload,'$.afterQuantity') afterQuantity,json_extract(payload,'$.beforeCost') beforeCost,
      json_extract(payload,'$.afterCost') afterCost FROM trade_adjustments
      WHERE (@symbol IS NULL OR symbol=@symbol) AND (@row IS NULL OR rowid<@row) ORDER BY rowid DESC LIMIT 21`,
      )
      .all({ symbol: input.symbol ?? null, row }) as {
      row: number;
      id: string;
      symbol: string;
      date: string;
      name: string;
      beforeQuantity: number;
      afterQuantity: number;
      beforeCost: number;
      afterCost: number | null;
    }[];
    const total = db
      .prepare(
        "SELECT count(*) count FROM trade_adjustments WHERE (@symbol IS NULL OR symbol=@symbol)",
      )
      .get({ symbol: input.symbol ?? null }) as { count: number };
    const items = rows.slice(0, 20),
      last = items.at(-1);
    return {
      items,
      count: total.count,
      nextCursor:
        rows.length > 20 && last
          ? Buffer.from(JSON.stringify({ row: last.row, filter })).toString(
              "base64url",
            )
          : null,
    };
  })();
}
export function tradeAdjustmentDetail(db: Database.Database, raw: unknown) {
  const id = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(raw);
  const row = db
    .prepare("SELECT payload FROM trade_adjustments WHERE id=?")
    .get(id) as { payload: string } | undefined;
  return row ? (JSON.parse(row.payload) as CostAdjustment) : null;
}
// Trades are immutable and append-only. Version reads table identity, never methods/body.
export function tradeWorkspaceVersion(db: Database.Database) {
  return hash(
    db
      .prepare(
        "SELECT count(*) count, max(rowid) lastRow, max(id) lastId FROM trade_ledger",
      )
      .get(),
  );
}
const cursorSchema = z.object({
  date: z.string(),
  time: z.number().finite(),
  id: z.string().uuid(),
  filter: z.string(),
  version: z.string(),
});
function scope(db: Database.Database, raw: unknown) {
  const input = tradeWorkspacePageSchema.parse(raw),
    version = tradeWorkspaceVersion(db);
  if (input.version && input.version !== version)
    throw new Error("账本已更新，请刷新后重新检索");
  const filter = hash(tradeWorkspaceFilters.parse(input));
  let cursor: z.infer<typeof cursorSchema> | undefined;
  if (input.cursor) {
    try {
      cursor = cursorSchema.parse(
        JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")),
      );
    } catch {
      throw new Error("交易分页位置无效，请重新检索");
    }
    if (cursor.filter !== filter) throw new Error("筛选条件已变化，请重新检索");
    if (cursor.version !== version)
      throw new Error("账本已更新，请刷新后重新检索");
  }
  return { input, version, filter, cursor };
}
const field = (name: string) => `json_extract(payload,'$.${name}')`;
const metadata = `SELECT id,symbol,trade_date date,${field("createdAt")} createdAt,
 ${field("side")} side,${field("price")} price,${field("quantity")} quantity,
 ${field("fees.total")} fees,${field("signalId")} signalId,${field("note")} note FROM trade_ledger`;
const where = `(@symbol IS NULL OR symbol=@symbol) AND (@from IS NULL OR date>=@from)
 AND (@to IS NULL OR date<=@to) AND (@side IS NULL OR side=@side)
 AND (@linked IS NULL OR (signalId IS NOT NULL AND signalId<>'')=@linked)
 AND (instr(lower(COALESCE(note,'')),lower(@query))>0 OR instr(lower(symbol),lower(@query))>0 OR instr(lower(id),lower(@query))>0)`;
function params(input: TradeWorkspaceInput) {
  return {
    symbol: input.symbol ?? null,
    from: input.from ?? null,
    to: input.to ?? null,
    side: input.side ?? null,
    linked: input.linked === undefined ? null : Number(input.linked),
    query: input.query,
  };
}
export function tradeWorkspacePage(db: Database.Database, raw: unknown) {
  return db.transaction(() => {
    const { input, version, filter, cursor } = scope(db, raw);
    const rows = db
      .prepare(
        `WITH rows AS (${metadata}) SELECT id,symbol,date,createdAt,side,price,quantity,fees,signalId,substr(note,1,120) note FROM rows WHERE ${where}
      AND (@date IS NULL OR date<@date OR (date=@date AND (createdAt<@time OR (createdAt=@time AND id<@id))))
      ORDER BY date DESC,createdAt DESC,id DESC LIMIT 21`,
      )
      .all({
        ...params(input),
        date: cursor?.date ?? null,
        time: cursor?.time ?? null,
        id: cursor?.id ?? null,
      }) as TradeWorkspaceRow[];
    const summary = db
      .prepare(
        `WITH rows AS (${metadata}) SELECT count(*) count,
      COALESCE(sum(CASE WHEN side='buy' THEN 1 ELSE 0 END),0) buys,
      COALESCE(sum(CASE WHEN side='sell' THEN 1 ELSE 0 END),0) sells,
      COALESCE(sum(fees),0) fees FROM rows WHERE ${where}`,
      )
      .get(params(input)) as {
      count: number;
      buys: number;
      sells: number;
      fees: number;
    };
    const items = rows.slice(0, 20),
      last = items.at(-1);
    return {
      items,
      summary,
      version,
      nextCursor:
        rows.length > 20 && last
          ? Buffer.from(
              JSON.stringify({
                date: last.date,
                time: last.createdAt,
                id: last.id,
                filter,
                version,
              }),
            ).toString("base64url")
          : null,
    };
  })();
}
export function tradeWorkspaceDetail(db: Database.Database, raw: unknown) {
  const id = tradeWorkspaceId.parse(raw);
  const row = db
    .prepare("SELECT payload FROM trade_ledger WHERE id=?")
    .get(id) as { payload: string } | undefined;
  if (!row) return null;
  const trade = JSON.parse(row.payload) as Trade;
  const linkedSignal = trade.signalId
    ? ((db
        .prepare(
          "SELECT id,symbol,observed_date date FROM signal_ledger WHERE id=?",
        )
        .get(trade.signalId) as
        { id: string; symbol: string; date: string } | undefined) ?? null)
    : null;
  const { count } = db
    .prepare("SELECT count(*) count FROM trade_adjustments WHERE symbol=?")
    .get(trade.symbol) as { count: number };
  return { trade, linkedSignal, adjustmentCount: count };
}

export function tradeSignalOptions(db: Database.Database, raw: unknown) {
  const input = tradeSignalOptionsSchema.parse(raw);
  const filter = hash({
    symbol: input.symbol,
    date: input.date,
    query: input.query,
  });
  let cursor: { date: string; id: string; filter: string } | undefined;
  if (input.cursor) {
    try {
      cursor = z
        .object({
          date: z.string(),
          id: z.string().max(200),
          filter: z.string(),
        })
        .parse(
          JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")),
        );
    } catch {
      throw new Error("信号分页位置无效，请重新检索");
    }
    if (cursor.filter !== filter) throw new Error("信号条件已变化，请重新检索");
  }
  const rows = db
    .prepare(
      `SELECT id,symbol,observed_date date,json_extract(payload,'$.strategy') strategy,
    substr(json_extract(payload,'$.invalidation'),1,160) invalidation FROM signal_ledger
    WHERE symbol=@symbol AND observed_date<=@through
    AND (@date IS NULL OR observed_date<@date OR (observed_date=@date AND id<@id))
    AND (instr(lower(id),lower(@query))>0 OR instr(lower(json_extract(payload,'$.strategy')),lower(@query))>0)
    ORDER BY observed_date DESC,id DESC LIMIT 21`,
    )
    .all({
      symbol: input.symbol,
      through: input.date,
      query: input.query,
      date: cursor?.date ?? null,
      id: cursor?.id ?? null,
    }) as {
    id: string;
    symbol: string;
    date: string;
    strategy: string;
    invalidation: string | null;
  }[];
  const items = rows.slice(0, 20),
    last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > 20 && last
        ? Buffer.from(
            JSON.stringify({ date: last.date, id: last.id, filter }),
          ).toString("base64url")
        : null,
  };
}
export function tradeWorkspaceExport(db: Database.Database, raw: unknown) {
  return db.transaction(() => {
    const { input, version } = scope(db, raw);
    // Selection and full payload share a single read transaction and fact version.
    const rows = db
      .prepare(
        `WITH rows AS (${metadata}) SELECT t.payload FROM rows r JOIN trade_ledger t ON t.id=r.id
      WHERE r.id IN (SELECT id FROM rows WHERE ${where}) ORDER BY r.date DESC,r.createdAt DESC,r.id DESC`,
      )
      .all(params(input)) as { payload: string }[];
    return {
      schemaVersion: 1,
      generatedAt: Date.now(),
      version,
      filters: tradeWorkspaceFilters.parse(input),
      count: rows.length,
      trades: rows.map((row) => JSON.parse(row.payload) as Trade),
    };
  })();
}

/** Spreadsheet import must not evaluate notes/IDs as formulas. Numeric columns stay numeric. */
export function tradeWorkspaceCsv(trades: Trade[]) {
  const cell = (value: string | number | null) => {
    const text = String(value ?? "");
    const safe =
      typeof value === "string" && /^[\s]*[=+@-]/.test(text)
        ? `'${text}`
        : text;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  return (
    "\uFEFF" +
    [
      [
        "交易ID",
        "证券",
        "交易日期",
        "录入时间",
        "方向",
        "价格",
        "数量",
        "佣金",
        "税",
        "滑点",
        "费用合计",
        "费用模型",
        "关联信号",
        "备注",
      ],
      ...trades.map((t) => [
        t.id,
        t.symbol,
        t.date,
        t.createdAt,
        t.side,
        t.price,
        t.quantity,
        t.fees.commission,
        t.fees.tax,
        t.fees.slippage,
        t.fees.total,
        t.costs.version,
        t.signalId,
        t.note,
      ]),
    ]
      .map((row) => row.map(cell).join(","))
      .join("\r\n")
  );
}
