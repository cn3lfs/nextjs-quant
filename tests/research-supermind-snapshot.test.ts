import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildSupermindRows,
  canonicalSupermindPayload,
  captureStamp,
  dateOnlyKnowableAt,
  materializeSupermindRows,
  supermindCaptureId,
  supermindFrozenRowSchema,
  toLocalSymbol,
  type SupermindDisclosureRaw,
} from "../src/lib/research-supermind-snapshot";
import { createAsOfAdapter } from "../src/lib/as-of";
import {
  captureDirectory,
  freezeSupermindSnapshot,
  listSupermindCaptures,
  readSupermindSnapshot,
  verifySupermindSnapshots,
} from "../src/server/research/research-supermind-store";

const disclosure = (overrides: Partial<SupermindDisclosureRaw> = {}) =>
  ({
    table: "income" as const,
    symbol: "600519.SH",
    snapshotDate: "2020-04-10",
    reportDate: "2019-10-16",
    statDate: "2019-09-30",
    changeId: 1,
    metrics: { overall_income: "63508663046.7" },
    ...overrides,
  }) satisfies SupermindDisclosureRaw;

const roots: string[] = [];
function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "supermind-snapshot-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("时点换算", () => {
  it("公布日只精确到日，可知时点取其次日零点（东八区）", () => {
    // A date-only disclosure may reach the market at any point during its own
    // day, so the earliest defensible knowable instant is the next day's start.
    expect(dateOnlyKnowableAt("2020-04-10")).toBe("2020-04-11T00:00:00+08:00");
    expect(dateOnlyKnowableAt("2019-02-28")).toBe("2019-03-01T00:00:00+08:00");
    expect(dateOnlyKnowableAt("2020-02-28")).toBe("2020-02-29T00:00:00+08:00");
    expect(dateOnlyKnowableAt("2019-12-31")).toBe("2020-01-01T00:00:00+08:00");
    expect(() => dateOnlyKnowableAt("2020-13-01")).toThrow();
    expect(() => dateOnlyKnowableAt("20200410")).toThrow();
  });

  it("平台代码转本仓库代码，非法后缀直接拒绝", () => {
    expect(toLocalSymbol("600519.SH")).toBe("sh600519");
    expect(toLocalSymbol("000001.SZ")).toBe("sz000001");
    expect(toLocalSymbol("920414.BJ")).toBe("bj920414");
    expect(() => toLocalSymbol("600519")).toThrow();
    expect(() => toLocalSymbol("600519.XX")).toThrow();
  });
});

