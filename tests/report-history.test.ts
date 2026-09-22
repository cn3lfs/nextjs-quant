import { expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import superjson from "superjson";
import { put, get } from "../src/server/db";
import {
  reportHistory,
  archivedReport,
} from "../src/server/research/report-history";
process.env.QUANT_DATA_DIR = mkdtempSync(
  join(tmpdir(), "quant-report-history-"),
);
it("pages beyond the old 100-report limit without transporting evidence or losing equal-time rows", () => {
  const large = "原始证据🧪".repeat(10000);
  put("snapshot", "source", { symbol: "sh600519", name: "旧名称" });
  for (let i = 0; i < 125; i++)
    put("report", `report-${String(i).padStart(3, "0")}`, {
      id: `report-${String(i).padStart(3, "0")}`,
      createdAt: 1,
      contextId: "source",
      title: large,
      summary: large,
      evidence: [{ text: large }],
      privateExtra: large,
    });
  const before = get("report-124");
  const ids: string[] = [];
  const sizes: number[] = [];
  let page = reportHistory({});
  for (;;) {
    expect(page.total).toBe(125);
    expect(
      Buffer.byteLength(JSON.stringify(superjson.serialize(page))),
    ).toBeLessThan(20000);
    sizes.push(page.items.length);
    for (const item of page.items) {
      expect(Object.keys(item).sort()).toEqual([
        "createdAt",
        "id",
        "securityContext",
        "title",
      ]);
      expect(item.securityContext?.symbol).toBe("sh600519");
      ids.push(item.id);
    }
    if (!page.nextCursor) break;
    page = reportHistory({ cursor: page.nextCursor });
  }
  expect(sizes).toEqual([20, 20, 20, 20, 20, 20, 5]);
  expect(new Set(ids).size).toBe(125);
  const { securityContext, ...detail } = archivedReport("report-124")!;
  expect(detail).toEqual(before);
  expect(securityContext?.symbol).toBe("sh600519");
  expect(get("report-124")).toEqual(before);
  expect(archivedReport("source")).toBeNull();
  expect(archivedReport("missing")).toBeNull();
});
it("continues a saved cursor without duplicate rows when newer reports arrive", () => {
  const first = reportHistory({});
  put("report", "new-report", {
    id: "new-report",
    createdAt: 2,
    title: "新报告",
    contextId: "source",
  });
  const next = reportHistory({ cursor: first.nextCursor! });
  expect(next.items[0]?.id).toBe("report-104");
  expect(
    next.items.some((item) => first.items.some((old) => old.id === item.id)),
  ).toBe(false);
  expect(reportHistory({}).items[0]?.id).toBe("new-report");
});
