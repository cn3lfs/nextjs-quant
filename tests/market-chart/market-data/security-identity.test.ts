// Legacy adapter behavior remains testable behind a mocked restoration boundary.
import { expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const mocks = vi.hoisted(() => ({ tencent: vi.fn(), tdx: vi.fn() }));
vi.mock(
  "../../../src/server/data-sources/tencent/tencent-identity",
  async (original) => ({
    ...(await original<
      typeof import("../../../src/server/data-sources/tencent/tencent-identity")
    >()),
    searchTencentIdentity: mocks.tencent,
  }),
);
vi.mock("../../../src/server/data-sources/tdx/tdx-mcp-disabled", () => ({
  mcpConfigured: async () => true,
  queryMcp: mocks.tdx,
}));
import { parseTencentIdentity } from "../../../src/server/data-sources/tencent/tencent-identity";
import {
  checkTdxIdentity,
  verifySecurityIdentity,
} from "../../../src/server/market/security-identity";
import {
  securityDirectory,
  storedSecurityName,
  mergeVerifiedSecurityName,
  securityProfile,
} from "../../../src/server/market/securities";
import { put, get } from "../../../src/server/db/index";
process.env.QUANT_DATA_DIR = mkdtempSync(join(tmpdir(), "quant-identity-"));
async function root(name: string) {
  const dir = await mkdtemp(join(tmpdir(), "quant-master-"));
  await mkdir(join(dir, "T0002", "hq_cache"), { recursive: true });
  const bytes = Buffer.alloc(410);
  bytes.write("603056", 50);
  bytes.write(name, 81);
  await writeFile(join(dir, "T0002", "hq_cache", "shs.tnf"), bytes);
  return dir;
}
it("Tencent stock identity requires exact code, market and A-stock type", () => {
  const table =
    "| code | name | type |\n| --- | --- | --- |\n| sh603056 | 德邦股份 | GP-A |";
  expect(parseTencentIdentity(table, "sh603056").name).toBe("德邦股份");
  expect(() => parseTencentIdentity(table, "sz603056")).toThrow();
  expect(() =>
    parseTencentIdentity(table.replace("GP-A", "ETF"), "sh603056"),
  ).toThrow();
  expect(() =>
    parseTencentIdentity("unrecognized output", "sh603056"),
  ).toThrow();
});
it("TDX's observed wrong market is a conflict, not an accepted match", () => {
  const record = {
    code: "603056",
    name: "德邦股份",
    type: "A股代码",
    setcode: 0,
  };
  expect(checkTdxIdentity({ data: [record] }, "sh603056").status).toBe(
    "conflict",
  );
  expect(
    checkTdxIdentity({ data: [{ ...record, setcode: 1 }] }, "sh603056").status,
  ).toBe("confirmed");
  expect(checkTdxIdentity({ data: [record, record] }, "sh603056").status).toBe(
    "unavailable",
  );
});
it("concurrent directory refreshes stay rooted and old work cannot overwrite new settings", async () => {
  const a = await root("Root A"),
    b = await root("Root B");
  put("settings", "settings", { tdxRoot: a });
  const first = securityDirectory();
  put("settings", "settings", { tdxRoot: b });
  const second = securityDirectory();
  const [left, right] = await Promise.all([first, second]);
  expect(left.root).toBe(a);
  expect(right.root).toBe(b);
  expect(left.entries.sh603056?.name).toBe("Root A");
  expect(right.entries.sh603056?.name).toBe("Root B");
  expect(get<{ root: string }>("security-directory")?.root).toBe(b);
  await mergeVerifiedSecurityName("sh603056", "Remote name");
  expect(storedSecurityName("sh603056")).toBe("Root B");
  expect((await securityDirectory()).entries.sh603056?.aliases).toContain(
    "Remote name",
  );
  const profile = await securityProfile("sh603056");
  expect(profile.root).toBe(b);
  expect(profile.profile).toMatchObject({
    name: "Root B",
    nameSource: "tdx-tnf",
    aliases: ["Remote name"],
    tradingStatus: "unknown",
  });
  expect(Object.keys(profile).sort()).toEqual([
    "lifecycle",
    "profile",
    "root",
    "tradingStatus",
  ]);
  expect((await securityProfile("sh600099")).profile).toBeNull();
  put("settings", "settings", { tdxRoot: a });
  expect(storedSecurityName("sh603056")).toBeUndefined();
  expect((await securityProfile("sh603056")).profile?.name).toBe("Root A");
});
it("conflicting remote identity is cached but never inserted into the master", async () => {
  const dir = await root("Local");
  put("settings", "settings", { tdxRoot: dir });
  mocks.tencent.mockResolvedValue({
    symbol: "sh600099",
    name: "Remote",
    type: "A股",
    market: "sh",
    source: "tencent",
    sourceHash: "test",
    checkedAt: 1,
  });
  mocks.tdx.mockResolvedValue({
    data: [{ code: "600099", name: "Remote", type: "A股代码", setcode: 0 }],
  });
  const first = await verifySecurityIdentity("sh600099");
  expect(first.status).toBe("conflict");
  expect((await securityDirectory()).entries.sh600099).toBeUndefined();
  expect((await verifySecurityIdentity("sh600099")).checkedAt).toBe(
    first.checkedAt,
  );
  expect(mocks.tencent).toHaveBeenCalledTimes(1);
});
it("confirmed names populate missing master entries and cached identity applies after changing roots", async () => {
  mocks.tencent.mockReset();
  mocks.tdx.mockReset();
  mocks.tencent.mockResolvedValue({
    symbol: "sh600088",
    name: "Verified",
    type: "A股",
    market: "sh",
    source: "tencent",
    sourceHash: "test",
    checkedAt: 1,
  });
  mocks.tdx.mockResolvedValue({
    data: [{ code: "600088", name: "Verified", type: "A股代码", setcode: 1 }],
  });
  put("settings", "settings", { tdxRoot: await root("First") });
  expect((await verifySecurityIdentity("sh600088")).status).toBe("confirmed");
  expect((await securityDirectory()).entries.sh600088).toMatchObject({
    name: "Verified",
    nameSource: "tencent",
    tradingStatus: "unknown",
  });
  put("settings", "settings", { tdxRoot: await root("Second") });
  await verifySecurityIdentity("sh600088");
  expect(storedSecurityName("sh600088")).toBe("Verified");
  expect(mocks.tencent).toHaveBeenCalledTimes(1);
});

it("accepts observed westock ChiNext identity only for matching ChiNext codes", () => {
  const table =
    "| code | name | type |\n| --- | --- | --- |\n| sz300750 | 宁德时代 | GP-A-CYB |";
  expect(parseTencentIdentity(table, "sz300750").name).toBe("宁德时代");
  expect(() =>
    parseTencentIdentity(table.replace("sz300750", "sh600000"), "sh600000"),
  ).toThrow();
  expect(() =>
    parseTencentIdentity(table.replace("GP-A-CYB", "ETF"), "sz300750"),
  ).toThrow();
});

it.each([
  ["sh600000", "浦发银行", "GP-A"],
  ["sz000001", "平安银行", "GP-A"],
  ["sz300750", "宁德时代", "GP-A-CYB"],
  ["sh688981", "中芯国际", "GP-A-KCB"],
  ["bj920002", "万达轴承", "GP"],
])(
  "parses captured westock identity for %s with market-specific types",
  (symbol, name, type) => {
    const table = `| code | name | type |\n| --- | --- | --- |\n| ${symbol} | ${name} | ${type} |`;
    expect(parseTencentIdentity(table, symbol).name).toBe(name);
    expect(() =>
      parseTencentIdentity(table.replace(type, "ETF"), symbol),
    ).toThrow();
    expect(() =>
      parseTencentIdentity(table + `\n| ${symbol} | 重复 | ${type} |`, symbol),
    ).toThrow();
  },
);
it("does not classify generic GP or STAR types as Shanghai main-board A stock", () => {
  for (const type of ["GP", "GP-A-KCB"])
    expect(() =>
      parseTencentIdentity(
        `| code | name | type |\n| --- | --- | --- |\n| sh600000 | 浦发银行 | ${type} |`,
        "sh600000",
      ),
    ).toThrow();
});