describe("披露日行映射", () => {
  it("报告期进 effectiveAt，公布日进 availableAt，两者不得互换", () => {
    const [row] = buildSupermindRows("disclosure-dates", [disclosure()]);
    expect(row).toMatchObject({
      domain: "finance",
      entity: "sh600519",
      field: "incomeStatement",
      // 报告期
      effectiveAt: "2019-09-30",
      // 公布日 2019-10-16 -> 次日零点，且绝不等于报告期
      availableAt: "2019-10-17T00:00:00+08:00",
      versionId: "income:sh600519:2019-09-30:2019-10-16:chg1",
      unit: "CNY-statement",
    });
    // The frozen value is the statement's metric object, not a bare number:
    // one row per (table, symbol, 报告期, 版本), so the row count stays at one
    // per period rather than one per metric.
    expect(row!.value).toEqual({ overall_income: "63508663046.7" });
    expect(row!.effectiveAt).not.toBe(row!.availableAt.slice(0, 10));
  });

  it("四张表各有自己的 field 与 unit，versionId 带表名", () => {
    const rows = buildSupermindRows("disclosure-dates", [
      disclosure({ table: "income" }),
      disclosure({ table: "balance" }),
      disclosure({ table: "cashflow" }),
      disclosure({ table: "valuation" }),
    ]);
    expect(rows.map((row) => row.field)).toEqual([
      "incomeStatement",
      "balanceStatement",
      "cashflowStatement",
      "valuationMultiples",
    ]);
    expect(rows.map((row) => row.unit)).toEqual([
      "CNY-statement",
      "CNY-statement",
      "CNY-statement",
      "CNY-and-ratio",
    ]);
    expect(
      rows.every((row) =>
        String(row.versionId).startsWith(
          row.field === "valuationMultiples" ? "valuation:" : "",
        ),
      ),
    ).toBe(true);
  });

  it("不同证券的同一披露版本拥有不同 versionId", () => {
    const rows = buildSupermindRows("disclosure-dates", [
      disclosure({ symbol: "600519.SH" }),
      disclosure({ symbol: "600000.SH" }),
    ]);
    expect(rows.map((row) => row.versionId)).toEqual([
      "income:sh600519:2019-09-30:2019-10-16:chg1",
      "income:sh600000:2019-09-30:2019-10-16:chg1",
    ]);
  });

  it("valuation 没有 change_id 列，缺列与 0 不是同一件事", () => {
    const [withNull] = buildSupermindRows("disclosure-dates", [
      disclosure({ table: "valuation", changeId: null }),
    ]);
    const [withZero] = buildSupermindRows("disclosure-dates", [
      disclosure({ table: "valuation", changeId: 0 }),
    ]);
    expect(withNull!.versionId).toContain(":chgnone");
    expect(withZero!.versionId).toContain(":chg0");
    expect(withNull!.availabilityEvidence.reference).toContain(
      "change_id=none",
    );
  });

  it("数值以十进制字符串冻结，不经二进制浮点", () => {
    const [row] = buildSupermindRows("disclosure-dates", [
      disclosure({ metrics: { overall_income: "367893877538.94" } }),
    ]);
    expect(row!.value).toEqual({ overall_income: "367893877538.94" });
    expect(typeof (row!.value as Record<string, unknown>).overall_income).toBe(
      "string",
    );
  });

  it("指标键按字典序落库，不随平台返回列的顺序变化", () => {
    const [forward] = buildSupermindRows("disclosure-dates", [
      disclosure({ metrics: { zeta: "1", alpha: "2", mid: "3" } }),
    ]);
    const [reversed] = buildSupermindRows("disclosure-dates", [
      disclosure({ metrics: { mid: "3", alpha: "2", zeta: "1" } }),
    ]);
    expect(Object.keys(forward!.value as object)).toEqual([
      "alpha",
      "mid",
      "zeta",
    ]);
    expect(JSON.stringify(forward!.value)).toBe(
      JSON.stringify(reversed!.value),
    );
  });

  it("原始字段缺失或以错误类型出现时报错，不静默降级", () => {
    const broken = { ...disclosure(), changeId: "1" };
    expect(() => buildSupermindRows("disclosure-dates", [broken])).toThrow(
      /原始数据不符合契约/,
    );
    const missing = { ...disclosure() } as Record<string, unknown>;
    delete missing.reportDate;
    expect(() => buildSupermindRows("disclosure-dates", [missing])).toThrow(
      /原始数据不符合契约/,
    );
    // 未知表名必须被拒绝：profit_report 是业绩快报表，不属于本数据集。
    expect(() =>
      buildSupermindRows("disclosure-dates", [
        { ...disclosure(), table: "profit_report" },
      ]),
    ).toThrow(/原始数据不符合契约/);
    // 指标值必须是十进制文本；浮点数说明远端没有做转换。
    expect(() =>
      buildSupermindRows("disclosure-dates", [
        { ...disclosure(), metrics: { overall_income: 1.5 } },
      ]),
    ).toThrow(/原始数据不符合契约/);
    expect(() =>
      buildSupermindRows("disclosure-dates", [
        { ...disclosure(), reporttypecode: true },
      ]),
    ).toThrow(/原始数据不符合契约/);
    expect(() =>
      buildSupermindRows("disclosure-dates", [
        { ...disclosure(), reporttypecode: "NaN" },
      ]),
    ).toThrow(/原始数据不符合契约/);
  });

  it("保留原始 reporttypecode，但不在快照层解释其业务语义", () => {
    const [row] = buildSupermindRows("disclosure-dates", [
      disclosure({ reporttypecode: "1" }),
    ]);
    expect(row?.availabilityEvidence).toMatchObject({ reporttypecode: "1" });
    const materialized = materializeSupermindRows(
      [row!],
      "2026-09-19T05:10:00+08:00",
    );
    expect(materialized[0]?.availabilityEvidence).toMatchObject({
      reporttypecode: "1",
    });

    const [numeric] = buildSupermindRows("disclosure-dates", [
      disclosure({ reporttypecode: 1 }),
    ]);
    expect(numeric?.availabilityEvidence).toMatchObject({ reporttypecode: 1 });
    expect(numeric?.versionId).toContain(":reporttype=");

    const [otherNumeric] = buildSupermindRows("disclosure-dates", [
      disclosure({ reporttypecode: 2 }),
    ]);
    expect(otherNumeric?.versionId).not.toBe(numeric?.versionId);

    const [unknown] = buildSupermindRows("disclosure-dates", [
      disclosure({ reporttypecode: null }),
    ]);
    expect(unknown?.availabilityEvidence).toMatchObject({
      reporttypecode: null,
    });
  });
});

