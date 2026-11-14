import { beforeEach, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { settingsSchema } from "~/lib/domain";
import {
  financialDirectory,
  listFinancialReports,
  readGbbq,
  readInfoharborNames,
  readLocalClientFile,
  readLocalTradingDates,
  readSnapshot,
  readTailSnapshot,
  readTdxCodeChanges,
  readTdxLocalBlocks,
  resolveTdxRoot,
  scan,
  securityNames,
} from "tstdx/local";
import { financialDirectoryPrerequisite } from "~/server/data-sources/tdx/financial-prerequisite";

const io = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("Unexpected filesystem access");
  }),
);
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  stat: io,
  lstat: io,
  readdir: io,
  readFile: io,
  open: io,
}));
beforeEach(() => {
  io.mockClear();
});

it("defaults to an unconfigured source and preserves explicitly saved paths", () => {
  expect(settingsSchema.parse({}).tdxRoot).toBe("");
  expect(settingsSchema.parse({ tdxRoot: "  " }).tdxRoot).toBe("");
  const root = resolve("existing source");
  expect(settingsSchema.parse({ tdxRoot: root }).tdxRoot).toBe(root);
  for (const invalid of ["tdx", "./tdx", "C:tdx", "C:/bad\0path", "\\tdx"])
    expect(settingsSchema.safeParse({ tdxRoot: invalid }).success).toBe(false);
  expect(resolveTdxRoot(root)).toBe(root);
});

it.each(["", "  ", "relative/tdx", "C:tdx", "C:/bad\0path", "\\tdx"])(
  "rejects %j before any local source read",
  async (root) => {
    const code = root.trim() ? "TDX_ROOT_INVALID" : "TDX_ROOT_REQUIRED";
    expect(() => financialDirectory(root)).toThrow();
    const reads = [
      () => scan(root),
      () => readSnapshot(root, "sh600000", "day"),
      () => readTailSnapshot(root, "sh600000", "day", 2),
      () => readLocalTradingDates(root),
      () => readGbbq(root),
      () => readTdxLocalBlocks(root),
      () => listFinancialReports(root),
      () => readLocalClientFile(root, "T0002/hq_cache/shs.tnf"),
    ];
    for (const read of reads)
      await expect(read()).rejects.toMatchObject({ code });
    expect(io).not.toHaveBeenCalled();
  },
);

it("keeps optional cold-start metadata unavailable without reading the working directory", async () => {
  expect(await securityNames("", "sh")).toEqual(new Map());
  expect(await readInfoharborNames("")).toMatchObject({
    status: "unavailable",
  });
  expect(await readTdxCodeChanges("")).toMatchObject({ status: "unavailable" });
  expect(io).not.toHaveBeenCalled();
});

it("distinguishes unconfigured financial data from errors and missing report directories", () => {
  let missing: unknown;
  try {
    financialDirectory("");
  } catch (error) {
    missing = error;
  }
  expect(financialDirectoryPrerequisite(missing, "")).toMatchObject({
    code: "tdx-root-missing",
  });
  expect(financialDirectoryPrerequisite({ code: "EACCES" }, "")).toBeNull();
  expect(
    financialDirectoryPrerequisite({ code: "TDX_ROOT_INVALID" }, "relative"),
  ).toBeNull();
});
