import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readLocalFinancialSeries } from "../../src/server/data-sources/tdx/local-financial-files";
import {
  sectorValuation,
  summarizeSectorValuation,
} from "../../src/server/financial/sector-valuation";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

/** 13-byte 本地序列记录：组号、YYYYMMDD、两列 float。 */
function record(group: number, date: number, first: number) {
  const bytes = Buffer.alloc(13);
  bytes[0] = group;
  bytes.writeUInt32LE(date, 1);
  bytes.writeFloatLE(first, 5);
  bytes.writeFloatLE(0, 9);
  return bytes;
}

async function fixtureRoot(series: Record<string, Buffer[]>) {
  const root = await mkdtemp(join(tmpdir(), "quant-sector-valuation-"));
  roots.push(root);
  await cp("tests/fixtures/tdx-local-blocks", join(root, "T0002", "hq_cache"), {
    recursive: true,
  });
  await mkdir(join(root, "vipdoc", "cw"), { recursive: true });
  for (const [code, records] of Object.entries(series))
    await writeFile(
      join(root, "vipdoc", "cw", `gpsh${code}.dat`),
      Buffer.concat(records),
    );
  return root;
}

describe("板块估值：通达信本地 BK5/BK6", () => {
  it("按主档覆盖行业与概念，同名板块不合并，缺序列仍可见并给出原因", async () => {
    const root = await fixtureRoot({
      "881001": [record(5, 20261117, 25), record(6, 20261117, 2.5)],
      "880001": [record(5, 20261117, 12), record(6, 20261117, 1.2)],
    });

    const industry = await sectorValuation(root, {
      category: "industry",
      asOf: "2026-11-17",
    });
    expect(industry.total).toBe(3);
    expect(industry.counts).toEqual({ industry: 3, concept: 1 });
    expect(industry.rows.map((row) => row.code).sort()).toEqual([
      "881001",
      "881002",
      "881003",
    ]);
    expect(industry.rows.find((row) => row.code === "881001")).toMatchObject({
      status: "ok",
      name: "研究金融",
      date: "2026-11-17",
    });
    expect(industry.rows.find((row) => row.code === "881002")).toMatchObject({
      status: "unavailable",
      name: "研究银行",
      reason: "本地未下载该板块序列文件",
    });

    // 分类与代码是身份：同名或相邻名称都不能把行业数值带进概念。
    const concept = await sectorValuation(root, {
      category: "concept",
      asOf: "2026-11-17",
    });
    expect(concept.total).toBe(1);
    expect(concept.rows[0]).toMatchObject({
      category: "concept",
      code: "880001",
      name: "样本概念完整名",
      status: "ok",
    });
    expect(concept.rows[0]!.pe.value).toBe(12);
    expect(concept.rows[0]!.pb.value).toBeCloseTo(1.2);
  });

  it("分位按不高于当前值的样本数/N，负值保留原倍数且分位留空并排在末尾", async () => {
    const root = await fixtureRoot({
      "881001": [
        record(5, 20180816, 5),
        record(5, 20211117, 10),
        record(5, 20220101, 20),
        record(5, 20230101, 30),
        record(5, 20261117, 25),
        record(6, 20180816, 1),
        record(6, 20211117, 1.5),
        record(6, 20220101, 2),
        record(6, 20230101, 3),
        record(6, 20261117, 2.5),
      ],
      "881002": [record(5, 20261117, 8), record(6, 20261117, 1)],
      "881003": [record(5, 20261117, -5), record(6, 20261117, 1)],
    });

    const first = await sectorValuation(root, {
      category: "industry",
      sort: "pe",
      pageSize: 2,
      asOf: "2026-11-17",
    });
    // 先对全分类排序再分页：8 < 25，负值排最后。
    expect(first.rows.map((row) => row.code)).toEqual(["881002", "881001"]);
    const second = await sectorValuation(root, {
      category: "industry",
      sort: "pe",
      pageSize: 2,
      pageIndex: 1,
      asOf: "2026-11-17",
    });
    expect(second.rows.map((row) => row.code)).toEqual(["881003"]);
    expect(second.rows[0]!.pe.value).toBe(-5);
    expect(second.rows[0]!.pe.y5.percentile).toBeNull();
    expect(second.rows[0]!.pe.y10.percentile).toBeNull();

    const coal = first.rows.find((row) => row.code === "881001")!;
    // 5 年窗口自 2021-11-17：10、20、30、25 共 4 个有效样本，≤25 的有 3 个。
    expect(coal.pe.y5.complete).toBe(true);
    expect(coal.pe.y5.samples).toBe(4);
    expect(coal.pe.y5.notAbove).toBe(3);
    expect(coal.pe.y5.percentile).toBeCloseTo(75);
    // 数据起点 2018-08-16 早于观察日十年窗口起点 2016-11-17 之前不成立，不伪算。
    expect(coal.pe.y10.complete).toBe(false);
    expect(coal.pe.y10.samples).toBe(5);
    expect(coal.pe.y10.percentile).toBeNull();
    expect(coal.pe.y10.reason).toContain("未覆盖 10 年窗口");
    // 全历史分位覆盖 2018-08-16 起全部 5 个正样本：5、10、20、30、25，≤25 的有 4 个。
    expect(coal.pe.yAll).toMatchObject({
      years: "all",
      windowStart: "2018-08-16",
      sampleStart: "2018-08-16",
      complete: true,
      samples: 5,
      notAbove: 4,
      reason: null,
    });
    expect(coal.pe.yAll!.percentile).toBeCloseTo(80);
    expect(second.rows[0]!.pe.yAll!.percentile).toBeNull();
  });

  it("支持按 PE/PB 全历史分位升序和降序排序，非正或缺失值始终排在末尾", async () => {
    const root = await fixtureRoot({
      "881001": [
        record(5, 20180816, 10),
        record(5, 20220101, 20),
        record(5, 20261117, 15), // yAll: 2/3 = 66.67%
        record(6, 20180816, 1),
        record(6, 20220101, 2),
        record(6, 20261117, 1.5), // yAll: 2/3 = 66.67%
      ],
      "881002": [
        record(5, 20180816, 15),
        record(5, 20220101, 20),
        record(5, 20261117, 10), // yAll: 1/3 = 33.33%
        record(6, 20180816, 1),
        record(6, 20220101, 2),
        record(6, 20261117, 3), // yAll: 3/3 = 100%
      ],
      "881003": [
        record(5, 20180816, 10),
        record(5, 20261117, -5), // 负值置后
        record(6, 20180816, 1),
        record(6, 20261117, 0), // 非正置后
      ],
    });

    const peAsc = await sectorValuation(root, {
      category: "industry",
      sort: "peAll",
      descending: false,
      asOf: "2026-11-17",
    });
    expect(peAsc.rows.map((row) => row.code)).toEqual([
      "881002",
      "881001",
      "881003",
    ]);

    const peDesc = await sectorValuation(root, {
      category: "industry",
      sort: "peAll",
      descending: true,
      asOf: "2026-11-17",
    });
    expect(peDesc.rows.map((row) => row.code)).toEqual([
      "881001",
      "881002",
      "881003",
    ]);

    const pbAsc = await sectorValuation(root, {
      category: "industry",
      sort: "pbAll",
      descending: false,
      asOf: "2026-11-17",
    });
    expect(pbAsc.rows.map((row) => row.code)).toEqual([
      "881001",
      "881002",
      "881003",
    ]);

    const pbDesc = await sectorValuation(root, {
      category: "industry",
      sort: "pbAll",
      descending: true,
      asOf: "2026-11-17",
    });
    expect(pbDesc.rows.map((row) => row.code)).toEqual([
      "881002",
      "881001",
      "881003",
    ]);
  });

  it("两值对齐同一天；单值缺失不借用前一日，同日重复按歧义缺失", async () => {
    const missing = await fixtureRoot({
      "881001": [
        record(5, 20261116, 10),
        record(5, 20261117, 20),
        record(6, 20261116, 1.5),
      ],
    });
    const aligned = await sectorValuation(missing, {
      category: "industry",
      asOf: "2026-11-17",
    });
    const row = aligned.rows.find((item) => item.code === "881001")!;
    expect(row.date).toBe("2026-11-17");
    expect(row.pe.value).toBe(20);
    expect(row.pb.value).toBeNull();
    expect(row.pb.missing).toBe("missing-on-date");

    const duplicate = await fixtureRoot({
      "881001": [
        record(5, 20261117, 20),
        record(5, 20261117, 21),
        record(6, 20261117, 1.5),
      ],
    });
    const ambiguous = await sectorValuation(duplicate, {
      category: "industry",
      asOf: "2026-11-17",
    });
    const duplicated = ambiguous.rows.find((item) => item.code === "881001")!;
    expect(duplicated.pe.value).toBeNull();
    expect(duplicated.pe.missing).toBe("duplicate");
    expect(duplicated.pe.y5.percentile).toBeNull();
    expect(duplicated.pb.value).toBeCloseTo(1.5);
  });

  it("PE 与 PB 各自按本组最早无歧义记录判覆盖，较短 PB 不冒充五年满足", async () => {
    const root = await fixtureRoot({
      "881001": [
        record(5, 20180816, 10),
        record(5, 20211117, 10),
        record(5, 20220101, 20),
        record(5, 20261117, 30),
        record(6, 20250101, 1.5),
        record(6, 20261117, 1.7),
      ],
    });
    const data = await sectorValuation(root, {
      category: "industry",
      asOf: "2026-11-17",
    });
    const row = data.rows.find((item) => item.code === "881001")!;
    expect(row.pe.y5.complete).toBe(true);
    expect(row.pe.y5.percentile).toBeCloseTo((3 / 3) * 100);
    expect(row.pb.value).toBeCloseTo(1.7);
    expect(row.pb.y5.complete).toBe(false);
    expect(row.pb.y5.samples).toBe(2);
    expect(row.pb.y5.percentile).toBeNull();
    expect(row.pb.y5.reason).toContain("2025-01-01");
  });

  it("没有 BK5/BK6 记录的板块仍可见为不可用并说明原因", async () => {
    const root = await fixtureRoot({
      "881001": [record(7, 20261117, 1), record(7, 20261116, 0.9)],
    });
    const data = await sectorValuation(root, {
      category: "industry",
      asOf: "2026-11-17",
    });
    const row = data.rows.find((item) => item.code === "881001")!;
    expect(row.status).toBe("unavailable");
    expect(row.reason).toContain("没有 BK5/BK6");
    expect(row.pe.missing).toBe("no-record");
    expect(row.pb.missing).toBe("no-record");
  });

  it("截止日晚于当前北京时间时拒绝查询", async () => {
    const root = await fixtureRoot({
      "881001": [record(5, 20261117, 25), record(6, 20261117, 2.5)],
    });
    await expect(
      sectorValuation(root, { category: "industry", asOf: "2999-01-01" }),
    ).rejects.toThrow("截止日不能晚于当前北京时间");
  });

  it("每次查询只返回当前分类、排序与页次的确认结果", async () => {
    const root = await fixtureRoot({
      "881001": [record(5, 20261117, 25), record(6, 20261117, 2.5)],
      "880001": [record(5, 20261117, 12), record(6, 20261117, 1.2)],
    });
    const industry = await sectorValuation(root, {
      category: "industry",
      sort: "pe",
      asOf: "2026-11-17",
    });
    expect(industry.category).toBe("industry");
    expect(industry.sort).toBe("pe");
    expect(industry.pageIndex).toBe(0);
    expect(industry.rows.every((row) => row.category === "industry")).toBe(
      true,
    );

    const concept = await sectorValuation(root, {
      category: "concept",
      sort: "pb",
      descending: true,
      asOf: "2026-11-17",
    });
    expect(concept.category).toBe("concept");
    expect(concept.sort).toBe("pb");
    expect(concept.descending).toBe(true);
    expect(concept.rows.every((row) => row.category === "concept")).toBe(true);
  });
});