describe("时点成分行映射", () => {
  const raw = {
    indexCode: "000510.CSI",
    snapshotDate: "2024-09-30",
    symbols: ["000001.SZ", "600519.SH"],
  };

  it("成分日进 effectiveAt，成分表进 rs/members", () => {
    const [row] = buildSupermindRows("index-members", [raw]);
    expect(row).toMatchObject({
      domain: "rs",
      entity: "000510.CSI",
      field: "members",
      effectiveAt: "2024-09-30",
      availableAt: "2024-10-01T00:00:00+08:00",
      unit: "security",
      value: ["sz000001", "sh600519"],
    });
  });

  it("成分重复或全部非法时报错，不静默去重", () => {
    expect(() =>
      buildSupermindRows("index-members", [
        { ...raw, symbols: ["000001.SZ", "000001.SZ"] },
      ]),
    ).toThrow(/成分重复/);
    expect(() =>
      buildSupermindRows("index-members", [{ ...raw, symbols: ["600519"] }]),
    ).toThrow(/无法识别的证券代码/);
  });
});

describe("载荷规范化", () => {
  const rows = () =>
    buildSupermindRows("disclosure-dates", [
      disclosure({ symbol: "600000.SH", statDate: "2019-09-30" }),
      disclosure({ symbol: "000001.SZ", statDate: "2019-12-31" }),
      // Same facts read at a later snapshot date: must collapse, not duplicate.
      disclosure({
        symbol: "000001.SZ",
        statDate: "2019-12-31",
        snapshotDate: "2020-04-20",
      }),
    ]);

  it("排序并去重，输入顺序不影响字节", () => {
    const forward = canonicalSupermindPayload(rows());
    const reversed = canonicalSupermindPayload([...rows()].reverse());
    expect(forward).toBe(reversed);
    expect(forward.split("\n").filter(Boolean)).toHaveLength(2);
  });

  it("同一事实在不同快照日被读到只落一行", () => {
    const text = canonicalSupermindPayload(rows());
    const parsed = text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(parsed).toHaveLength(2);
    expect(
      parsed.every((row) => supermindFrozenRowSchema.safeParse(row).success),
    ).toBe(true);
  });

  it("载荷行不含 capturedAt：它标识采集而非数值", () => {
    const parsed = JSON.parse(
      canonicalSupermindPayload(rows()).split("\n")[0]!,
    );
    expect(parsed).not.toHaveProperty("capturedAt");
    expect(Object.keys(parsed).sort()).toEqual([
      "availabilityEvidence",
      "availableAt",
      "domain",
      "effectiveAt",
      "entity",
      "field",
      "source",
      "unit",
      "value",
      "versionId",
    ]);
  });

  it("采集标识由采集时刻与载荷哈希共同决定", () => {
    expect(captureStamp("2026-09-19T13:10:00+08:00")).toBe("20260919T051000Z");
    expect(
      supermindCaptureId("2026-09-19T13:10:00+08:00", "a".repeat(64)),
    ).toBe("20260919T051000Z-aaaaaaaaaaaa");
  });
});

