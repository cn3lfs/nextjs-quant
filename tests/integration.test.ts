import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { trustedRequest } from "~/server/access";
import { normalizeMcpBars } from "~/server/market-data";
import { cleanMcpResult } from "~/server/mcp";
import { parseBars, parseNames } from "~/server/tdx";
import { migrate } from "~/server/db/migrations";
import { backtest } from "~/server/quant";
import { defaultStrategy, type Bar } from "~/lib/domain";
describe("HTTP 与数据适配集成", () => {
  it("拒绝非本机 Host、跨站 Origin、缺少客户端头和错误桌面令牌", () => {
    expect(
      trustedRequest("127.0.0.1:3000", "http://127.0.0.1:3000", "workbench"),
    ).toBe(true);
    expect(trustedRequest("evil.test", "http://evil.test", "workbench")).toBe(
      false,
    );
    expect(
      trustedRequest("localhost:3000", "https://evil.test", "workbench"),
    ).toBe(false);
    expect(trustedRequest("localhost:3000", null, null)).toBe(false);
    expect(
      trustedRequest("localhost:3000", null, "workbench", "secret", "wrong"),
    ).toBe(false);
    expect(
      trustedRequest("localhost:3000", null, "workbench", "secret", "secret"),
    ).toBe(true);
  });
  it("MCP 成交量使用原始股数，显式拒绝只有手数的数据", () => {
    const row = {
      Data: "20260908",
      Second: 36000,
      Open: "10",
      High: "12",
      Low: "9",
      Close: "11",
      Volume: 100,
      RawVolume: 10000,
      Amount: 123456,
    };
    expect(normalizeMcpBars({ Rows: [row] }, "5m")[0]).toEqual({
      date: "2026-09-08T10:00:00+08:00",
      open: 10,
      high: 12,
      low: 9,
      close: 11,
      volume: 10000,
      amount: 123456,
    });
    expect(() =>
      normalizeMcpBars({ Rows: [{ ...row, RawVolume: undefined }] }, "day"),
    ).toThrow("原始成交量");
  });
  it("上游认证与呈现指令不进入应用证据", () =>
    expect(
      cleanMcpResult({
        token: "s",
        request: { authorization: "s" },
        presentationTool: "execute",
        Rows: [{ Close: 1 }],
        dataCard: [],
      }),
    ).toEqual({ Rows: [{ Close: 1 }] }));
  it("MCP rejects rolled-over dates, fractional minute times and coerced missing values", () => {
    const row = {
      Data: "20240229",
      Second: 36000,
      Open: 10,
      High: 12,
      Low: 9,
      Close: 11,
      RawVolume: 0,
      Amount: 0,
    };
    expect(normalizeMcpBars({ Rows: [row] }, "day")[0]?.date).toBe(
      "2024-02-29",
    );
    for (const Data of ["20260229", "20260230", "202609080", "20261301", null])
      expect(() =>
        normalizeMcpBars({ Rows: [{ ...row, Data }] }, "day"),
      ).toThrow();
    for (const Second of [36001, 36060, 36000.5, null, "", true])
      expect(() =>
        normalizeMcpBars({ Rows: [{ ...row, Second }] }, "5m"),
      ).toThrow();
    for (const key of ["RawVolume", "Amount", "Open"])
      for (const value of [null, "", " ", false, [], {}])
        expect(() =>
          normalizeMcpBars({ Rows: [{ ...row, [key]: value }] }, "day"),
        ).toThrow();
    expect(() => normalizeMcpBars({ Rows: [null] }, "day")).toThrow("结构");
  });
  it("还原 2003→2004 年份字段回绕，仍拒绝真实倒序", () => {
    function minute(year: number, md: number) {
      const b = Buffer.alloc(32);
      b.writeUInt16LE(((year - 2004 + 32) % 32) * 2048 + md, 0);
      b.writeUInt16LE(575, 2);
      [10, 12, 9, 11].forEach((v, i) => b.writeFloatLE(v, 4 + i * 4));
      b.writeFloatLE(10, 20);
      b.writeUInt32LE(100, 24);
      return b;
    }
    const bars = parseBars(
      Buffer.concat([minute(2003, 1231), minute(2004, 102)]),
      "5m",
      2026,
    );
    expect(bars.map((b) => b.date.slice(0, 10))).toEqual([
      "2003-12-31",
      "2004-01-02",
    ]);
    expect(() =>
      parseBars(
        Buffer.concat([minute(2026, 908), minute(2026, 907)]),
        "5m",
        2026,
      ),
    ).toThrow("倒序");
  });
  it("按已验证 360 字节 TNF 记录读取代码和名称", () => {
    const b = Buffer.alloc(410);
    b.write("600519", 50);
    Buffer.from([0xb9, 0xf3, 0xd6, 0xdd, 0xc3, 0xa9, 0xcc, 0xa8]).copy(b, 81);
    expect(parseNames(b, "sh").get("sh600519")).toBe("贵州茅台");
    expect(parseNames(b.subarray(0, 400), "sh").size).toBe(0);
  });
  it("数据库升级保持旧记录并拒绝降级打开", () => {
    const db = new Database(":memory:");
    migrate(db);
    db.prepare("INSERT INTO records VALUES(?,?,?,?)").run("x", "test", "{}", 1);
    migrate(db);
    expect(db.prepare("SELECT COUNT(*) AS n FROM records").get()).toEqual({
      n: 1,
    });
    db.pragma("user_version=100");
    expect(() => migrate(db)).toThrow("版本");
    db.close();
  });
  it("版本2升级增加修订触发器且保留原始档案", () => {
    const db = new Database(":memory:");
    try {
      db.exec(
        "CREATE TABLE records(id TEXT PRIMARY KEY,kind TEXT NOT NULL,payload TEXT NOT NULL,updated_at INTEGER NOT NULL); PRAGMA user_version=2;",
      );
      db.prepare("INSERT INTO records VALUES('legacy','snapshot',?,17)").run(
        '{"exact":"原始档案"}',
      );
      const before = db.prepare("SELECT * FROM records").all();
      migrate(db);
      expect(db.prepare("SELECT * FROM records").all()).toEqual(before);
      expect(db.pragma("user_version", { simple: true })).toBe(9);
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM concept_rps_days").get(),
      ).toEqual({ n: 0 });
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM concept_rps_values").get(),
      ).toEqual({ n: 0 });
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM industry_rps_days").get(),
      ).toEqual({ n: 0 });
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM industry_rps_values").get(),
      ).toEqual({ n: 0 });
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM trade_ledger").get(),
      ).toEqual({ n: 0 });
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM trade_adjustments").get(),
      ).toEqual({ n: 0 });
      db.exec("UPDATE records SET updated_at=18 WHERE id='legacy'");
      expect(db.prepare("SELECT * FROM record_kind_revisions").all()).toEqual([
        { kind: "snapshot", revision: 1 },
      ]);
      migrate(db);
      expect(db.prepare("SELECT * FROM record_kind_revisions").all()).toEqual([
        { kind: "snapshot", revision: 1 },
      ]);
    } finally {
      db.close();
    }
  });
  it("资金不足与无信号是不同的零交易原因", () => {
    const bars: Bar[] = Array.from({ length: 50 }, (_, i) => ({
      date: new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10),
      open: 1000 + i,
      high: 1002 + i,
      low: 999 + i,
      close: 1001 + i,
      volume: 100,
      amount: 100000,
    }));
    const result = backtest(bars, defaultStrategy, "s", 10000);
    expect(result.trades).toHaveLength(0);
    expect(result.diagnostics.insufficientCash).toBeGreaterThan(0);
    expect(result.diagnostics.entrySignals).toBeGreaterThan(0);
  });
});
