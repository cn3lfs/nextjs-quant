import type Database from "better-sqlite3";
import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { z } from "zod";
import { importOptionsSchema } from "~/lib/research/evidence/delivery-import";
import {
  previewDeliveryImport,
  commitDeliveryImport,
} from "./delivery-import-service";
import {
  deliveryAccountVersion,
  deliveryBatchReceipt,
} from "./delivery-workspace-query";

export const deliveryPreviewInputSchema = importOptionsSchema.extend({
  path: z.string().trim().min(1).max(2048),
  account: z.string().trim().min(1).max(64),
});
export const deliveryPreviewTokenSchema = z.string().uuid();
export const deliveryPreviewPageSchema = z.object({
  token: deliveryPreviewTokenSchema,
  status: z
    .enum(["all", "new", "duplicate", "conflict", "unresolved", "anomaly"])
    .default("all"),
  keyword: z.string().trim().max(255).default(""),
  offset: z.number().int().nonnegative().default(0),
});
type Preview = ReturnType<typeof previewDeliveryImport>;
type Identity = z.infer<typeof deliveryPreviewInputSchema> & {
  hash: string;
  version: string;
  ruleVersion: "delivery-v1";
};
type Entry = {
  db: Database.Database;
  identity: Identity;
  preview?: Preview;
  bytes: number;
  touched: number;
};

