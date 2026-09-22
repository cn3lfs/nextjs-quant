import { beforeEach, expect, it, vi } from "vitest";
const records = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../src/server/db", () => ({
  get: (id: string) => records.get(id),
  put: vi.fn(),
}));
import { fullRsSnapshot } from "../src/server/data-sources/hithink/hithink-rs";
import { exportRsArchive } from "../src/server/research/rs-export";
let archive: ReturnType<typeof fullRsSnapshot>;
beforeEach(() => {
  records.clear();
  const key = "涨跌幅[20260616-20260908]";
  archive = fullRsSnapshot({
    status_code: 0,
    code_count: 2,
    columns: [
      {
        key,
        unit: "%",
        timestamp: "20260616-20260908",
        sort_info: "desc",
        type: "DOUBLE",
      },
    ],
    datas: [
      { 股票代码: "600519.SH", [key]: 20 },
      { 股票代码: "000001.SZ", [key]: 10 },
    ],
  });
  records.set(archive.id, { ...archive, capturedAt: 1000 });
  records.set("report", {
    evidence: [
      {
        id: "evidence",
        envelope: { source: "hithink-astock-selector/rs" },
        text: JSON.stringify({
          snapshotId: archive.id,
          snapshotHash: archive.hash,
        }),
      },
    ],
  });
});
it("exports all original rows with verified fingerprints and capture time", () => {
  const exported = exportRsArchive("report", "evidence");
  expect(exported).toMatchObject({
    format: "quant-rs-source-export-1",
    capturedAt: 1000,
    count: 2,
    hash: archive.hash,
  });
  expect(exported.source.datas).toHaveLength(2);
  records.set(archive.id, archive);
  expect(exportRsArchive("report", "evidence").capturedAt).toBeNull();
});
it("refuses unrelated evidence and missing or altered source archives", () => {
  expect(() => exportRsArchive("report", "other")).toThrow();
  const changed = structuredClone(archive);
  changed.source.datas[0]!["股票代码"] = "600000.SH";
  records.set(archive.id, changed);
  expect(() => exportRsArchive("report", "evidence")).toThrow("指纹");
  records.delete(archive.id);
  expect(() => exportRsArchive("report", "evidence")).toThrow("缺失");
});
