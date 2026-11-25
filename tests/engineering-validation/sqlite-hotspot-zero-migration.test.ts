import {
  lstat,
  mkdir,
  readFile,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { settingsSchema } from "~/lib/domain";
import type { DiagnoseArchiveDetail } from "~/lib/research/diagnose-contract";
import { settleAlertOutcomes } from "~/server/alerts/outcomes";
import { put, sqlite } from "~/server/db";
import { AlertRepository } from "~/server/db/alert-repository";
import { researchArchiveHistory } from "~/server/db/archive-history";
import { getJobStatus } from "~/server/db/jobs";
import { recentRuntimeErrors } from "~/server/infra/runtime-errors";
import { saveSettings } from "~/server/infra/settings";
import { readBars } from "~/server/market/bar-store/read-bars";
import { recoverRuntimeJobs } from "~/server/runtime";
import * as archiveFs from "~/server/research/diagnose/archive-fs";
import {
  listDiagnoseArchives,
  publishDiagnoseArchive,
  readDiagnoseArchive,
  recoverDiagnoseArchives,
} from "~/server/research/diagnose/archive";

vi.mock("~/server/market/bar-store/read-bars", () => ({
  readBars: vi.fn(async () => ({ bars: [], barStore: { formingDates: [] } })),
}));
afterEach(() => vi.restoreAllMocks());

it("opens the isolated workspace at SQLite user_version 25", () => {
  expect(sqlite().name).toBe(join(process.env.QUANT_DATA_DIR!, "quant.sqlite"));
  expect(sqlite().pragma("user_version", { simple: true })).toBe(25);
});

it("reads job status from v23's existing covering index without decoding the stored result", () => {
  const id = "job-status-lookup";
  put("job", id, { status: "completed", result: "x".repeat(200_000) });
  const db = sqlite();
  const prepare = vi.spyOn(db, "prepare");
  expect(getJobStatus(id)).toBe("completed");
  const query = prepare.mock.calls[0]![0];
  const plan = db.prepare("EXPLAIN QUERY PLAN " + query).all({ id }) as {
    detail: string;
  }[];
  expect(plan.map((row) => row.detail)).toEqual(
    expect.arrayContaining([
      expect.stringContaining("COVERING INDEX job_recent_summary"),
      expect.stringMatching(/SEARCH records USING INDEX .*\(id=\?\)/),
    ]),
  );
  const instructions = db.prepare("EXPLAIN " + query).all({ id }) as {
    p4: unknown;
  }[];
  expect(
    instructions.some((op) => String(op.p4).includes("json_extract")),
  ).toBe(false);
});

const options = {
  archiveDir: join(process.env.QUANT_DATA_DIR!, "diagnose-archives"),
  source: "lab-archive" as const,
};
function archiveDetail(sequence: number): DiagnoseArchiveDetail {
  return {
    summary: {
      id: `lab-job-00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
      source: "lab-archive",
      title: "summary fixture",
      generatedAt: "2026-01-01",
      strategyKeys: [],
      symbols: [],
      scenarios: [],
      statusCounts: { ok: 0, failed: 0, blocked: 0, zeroSignal: 0 },
      missingFiles: [],
      driftWarnings: [],
    },
    cells: [],
    pagination: { page: 1, pageSize: 1, totalCells: 0 },
    boundaryState: "blocked",
  };
}

it("lists from a valid sidecar and preserves readable job archives with missing, corrupt or unsafe optional sidecars", async () => {
  const detail = archiveDetail(1);
  await publishDiagnoseArchive(detail, options);
  expect(getJobStatus(detail.summary.id.slice(4))).toBeUndefined();
  expect(recoverDiagnoseArchives()).toEqual([]);
  const sidecar = join(options.archiveDir, detail.summary.id, "summary.json");
  expect(JSON.parse(await readFile(sidecar, "utf8"))).toMatchObject(
    detail.summary,
  );
  const read = vi.spyOn(archiveFs, "readBounded");
  expect(await listDiagnoseArchives(options)).toEqual([detail.summary]);
  expect(read.mock.calls.map(([path]) => basename(path))).toEqual([
    "summary.json",
  ]);
  const expectFallback = async () => {
    expect(recoverDiagnoseArchives()).toEqual([]);
    read.mockClear();
    expect(await listDiagnoseArchives(options)).toEqual([detail.summary]);
    expect(read.mock.calls.map(([path]) => basename(path))).toContain(
      "diagnose-group.json",
    );
    expect(
      await readDiagnoseArchive(detail.summary.id, { ...options, pageSize: 1 }),
    ).toEqual(detail);
  };
  await unlink(sidecar);
  await expectFallback();
  await writeFile(sidecar, "{");
  await expectFallback();
  await unlink(sidecar);
  await mkdir(sidecar);
  await expectFallback();
});

it("continues startup recovery past a linked archive and quarantines missing, corrupt, staged and non-completed archives", async () => {
  const id = (n: number) => archiveDetail(n).summary.id;
  const linked = id(2),
    missing = id(3),
    corrupt = id(4),
    staged = id(5),
    failed = id(6),
    complete = id(7);
  for (let n = 3; n <= 7; n++)
    await publishDiagnoseArchive(archiveDetail(n), options);
  const path = (id: string) => join(options.archiveDir, id);
  await symlink(path(complete), path(linked), "junction");
  await unlink(join(path(missing), "diagnose-group.json"));
  await writeFile(join(path(corrupt), "diagnose-group.json"), "{");
  await writeFile(join(path(staged), ".pending-part"), "");
  put("job", failed.slice(4), { status: "failed" });
  expect(recoverRuntimeJobs()).toEqual([missing, corrupt, staged, failed]);
  expect(recentRuntimeErrors().entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        event: "runtime-start",
        jobId: linked.slice(4),
      }),
    ]),
  );
  for (const id of [missing, corrupt, staged, failed]) {
    expect((await lstat(path(`.orphan-${id}`))).isDirectory()).toBe(true);
    await expect(lstat(path(id))).rejects.toMatchObject({ code: "ENOENT" });
  }
  expect((await lstat(path(linked))).isSymbolicLink()).toBe(true);
  expect((await readDiagnoseArchive(complete, options))?.summary.id).toBe(
    complete,
  );
  await unlink(path(linked));
});

it("gets hasMore from the extra row and skips COUNT for page-only requests and unchanged workbench pages", () => {
  for (let i = 1; i <= 41; i++)
    put("report", `history-${i}`, { title: "fixture", createdAt: i });
  const prepare = vi.spyOn(sqlite(), "prepare");
  const first = researchArchiveHistory({}, { includeTotal: false });
  expect(first).toMatchObject({ filteredTotal: undefined, hasMore: true });
  expect(first.items).toHaveLength(20);
  expect(prepare.mock.calls.map(([sql]) => sql).join("\n")).not.toMatch(
    /\bcount\s*\(/i,
  );

  const counted = researchArchiveHistory({});
  expect(counted.filteredTotal).toBe(41);
  prepare.mockClear();
  const second = researchArchiveHistory({ cursor: counted.nextCursor! });
  const third = researchArchiveHistory({ cursor: second.nextCursor! });
  expect(second).toMatchObject({ hasMore: true, filteredTotal: 41 });
  expect(third).toMatchObject({
    items: [{ id: "history-1" }],
    hasMore: false,
    filteredTotal: 41,
    nextCursor: null,
  });
  expect(prepare.mock.calls.map(([sql]) => sql).join("\n")).not.toMatch(
    /\bcount\s*\(/i,
  );
});

it("seeks watch_events_bar across ticks, advancing through empty pages and revisiting immature events after wraparound", async () => {
  const db = sqlite();
  const repo = new AlertRepository(db);
  const bar = "2026-01-01";
  saveSettings(
    settingsSchema.parse({
      tdxRoot: join(process.env.QUANT_DATA_DIR!, "fixture-tdx"),
      calendar: Array.from(
        { length: 22 },
        (_, i) => `2026-01-${String(i + 1).padStart(2, "0")}`,
      ),
    }),
  );
  db.prepare(
    "INSERT INTO strategies VALUES ('fixture',1,'cn-equity','{}',0)",
  ).run();
  const insert = db.prepare(
    "INSERT INTO watch_events VALUES(?,'fixture',1,'sh600000',?,?,NULL,?,NULL,?)",
  );
  const expected: string[] = [];
  for (let i = 0; i < 306; i++) {
    const key = `event-${String(i).padStart(4, "0")}`;
    const date = i === 305 ? "2026-01-22" : bar;
    const type = "entry";
    const status = i >= 100 && i < 200 ? "missed" : "shadow";
    insert.run(
      key,
      date,
      type,
      status,
      JSON.stringify({
        key,
        bar: date,
        type,
        observedAt: 1,
        market: "cn-equity",
        symbol: "sh600000",
      }),
    );
    if (status !== "missed" && i !== 5) expected.push(key);
  }
  repo.saveState(
    "outcomes:event-0005",
    [5, 10, 20].map((horizon) => ({ horizon, settled: true })),
  );
  const prepare = vi.spyOn(db, "prepare");
  const settledKeys: string[] = [];
  const tick = async (count: number) => {
    const workerRepo = new AlertRepository(db);
    const observed = vi.spyOn(workerRepo, "outcomes");
    vi.mocked(readBars).mockClear();
    await settleAlertOutcomes(Date.parse("2026-01-22T08:00:00Z"), workerRepo);
    expect(readBars).toHaveBeenCalledTimes(count);
    expect(observed).toHaveBeenCalledTimes(count);
    settledKeys.push(...observed.mock.calls.map(([key]) => key));
  };
  for (const count of [99, 0, 100, 6]) await tick(count);
  expect(settledKeys).toEqual(expected);
  settledKeys.length = 0;
  for (const count of [0, 0, 0, 1]) await tick(count);
  expect(settledKeys).toEqual(["event-0305"]);
  const query = prepare.mock.calls
    .map(([sql]) => sql)
    .find((sql) => sql.includes("AND (bar,dedupe_key)>(?,?)"));
  expect(query).toBeDefined();
  const plan = db
    .prepare("EXPLAIN QUERY PLAN " + query)
    .all("2026-01-22", "event-0305", bar, "event-0099", 100) as {
    detail: string;
  }[];
  expect(plan.map((row) => row.detail).join("\n")).toMatch(
    /SEARCH watch_events USING INDEX watch_events_bar/,
  );
  expect(plan.map((row) => row.detail).join("\n")).not.toContain("TEMP B-TREE");
});