describe("接入既有 as-of 契约", () => {
  const capturedAt = "2026-09-19T05:10:00+08:00";
  const metrics = z.record(z.string(), z.string());
  const read = (rows: ReturnType<typeof buildSupermindRows>, asOf: string) =>
    createAsOfAdapter(materializeSupermindRows(rows, capturedAt), {
      asOf,
    }).read({
      domain: "finance",
      entity: "sh600519",
      field: "incomeStatement",
      effectiveAt: "2019-09-30",
      unit: "CNY-statement",
      schema: metrics,
    });

  it("公布日之前读不到该报告期的值", () => {
    const rows = buildSupermindRows("disclosure-dates", [disclosure()]);
    // 报告期尚未开始：请求的生效时点晚于研究时点。
    expect(read(rows, "2019-09-29T15:00:00+08:00")).toMatchObject({
      status: "missing",
      code: "not-effective",
    });
    // 报告期当天（2019-09-30）：报告期本身不是可知时间，仍必须 missing。
    expect(read(rows, "2019-09-30T15:00:00+08:00")).toMatchObject({
      status: "missing",
      code: "no-coverage",
    });
    // 公布日当天收盘后仍读不到：可知时点被保守地推到次日零点。
    expect(read(rows, "2019-10-16T20:00:00+08:00")).toMatchObject({
      status: "missing",
      code: "no-coverage",
    });
    expect(read(rows, "2019-10-17T09:30:00+08:00")).toMatchObject({
      status: "available",
      value: { overall_income: "63508663046.7" },
    });
  });

  it("修订有更晚的可知时点：早时点读旧值，晚时点读新值", () => {
    const original = buildSupermindRows("disclosure-dates", [disclosure()]);
    // 更正公告：同一报告期，更晚的公布日与新的变更批次。
    const restated = buildSupermindRows("disclosure-dates", [
      disclosure({
        reportDate: "2019-12-05",
        changeId: 2,
        metrics: { overall_income: "63508663000.0" },
      }),
    ]);
    const rows = [...original, ...restated];
    const early = read(rows, "2019-11-01T09:30:00+08:00");
    expect(early).toMatchObject({
      status: "available",
      value: { overall_income: "63508663046.7" },
    });
    if (early.status !== "available") throw new Error("unreachable");
    expect(early.provenance.versionId).toBe(
      "income:sh600519:2019-09-30:2019-10-16:chg1",
    );
    const late = read(rows, "2019-12-10T09:30:00+08:00");
    expect(late).toMatchObject({
      status: "available",
      value: { overall_income: "63508663000.0" },
    });
    if (late.status !== "available") throw new Error("unreachable");
    expect(late.provenance.versionId).toBe(
      "income:sh600519:2019-09-30:2019-12-05:chg2",
    );
  });

  it("同一可知时点出现冲突值时不择优，报冲突", () => {
    const rows = [
      ...buildSupermindRows("disclosure-dates", [disclosure()]),
      // 同一公布日、不同变更批次、不同数值：与修订不同，这里没有先后之分。
      ...buildSupermindRows("disclosure-dates", [
        disclosure({ changeId: 2, metrics: { overall_income: "1.0" } }),
      ]),
    ];
    expect(read(rows, "2019-11-01T09:30:00+08:00")).toMatchObject({
      status: "missing",
      code: "value-conflict",
    });
  });
});

