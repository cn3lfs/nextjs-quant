import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  local: vi.fn(),
  cache: vi.fn(),
  repair: vi.fn(),
}));
vi.mock("../../../src/server/data-sources/tdx/tdx", () => ({
  readSnapshot: mocks.local,
}));
vi.mock("../../../src/server/data-sources/tdx/tdx-full-day-cache", () => ({
  readFullDaySnapshot: mocks.cache,
  fullDayRepairsSameDate: mocks.repair,
}));
import { readLocalDailySnapshot } from "../../../src/server/market/local-daily-snapshot";
beforeEach(() => vi.resetAllMocks());
it("requires explicit same-date repair and returns to local when its date advances", async () => {
  const local = {
    source: "tdx-local",
    bars: [{ date: "2026-09-11", close: 10 }],
  };
  mocks.local.mockResolvedValue(local);
  mocks.cache.mockReturnValue({
    source: "tdx-full-package",
    bars: [{ date: "2026-09-11", close: 11 }],
  });
  expect(await readLocalDailySnapshot("root", "sh600000")).toBe(local);
  mocks.repair.mockReturnValue(true);
  expect(
    (await readLocalDailySnapshot("root", "sh600000")).bars[0]?.close,
  ).toBe(11);
  local.bars[0]!.date = "2026-09-14";
  expect(await readLocalDailySnapshot("root", "sh600000")).toBe(local);
});
it("uses an imported history when the local file is missing, retaining its provenance", async () => {
  mocks.local.mockRejectedValue(new Error("missing"));
  mocks.cache.mockReturnValue({
    source: "tdx-full-package",
    bars: [{ date: "2026-09-11" }],
    hash: "imported",
    sourceVersions: ["version"],
  });
  expect(await readLocalDailySnapshot("root", "sh600000")).toMatchObject({
    source: "tdx-full-package",
    hash: "imported",
    sourceVersions: ["version"],
  });
});
it("does not replace newer local data with an older full package", async () => {
  const local = { source: "tdx-local", bars: [{ date: "2026-09-11" }] };
  mocks.local.mockResolvedValue(local);
  mocks.cache.mockReturnValue({
    source: "tdx-full-package",
    bars: [{ date: "2026-09-10" }],
  });
  expect(await readLocalDailySnapshot("root", "sh600000")).toBe(local);
  mocks.cache.mockReturnValue({
    source: "tdx-full-package",
    bars: [{ date: "2026-09-14" }],
  });
  expect((await readLocalDailySnapshot("root", "sh600000")).source).toBe(
    "tdx-full-package",
  );
});
