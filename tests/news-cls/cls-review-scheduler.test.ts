import { afterEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  enabled: true,
  put: vi.fn(),
  files: vi.fn(),
  preview: vi.fn(),
  fix: vi.fn(),
  verify: vi.fn(),
  sample: vi.fn(),
  archive: vi.fn(),
  rows: [] as { payload: string }[],
  latest: vi.fn(),
}));
vi.mock("../../src/server/db/index", () => ({
  get: () => ({ enabled: state.enabled, directory: "fixture" }),
  put: state.put,
  sqlite: () => ({}),
}));
vi.mock("../../src/server/news/cls-report-files", () => ({
  clsReportFiles: state.files,
  previewClsReport: state.preview,
}));
vi.mock("../../src/server/news/cls-review-service", () => ({
  fixClsSample: state.fix,
}));
vi.mock("../../src/server/news/cls-verification", () => ({
  verifyClsSample: state.verify,
}));
vi.mock("../../src/server/news/cls-review-store", () => ({
  ClsReviewStore: class {
    sample = state.sample;
    import = state.archive;
    verifications = state.latest;
    db = { prepare: () => ({ all: () => state.rows }) };
  },
}));
import { runClsReviewTick } from "../../src/server/news/cls-review-scheduler";
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  state.rows = [];
  state.enabled = true;
});

it("continues past an invalid old report, selects today's completed morning report and skips a fixed sample", async () => {
  const now = Date.parse("2026-09-11T09:00:00+08:00");
  vi.spyOn(Date, "now").mockReturnValue(now);
  state.sample.mockReturnValue(null);
  state.files.mockResolvedValue([
    { name: "bad", path: "bad" },
    { name: "new", path: "new" },
  ]);
  state.preview.mockImplementation(async (path: string) => {
    if (path === "bad") throw new Error("invalid");
    return {
      sourcePath: path,
      modifiedAt: now - 120000,
      batch: { phase: "morning", completedAt: now - 1000 },
      report: { reportDate: "2026-09-11", hash: "hash" },
    };
  });
  state.archive.mockReturnValue({ id: "report" });
  state.fix.mockResolvedValue({ selected: { symbol: "sh600000" } });
  await runClsReviewTick();
  expect(state.fix).toHaveBeenCalledWith("report");
  expect(state.put.mock.calls.at(-1)?.[2]).toMatchObject({
    status: "fixed",
    message: expect.stringContaining("1项失败"),
  });
  state.sample.mockReturnValue({ date: "2026-09-11" });
  await runClsReviewTick();
  expect(state.fix).toHaveBeenCalledTimes(1);
});

it("never backfills a late sample and isolates close verification failures", async () => {
  vi.spyOn(Date, "now").mockReturnValue(
    Date.parse("2026-09-11T15:10:00+08:00"),
  );
  state.sample.mockReturnValue(null);
  state.rows = [
    { payload: '{"date":"2026-09-09"}' },
    { payload: '{"date":"2026-09-10"}' },
  ];
  state.latest.mockReturnValue([]);
  state.verify.mockImplementation(async (date: string) => {
    if (date === "2026-09-09") throw new Error("missing");
  });
  await runClsReviewTick();
  expect(state.fix).not.toHaveBeenCalled();
  expect(state.verify).toHaveBeenCalledTimes(2);
  expect(state.put.mock.calls.at(-1)?.[2].message).toContain("已核对1个样本");
  state.enabled = false;
  await runClsReviewTick();
  expect(state.verify).toHaveBeenCalledTimes(2);
});