describe("冻结快照存储", () => {
  const request = { api: "get_fundamentals(query(income), date=D)" };

  const freeze = (root: string, capturedAt: string, symbol = "600519.SH") =>
    freezeSupermindSnapshot({
      dataset: "disclosure-dates",
      raw: [disclosure({ symbol })],
      request,
      capturedAt,
      root,
    });

  it("分片合并 == 一次性抓取：顺序无关、重叠无语义影响", () => {
    const root = temporaryRoot();
    // Shard boundaries are an operational detail (20 remote runs of ~18 min).
    // If the merged payload depended on shard order or on a record appearing in
    // two shards, "sharded fetch" would not be the same experiment as a single
    // fetch, and the freeze could not be compared across runs.
    const shardA = [
      disclosure({ symbol: "600519.SH", statDate: "2019-09-30" }),
      disclosure({ symbol: "600000.SH", statDate: "2019-09-30" }),
    ];
    const shardB = [
      disclosure({ symbol: "000001.SZ", statDate: "2019-12-31" }),
      // Deliberate overlap across the shard boundary.
      disclosure({ symbol: "600000.SH", statDate: "2019-09-30" }),
    ];
    const oneShot = freezeSupermindSnapshot({
      dataset: "disclosure-dates",
      raw: [...shardA, ...shardB],
      request,
      capturedAt: "2026-09-19T13:10:00+08:00",
      root,
    });
    const merged = freezeSupermindSnapshot({
      dataset: "disclosure-dates",
      raw: [...shardB, ...shardA],
      request,
      capturedAt: "2026-09-19T13:10:00+08:00",
      root,
    });
    const reversed = freezeSupermindSnapshot({
      dataset: "disclosure-dates",
      raw: [...shardB].reverse().concat([...shardA].reverse()),
      request,
      capturedAt: "2026-09-19T13:10:00+08:00",
      root,
    });
    expect(merged.payloadHash).toBe(oneShot.payloadHash);
    expect(reversed.payloadHash).toBe(oneShot.payloadHash);
    expect(merged.captureId).toBe(oneShot.captureId);
    expect(oneShot.alreadyFrozen).toBe(false);
    expect(merged.alreadyFrozen).toBe(true);
    expect(oneShot.rowCount).toBe(3);
    expect(readFileSync(merged.payloadPath, "utf8")).toBe(
      readFileSync(oneShot.payloadPath, "utf8"),
    );
  });

  it("同一请求两次采集：载荷字节一致，差异只落在 capturedAt", () => {
    const root = temporaryRoot();
    const first = freeze(root, "2026-09-19T13:10:00+08:00");
    const second = freeze(root, "2026-09-19T14:25:00+08:00");
    expect(first.captureId).not.toBe(second.captureId);
    expect(second.payloadHash).toBe(first.payloadHash);
    expect(readFileSync(second.payloadPath, "utf8")).toBe(
      readFileSync(first.payloadPath, "utf8"),
    );
    const envelopeOf = (path: string) => JSON.parse(readFileSync(path, "utf8"));
    const a = envelopeOf(first.envelopePath);
    const b = envelopeOf(second.envelopePath);
    expect({ ...a, captureId: null, capturedAt: null }).toEqual({
      ...b,
      captureId: null,
      capturedAt: null,
    });
    expect(b.capturedAt).toBe("2026-09-19T14:25:00+08:00");
    expect(listSupermindCaptures("disclosure-dates", root)).toHaveLength(2);
  });

  it("相同载荷重复冻结不重写文件", () => {
    const root = temporaryRoot();
    const first = freeze(root, "2026-09-19T13:10:00+08:00");
    // The capture id contains the stamp, so an identical payload at a different
    // moment is a different directory; the same id must then re-verify, not rewrite.
    const again = freezeSupermindSnapshot({
      dataset: "disclosure-dates",
      raw: [disclosure({ symbol: "600519.SH" })],
      request,
      capturedAt: "2026-09-19T13:10:00+08:00",
      root,
    });
    expect(again.captureId).toBe(first.captureId);
    expect(again.alreadyFrozen).toBe(true);
    expect(verifySupermindSnapshots(root).broken).toEqual([]);
  });

  it("载荷被改写后读取失败，不返回被篡改的数值", () => {
    const root = temporaryRoot();
    const frozen = freeze(root, "2026-09-19T13:10:00+08:00");
    const payload = readFileSync(frozen.payloadPath, "utf8");
    writeFileSync(
      frozen.payloadPath,
      payload.replace("63508663046.7", "1.0"),
      "utf8",
    );
    expect(() =>
      readSupermindSnapshot({ dataset: "disclosure-dates", root }),
    ).toThrow(/载荷与信封哈希不一致/);
    expect(verifySupermindSnapshots(root).broken).toEqual([
      expect.stringContaining("载荷哈希不符"),
    ]);
  });

  it("读取默认取最近一次采集，并还原成合法 as-of 观测", () => {
    const root = temporaryRoot();
    freeze(root, "2026-09-19T13:10:00+08:00");
    const latest = freeze(root, "2026-09-19T14:25:00+08:00");
    const read = readSupermindSnapshot({ dataset: "disclosure-dates", root });
    expect(read.envelope.captureId).toBe(latest.captureId);
    expect(read.rows).toHaveLength(1);
    expect(read.rows[0]).not.toHaveProperty("capturedAt");
    expect(read.observations[0]!.capturedAt).toBe("2026-09-19T14:25:00+08:00");
    expect(read.observations[0]!.availableAt).toBe("2019-10-17T00:00:00+08:00");
  });

  it("没有冻结快照时读取失败并说明回测不得实时拉取", () => {
    const root = temporaryRoot();
    expect(() =>
      readSupermindSnapshot({ dataset: "index-members", root }),
    ).toThrow(/尚无冻结快照/);
  });

  it("采集标识不得越出数据集目录", () => {
    const root = temporaryRoot();
    expect(() =>
      captureDirectory("disclosure-dates", "../escape", root),
    ).toThrow(/快照标识非法/);
  });
});
