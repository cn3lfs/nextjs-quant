import { beforeEach, expect, it } from "vitest";
import { put, sqlite } from "../../src/server/db";
import { researchArchiveHistory } from "../../src/server/research/archive-history";
import {
  archiveHistoryInput,
  archiveKinds,
  type ArchiveCursor,
} from "../../src/lib/research/workflow/archive-history";
import { researchHistory } from "../../src/server/research/research-history";

beforeEach(() => {
  sqlite().prepare("DELETE FROM records").run();
});
function seed(
  kind: (typeof archiveKinds)[number],
  i: number,
  extra: Record<string, unknown> = {},
) {
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
it("reaches every report across four kinds beyond the old 100 limit with stable equal-time ordering", () => {
  put("snapshot", "source", { symbol: "sh600519", name: "归档名" });
  for (const kind of archiveKinds) for (let i = 0; i < 125; i++) seed(kind, i);
  expect(researchHistory("chan-report")).toHaveLength(100); // observed pre-change negative control
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
  for (let i = 0; i < 45; i++) seed("chan-report", i);
  seed("wyckoff-report", 50, { result: { title: "other" } });
  expect(researchArchiveHistory({ keyword: "%_" }).filteredTotal).toBe(45);
  expect(researchArchiveHistory({ keyword: "%x" }).filteredTotal).toBe(0);
  expect(researchArchiveHistory({ symbol: "sz000001" }).filteredTotal).toBe(0);
  const page = researchArchiveHistory({ kinds: ["chan-report"] });
  expect(() =>
    researchArchiveHistory({ cursor: page.nextCursor!, keyword: "other" }),
  ).toThrow("筛选条件");
  expect(
    researchArchiveHistory({
      kinds: ["chan-report", "chan-report"],
      cursor: page.nextCursor!,
    }).items,
  ).toHaveLength(20);
});
it("retains cursor boundary when newer records arrive and counts all matching records", () => {
  for (let i = 0; i < 30; i++) seed("chan-report", i);
  const page = researchArchiveHistory({});
  seed("chan-report", 100, { createdAt: 2 });
  const next = researchArchiveHistory({ cursor: page.nextCursor! });
  expect(next.filteredTotal).toBe(31);
  expect(next.items).toHaveLength(10);
  expect(next.items.every((x) => !page.items.some((y) => y.id === x.id))).toBe(
    true,
  );
});
it("uses Beijing generation dates and keeps unknown dates explicit and outside date filters", () => {
  seed("chan-report", 1, { createdAt: Date.parse("2026-09-27T16:00:00Z") });
  seed("chan-report", 2, { createdAt: Date.parse("2026-09-28T16:00:00Z") });
  seed("chan-report", 3, { createdAt: null });
  seed("chan-report", 4, { createdAt: "invalid" });
  const filtered = researchArchiveHistory({
    from: "2026-09-28",
    to: "2026-09-28",
  });
  expect(filtered.items.map((x) => x.id)).toEqual([
    `chan-report-${"1".padStart(64, "0")}`,
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
