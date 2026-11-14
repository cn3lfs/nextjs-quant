import { beforeEach, expect, it } from "vitest";
import { put, sqlite } from "../../src/server/db";
import { researchArchiveHistory } from "../../src/server/db/archive-history";
import {
  archiveHistoryInput,
  archiveKinds,
  type ArchiveCursor,
} from "../../src/lib/research/workflow/archive-history";

beforeEach(() => {
  sqlite().prepare("DELETE FROM records").run();
});
function seed(kind: string, i: number, extra: Record<string, unknown> = {}) {
  const id = `${kind}-${i.toString(16).padStart(64, "0")}`;
  put(kind, id, {
    id,
    createdAt: 1,
    contextId: "source",
    title: "中文 %_ '标题",
    result: { title: "中文 %_ '标题" },
    evidence: { symbol: "sh600519", text: "PRIVATE_BODY".repeat(1000) },
    dossier: { symbol: "sh600519" },
    frames: { symbol: "sh600519" },
    ...extra,
  });
  return id;
}
it("reaches every report beyond the old 100 limit with stable equal-time ordering", () => {
  put("snapshot", "source", { symbol: "sh600519", name: "归档名" });
  for (const kind of archiveKinds) for (let i = 0; i < 500; i++) seed(kind, i);
  let cursor: ArchiveCursor | undefined;
  const ids: string[] = [];
  do {
    const page = researchArchiveHistory({ cursor });
    expect(page.filteredTotal).toBe(500);
    expect(page.items.length).toBeLessThanOrEqual(20);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(32768);
    expect(JSON.stringify(page)).not.toContain("PRIVATE_BODY");
    ids.push(...page.items.map((x) => x.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(ids).toHaveLength(500);
  expect(new Set(ids).size).toBe(500);
  expect(ids).toEqual([...ids].sort().reverse());
});
it("filters before pagination, treats wildcard characters literally and validates filter-bound cursors", () => {
  for (let i = 0; i < 45; i++) seed("report", i);
  seed("report", 50, { title: "other" });
  expect(researchArchiveHistory({ keyword: "%_" }).filteredTotal).toBe(45);
  expect(researchArchiveHistory({ keyword: "%x" }).filteredTotal).toBe(0);
  expect(researchArchiveHistory({ symbol: "sz000001" }).filteredTotal).toBe(0);
  const page = researchArchiveHistory({ kinds: ["report"] });
  expect(() =>
    researchArchiveHistory({ cursor: page.nextCursor!, keyword: "other" }),
  ).toThrow("筛选条件");
  expect(
    researchArchiveHistory({
      kinds: ["report"],
      cursor: page.nextCursor!,
    }).items,
  ).toHaveLength(20);
});
it("retains cursor boundary when newer records arrive and counts all matching records", () => {
  for (let i = 0; i < 30; i++) seed("report", i);
  const page = researchArchiveHistory({});
  seed("report", 100, { createdAt: 2 });
  const next = researchArchiveHistory({ cursor: page.nextCursor! });
  expect(next.filteredTotal).toBe(31);
  expect(next.items).toHaveLength(10);
  expect(next.items.every((x) => !page.items.some((y) => y.id === x.id))).toBe(
    true,
  );
});
it("uses Beijing generation dates and keeps unknown dates explicit and outside date filters", () => {
  seed("report", 1, { createdAt: Date.parse("2026-09-27T16:00:00Z") });
  seed("report", 2, { createdAt: Date.parse("2026-09-28T16:00:00Z") });
  seed("report", 3, { createdAt: null });
  seed("report", 4, { createdAt: "invalid" });
  const filtered = researchArchiveHistory({
    from: "2026-09-28",
    to: "2026-09-28",
  });
  expect(filtered.items.map((x) => x.id)).toEqual([
    `report-${"1".padStart(64, "0")}`,
  ]);
  expect(
    researchArchiveHistory({ to: "2026-09-28" }).items.map((x) => x.id),
  ).toEqual(filtered.items.map((x) => x.id));
  expect(
    researchArchiveHistory({ from: "1900-01-01", to: "2026-09-28" }).items.map(
      (x) => x.id,
    ),
  ).toEqual(filtered.items.map((x) => x.id));
  expect(
    researchArchiveHistory({})
      .items.slice(-2)
      .map((x) => x.createdAt),
  ).toEqual([null, null]);
  expect(archiveHistoryInput.safeParse({ from: "2026-02-30" }).success).toBe(
    false,
  );
  expect(
    archiveHistoryInput.safeParse({ from: "2026-09-29", to: "2026-09-28" })
      .success,
  ).toBe(false);
});
it("does not infer security from report prose or conflicting contexts, keeps incomplete metadata visible", () => {
  put("snapshot", "source", { symbol: "sh600519", name: "归档名" });
  const id = seed("report", 1);
  expect(researchArchiveHistory({}).items[0]?.securityContext).toEqual({
    symbol: "sh600519",
    archivedName: "归档名",
  });
  put("signal", "source", { symbol: "sz000001", snapshotId: "snapshot" });
  put("snapshot", "snapshot", { symbol: "sh600519", name: "wrong" });
  expect(researchArchiveHistory({}).items[0]?.securityContext).toBeNull();
  put("report", id, { createdAt: 1, title: 42, contextId: "absent" });
  const page = researchArchiveHistory({});
  expect(page.filteredTotal).toBe(1);
  expect(page.items[0]?.readable).toBe(false);
  expect(page.items[0]?.title).toBe("报告元数据不完整");
});

it("excludes retired reports and rejects their filters without deleting stored data", () => {
  const retired = [
    "chan-report",
    "canslim-report",
    "wyckoff-report",
    "fundamental-report",
  ];
  for (const kind of retired) {
    seed(kind, 1);
    expect(archiveHistoryInput.safeParse({ kinds: [kind] }).success).toBe(
      false,
    );
  }
  const id = seed("report", 1);
  expect(researchArchiveHistory({}).items.map((row) => row.id)).toEqual([id]);
  expect(sqlite().prepare("SELECT count(*) n FROM records").get()).toEqual({
    n: 5,
  });
});
