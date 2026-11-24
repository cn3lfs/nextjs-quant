import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parseArgs } from "../../../scripts/backtest-diagnose";
import { buildStratifiedCore30 } from "~/server/research/diagnose/universe-strata";
import {
  CORE_12_SYMBOLS,
  CORE_30_V1_PRESET,
  resolveUniversePreset,
} from "~/server/research/diagnose/universe-presets";

const options = {
  seed: "fixture-v1",
  developmentStart: "2016-01-01",
  gp16Date: "2015-12-31",
};
function day(date: number) {
  const b = Buffer.alloc(32);
  b.writeUInt32LE(date);
  for (const offset of [4, 8, 12, 16]) b.writeUInt32LE(1000, offset);
  return b;
}
function record(date: number, cap: number, group = 16) {
  const b = Buffer.alloc(13);
  b[0] = group;
  b.writeUInt32LE(date, 1);
  b.writeFloatLE(cap, 5);
  return b;
}
async function fixture() {
  const root = await mkdtemp(join(process.env.QUANT_DATA_DIR!, "strata-"));
  const cfg = join(root, "T0002", "hq_cache"),
    lday = join(root, "vipdoc", "sh", "lday"),
    cw = join(root, "vipdoc", "cw");
  await Promise.all(
    [cfg, lday, cw].map((dir) => mkdir(dir, { recursive: true })),
  );
  const definitions: string[] = [],
    members: string[] = [];
  for (let i = 0; i < 30; i++) {
    const key = "X" + String(10 + i),
      index = 881001 + i;
    definitions.push(`Sector-${i}|${index}|12|1|0|${key}`);
    for (let j = 0; j < (i === 0 ? 1 : 8); j++) {
      const code = i === 0 ? "600519" : String(601000 + i * 10 + j);
      members.push(`1|${code}|T1001|||${key}01`);
      await writeFile(
        join(lday, "sh" + code + ".day"),
        day(j === 7 ? 20220103 : 20010102),
      );
      const data =
        j === 7
          ? [record(20220103, 90000)]
          : [
              record(20151231, 100000, 15),
              record(20151231, 100 + j),
              record(20160104, 90000 - j),
            ];
      await writeFile(join(cw, "gpsh" + code + ".dat"), Buffer.concat(data));
    }
  }
  await writeFile(join(cfg, "tdxhy.cfg"), members.reverse().join("\r\n"));
  await writeFile(join(cfg, "tdxzs3.cfg"), definitions.reverse().join("\r\n"));
  return { root, cw, cfg, lday };
}

it("rebuilds one stock per industry deterministically from the same dated GP16 records, independent of strategy scores", async () => {
  const { root, cw, cfg } = await fixture();
  const first = await buildStratifiedCore30(root, options);
  expect(first.symbols).toHaveLength(30);
  expect(new Set(first.members.map((m) => m.industryCode)).size).toBe(30);
  // Sector 1 targets mid: seven sorted caps yield ranks 3 and 4 (zero based).
  const expected = ["sh601013", "sh601014"]
    .map((symbol) => ({
      symbol,
      key: createHash("sha256")
        .update("fixture-v1:881002:" + symbol)
        .digest("hex"),
    }))
    .sort((a, b) => a.key.localeCompare(b.key))[0]!;
  expect(first.members[1]).toMatchObject({
    symbol: expected.symbol,
    sizeTier: "mid",
    gp16: {
      date: "2015-12-31",
      recordOffset: 13,
      valueWan: 100 + Number(expected.symbol.at(-1)),
    },
  });
  await writeFile(
    join(root, "strategy-results.json"),
    JSON.stringify({ [expected.symbol]: -999 }),
  );
  const def = join(cfg, "tdxzs3.cfg");
  await writeFile(
    def,
    (await readFile(def, "utf8")).split("\r\n").reverse().join("\n"),
  );
  await writeFile(
    join(cw, "gp" + expected.symbol + ".dat"),
    Buffer.concat([
      record(20151231, 100000, 15),
      record(20151231, 100 + Number(expected.symbol.at(-1))),
      record(20160104, 1),
    ]),
  );
  expect(await buildStratifiedCore30(root, options)).toEqual(first);
  expect(
    (await buildStratifiedCore30(root, { ...options, seed: "other" })).symbols,
  ).not.toEqual(first.symbols);
});

it("keeps late-listed members with unknown size and discloses exact overlap with the frozen core-12", async () => {
  const { root } = await fixture();
  const result = await buildStratifiedCore30(root, options);
  expect(result.members[3]).toMatchObject({
    symbol: "sh601037",
    sizeTier: "unknown",
    firstBarDate: "2022-01-03",
    lateListed: true,
    gp16: { valueWan: null, reason: "missing-on-date" },
  });
  expect(result.lateListedSymbols).toHaveLength(7);
  expect(result.lateListedSymbols).toContain("sh601037");
  expect(result.overlapWithCore12).toEqual({ count: 1, symbols: ["sh600519"] });
  expect(CORE_12_SYMBOLS).toEqual([
    "sh600519",
    "sz000001",
    "sh601318",
    "sz000333",
    "sz300750",
    "sz300308",
    "sh688981",
    "sz300274",
    "sz002594",
    "sh600276",
    "sh601899",
    "sz000858",
  ]);
  expect(resolveUniversePreset("core-30-v1")).toBe(CORE_30_V1_PRESET);
  const cli = parseArgs(["--tdx-root", root, "--pool", "core-30-v1"]);
  expect(cli.symbols).toEqual(CORE_30_V1_PRESET.symbols);
  expect(cli.pool?.members).toHaveLength(30);
  expect(CORE_30_V1_PRESET.symbols).toHaveLength(30);
  expect(result.survivorBiasDisclosure).toMatch(/幸存者偏差.*退市.*历史 ST/);
});

it("rejects a future GP16 snapshot and truncated local records, and discloses duplicate cap observations", async () => {
  const { root, cw, lday } = await fixture();
  await expect(
    buildStratifiedCore30(root, { ...options, gp16Date: "2016-01-04" }),
  ).rejects.toThrow(/GP16 after/);
  await writeFile(
    join(cw, "gpsh600519.dat"),
    Buffer.concat([record(20151231, 1), record(20151231, 2)]),
  );
  expect((await buildStratifiedCore30(root, options)).members[0]).toMatchObject(
    {
      sizeTier: "unknown",
      gp16: { reason: "duplicate-on-date", valueWan: null },
    },
  );
  await writeFile(join(lday, "sh600519.day"), Buffer.alloc(31));
  await expect(buildStratifiedCore30(root, options)).rejects.toThrow(
    /Truncated .day/,
  );
});