async function bytesFor(path: string) {
  if (![".csv", ".txt", ".xls"].includes(extname(path).toLowerCase()))
    throw new Error("仅支持 .xls / .txt / .csv 交割单文件");
  return readFile(path);
}
function hash(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

export class DeliveryPreviewWorkspace {
  private entries = new Map<string, Entry>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private limits = { count: 4, bytes: 64 * 1024 * 1024, ttl: 10 * 60_000 },
    private now = () => Date.now(),
  ) {}
  private sweep() {
    for (const [token, entry] of this.entries)
      if (this.now() - entry.touched >= this.limits.ttl)
        this.entries.delete(token);
  }
  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    if (!this.entries.size) {
      this.timer = undefined;
      return;
    }
    const deadline = Math.min(
      ...[...this.entries.values()].map(
        (entry) => entry.touched + this.limits.ttl,
      ),
    );
    this.timer = setTimeout(
      () => {
        this.sweep();
        this.schedule();
      },
      Math.max(1, deadline - this.now()),
    );
    this.timer.unref();
  }
  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.entries.clear();
  }
  stats() {
    this.sweep();
    return {
      count: this.entries.size,
      bytes: [...this.entries.values()].reduce(
        (n, entry) => n + entry.bytes,
        0,
      ),
    };
  }
  private get(db: Database.Database, token: string) {
    this.sweep();
    const entry = this.entries.get(token);
    if (!entry || entry.db !== db)
      throw new Error("预览已过期或服务已重启，请重新预览");
    entry.touched = this.now();
    this.entries.delete(token);
    this.entries.set(token, entry);
    this.schedule();
    return entry;
  }
  async start(db: Database.Database, raw: unknown) {
    const options = deliveryPreviewInputSchema.parse(raw);
    options.path = resolve(options.path);
    const bytes = await bytesFor(options.path);
    const { preview, version } = db.transaction(() => ({
      preview: previewDeliveryImport(
        bytes,
        { ...options, fileName: basename(options.path) },
        db,
      ),
      version: deliveryAccountVersion(db, options.account),
    }))();
    const identity: Identity = {
      ...options,
      scope: options.scope ?? "all",
      hash: preview.fileHash,
      version,
      ruleVersion: "delivery-v1",
    };
    const size = Buffer.byteLength(JSON.stringify(preview));
    this.sweep();
    const retained = size <= this.limits.bytes;
    while (
      this.entries.size &&
      (this.entries.size >= this.limits.count ||
        this.stats().bytes + (retained ? size : 0) > this.limits.bytes)
    )
      this.entries.delete(this.entries.keys().next().value!);
    const token = randomUUID();
    this.entries.set(token, {
      db,
      identity,
      preview: retained ? preview : undefined,
      bytes: retained ? size : 0,
      touched: this.now(),
    });
    this.schedule();
    return {
      token,
      identity,
      summary: preview.summary,
      mapping: preview.mapping,
      sourceHeader: preview.sourceHeader,
      format: preview.format,
      encoding: preview.encoding,
      diagnostics: preview.diagnostics,
      cached: retained,
      expiresInMs: this.limits.ttl,
    };
  }
  private async materialize(db: Database.Database, token: string) {
    const entry = this.get(db, token);
    if (
      deliveryAccountVersion(db, entry.identity.account) !==
      entry.identity.version
    )
      throw new Error("账户批次已变化，请重新预览");
    if (entry.preview) return { entry, preview: entry.preview };
    const bytes = await bytesFor(entry.identity.path);
    if (hash(bytes) !== entry.identity.hash)
      throw new Error("文件已改变，请重新预览");
    // File I/O yields; recheck account identity before classifying rows.
    if (
      deliveryAccountVersion(db, entry.identity.account) !==
      entry.identity.version
    )
      throw new Error("账户批次已变化，请重新预览");
    return {
      entry,
      preview: previewDeliveryImport(
        bytes,
        { ...entry.identity, fileName: basename(entry.identity.path) },
        db,
      ),
    };
  }
  async page(db: Database.Database, raw: unknown) {
    const input = deliveryPreviewPageSchema.parse(raw);
    const { preview } = await this.materialize(db, input.token);
    const parsed = new Map(
      [...preview.parsed.fills, ...preview.parsed.cashFlows].map((row) => [
        row.rowIndex,
        row,
      ]),
    );
    const rows = [
      ...preview.rows.map((row) => ({
        rowIndex: row.rowIndex,
        status: row.status as string,
        type: row.type as string,
        differences: row.differences,
        value: parsed.get(row.rowIndex),
        cells: preview.rawRows[row.rowIndex - 1] ?? [],
        reason: null as string | null,
      })),
      ...preview.parsed.unresolved.map((row) => ({
        rowIndex: row.rowIndex,
        status: "unresolved",
        type: "unresolved",
        differences: [] as string[],
        value: undefined as
          | (typeof preview.parsed.fills)[number]
          | (typeof preview.parsed.cashFlows)[number]
          | undefined,
        cells: row.cells,
        reason: row.reason,
      })),
    ]
      .sort((a, b) => a.rowIndex - b.rowIndex)
      .filter((row) => {
        const anomaly =
          row.value &&
          "anomalies" in row.value &&
          row.value.anomalies.length > 0;
        return (
          (input.status === "all" ||
            input.status === row.status ||
            (input.status === "anomaly" && anomaly)) &&
          (!input.keyword ||
            JSON.stringify(row)
              .toLowerCase()
              .includes(input.keyword.toLowerCase()))
        );
      });
    return {
      items: rows.slice(input.offset, input.offset + 20),
      count: rows.length,
      nextOffset: input.offset + 20 < rows.length ? input.offset + 20 : null,
    };
  }
  async export(db: Database.Database, token: string) {
    const { entry, preview } = await this.materialize(db, token);
    return { schemaVersion: 1, identity: entry.identity, preview };
  }
  async confirm(db: Database.Database, token: string) {
    const entry = this.get(db, token),
      identity = entry.identity;
    const existing = () => {
      const receipt = deliveryBatchReceipt(db, identity.account, identity.hash);
      if (!receipt) return null;
      if (
        receipt.scope !== identity.scope ||
        receipt.source !== identity.source
      )
        throw new Error("同一文件已按不同来源或范围导入，请核对既有批次");
      return {
        batchId: receipt.id,
        alreadyImported: true,
        fills: 0,
        cashFlows: 0,
        duplicate: receipt.statistics.fills + receipt.statistics.cashFlows,
      };
    };
    const saved = existing();
    if (saved) return saved;
    const bytes = await bytesFor(identity.path);
    if (hash(bytes) !== identity.hash)
      throw new Error("文件已改变，请重新预览后确认导入");
    return db
      .transaction(() => {
        const savedDuringRead = existing();
        if (savedDuringRead) return savedDuringRead;
        if (deliveryAccountVersion(db, identity.account) !== identity.version)
          throw new Error("账户批次已变化，请重新预览后确认导入");
        return commitDeliveryImport(
          bytes,
          { ...identity, fileName: basename(identity.path) },
          db,
        );
      })
      .immediate();
  }
}
export const deliveryPreviewWorkspace = new DeliveryPreviewWorkspace();
