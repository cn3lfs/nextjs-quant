import { expect, it } from "vitest";
import { readFile, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTdxCodeChanges } from "../src/server/data-sources/tdx/tdx-code-changes";
import { securityDirectory } from "../src/server/market/securities";
import { put } from "../src/server/db";

it("decodes fixed old-code evidence without inferring target trading status", async () => {
  expect(
    parseTdxCodeChanges(await readFile("tests/fixtures/tdx-code-changes.bin")),
  ).toEqual({
    bj832000: {
      name: "安徽凤凰",
      targetCode: "920000",
      recordedDate: "2025-10-09",
      note: "已切换",
    },
    bj873843: {
      name: "万达轴承",
      targetCode: "920002",
      recordedDate: "2024-10-10",
      note: "已转板",
    },
  });
});
it("rejects truncated exports, wrong markets and impossible dates", async () => {
  const bytes = await readFile("tests/fixtures/tdx-code-changes.bin");
  expect(() => parseTdxCodeChanges(bytes.subarray(0, 30))).toThrow();
  const badDate = Buffer.from(bytes);
  badDate.write("20260230", badDate.indexOf(Buffer.from("20251009")));
  expect(() => parseTdxCodeChanges(badDate)).toThrow("日期非法");
  const badMarket = Buffer.from(bytes);
  badMarket.write("00", badMarket.indexOf(Buffer.from("44|")));
  expect(() => parseTdxCodeChanges(badMarket)).toThrow("格式非法");
});
it("names observed old files while leaving the current pool and target history untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "tdx-code-change-"));
  await mkdir(join(root, "T0002", "hq_cache"), { recursive: true });
  await writeFile(
    join(root, "T0002", "hq_cache", "addedcode_bj.cfg"),
    await readFile("tests/fixtures/tdx-code-changes.bin"),
  );
  put("settings", "settings", { tdxRoot: root });
  put("coverage", "coverage", { root, securities: [{ symbol: "bj832000" }] });
  const directory = await securityDirectory();
  expect(directory.entries.bj832000).toMatchObject({
    name: "安徽凤凰",
    nameSource: "tdx-code-map",
    tradingStatus: "unknown",
    codeChange: { targetCode: "920000" },
  });
  expect(directory.entries.bj920000).toBeUndefined();
  expect(directory.entries.bj873843).toBeUndefined();
  expect(directory.currentSymbols).toEqual([]);
  expect(directory.missingNames).toEqual([]);
});