const realRoot = process.env.SECTOR_VALUATION_REAL_ROOT;
(realRoot ? describe : describe.skip)("板块估值：真实本地只读样本", () => {
  it("煤炭等四个板块与全行业分类投影", async () => {
    const samples: Record<
      string,
      { pe: number; pb: number; negative?: boolean }
    > = {
      "881001": { pe: 17.9, pb: 1.69 },
      "881006": { pe: 12.53, pb: 1.33 },
      "880594": { pe: 18.03, pb: 1.3 },
      "880911": { pe: -683.91, pb: 1.19, negative: true },
    };
    for (const [code, expected] of Object.entries(samples)) {
      const source = await readLocalFinancialSeries(realRoot!, `sh${code}`);
      expect(source.namespace).toBe("BK");
      const row = summarizeSectorValuation({
        category: "industry",
        classification: "tdx-research",
        code,
        name: code,
        records: source.records,
        asOf: "2026-11-18",
      });
      expect(row.date).toBe("2026-11-17");
      expect(row.pe.value).toBeCloseTo(expected.pe, 2);
      expect(row.pb.value).toBeCloseTo(expected.pb, 2);
      expect(row.pe.y5.complete).toBe(true);
      expect(row.pe.y10.complete).toBe(false);
      if (expected.negative) {
        expect(row.pe.value! < 0).toBe(true);
        expect(row.pe.y5.percentile).toBeNull();
      } else {
        expect(row.pe.y5.percentile).toBeGreaterThanOrEqual(0);
        expect(row.pe.y5.percentile).toBeLessThanOrEqual(100);
      }
    }
    const industry = await sectorValuation(realRoot!, {
      category: "industry",
      asOf: "2026-11-18",
    });
    expect(industry.counts).toEqual({ industry: 467, concept: 269 });
    expect(industry.total).toBe(467);
    const repeated = await sectorValuation(realRoot!, {
      category: "industry",
      asOf: "2026-11-18",
    });
    expect(repeated.cached).toBe(true);
    expect(repeated.total).toBe(467);
  });
});
