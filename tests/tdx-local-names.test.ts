import { expect, it } from "vitest";
import { readFile, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseInfoharborNames,
  readInfoharborNames,
} from "../src/server/tdx-local-names";
import { securityDirectory } from "../src/server/securities";
import { put } from "../src/server/db";

it("decodes the fixed GB18030 fixture and never maps an ETF into an A-share identity", async () => {
  const result = parseInfoharborNames(
    await readFile("tests/fixtures/tdx-infoharbor-names.bin"),
  );
  expect(result).toEqual({
    rows: 4,
    ignored: 1,
    names: {
      sz000001: "平安银行",
      sh600519: "贵州茅台",
      bj920001: "样本证券",
    },
  });
});
it("rejects conflicting codes, malformed rows and invalid byte sequences", () => {
  for (const bytes of [
    Buffer.alloc(0),
    Buffer.from([0x81]),
    Buffer.from("600519|A\n600519|B"),
    Buffer.from("600519|\n"),
    Buffer.from("../../|Name"),
  ]) {
    expect(() => parseInfoharborNames(bytes)).toThrow();
  }
});
it("supplements missing names, exposes conflicts, and preserves historical names and the current TNF membership", async () => {
  const root = await mkdtemp(join(tmpdir(), "tdx-names-"));
  const directory = join(root, "T0002", "hq_cache");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "infoharbor_ex.code"),
    await readFile("tests/fixtures/tdx-infoharbor-names.bin"),
  );
  const tnf = Buffer.alloc(410);
  tnf.write("600519", 50);
  tnf.write("TNF name", 81);
  await writeFile(join(directory, "shs.tnf"), tnf);
  put("settings", "settings", { tdxRoot: root });
  put("coverage", "coverage", {
    root,
    securities: [{ symbol: "sh600001" }, { symbol: "sh600099" }],
  });
  const result = await securityDirectory();
  expect(result.entries.sz000001).toMatchObject({
    name: "平安银行",
    nameSource: "tdx-infoharbor",
    tradingStatus: "unknown",
  });
  expect(result.entries.sh600519).toMatchObject({
    name: "TNF name",
    nameSource: "tdx-tnf",
    nameConflicts: [{ source: "tdx-infoharbor", name: "贵州茅台" }],
  });
  expect(result.currentSymbols).toEqual(["sh600519"]);
  expect(result.entries.sh600001?.nameSource).toBe("exchange");
  expect(result.missingNames).toEqual(["sh600099"]);
  expect(result.supplement?.status).toBe("available");
});
it("an absent or broken supplement is reported without removing existing names", async () => {
  const root = await mkdtemp(join(tmpdir(), "tdx-names-missing-"));
  expect((await readInfoharborNames(root)).status).toBe("unavailable");
  await mkdir(join(root, "T0002", "hq_cache"), { recursive: true });
  await writeFile(
    join(root, "T0002", "hq_cache", "infoharbor_ex.code"),
    Buffer.from([0x81]),
  );
  put("settings", "settings", { tdxRoot: root });
  put("security-directory", "security-directory", {
    root,
    hash: "old",
    entries: {
      sh600519: {
        symbol: "sh600519",
        name: "Old verified",
        aliases: [],
        market: "sh",
        type: "A股",
        currency: "CNY",
        nameSource: "tdx-infoharbor",
        tradingStatus: "unknown",
        updatedAt: 1,
      },
    },
  });
  const result = await securityDirectory();
  expect(result.entries.sh600519?.name).toBe("Old verified");
  expect(result.supplement?.status).toBe("unavailable");
});
