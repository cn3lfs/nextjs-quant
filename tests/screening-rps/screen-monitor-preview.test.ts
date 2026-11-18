import { describe, expect, it } from "vitest";
import {
  screenMonitorCaptureMatches,
  screenMonitorContentSignature,
  screenMonitorPreview,
} from "~/lib/screening/screen-monitor-preview";

const candidate = (index: number) => ({
  symbol: `sh${String(600000 + index)}`,
  name: `候选${index}`,
  snapshotId: `snapshot-${index}`,
  metrics: {
    close: 10 + index,
    change: 1,
    fast: 9,
    slow: 8,
    volumeRatio: 1,
    matched: true,
    date: "2026-11-17",
    score: index,
  },
});
const candidates = Array.from({ length: 25 }, (_, index) => candidate(index));

function prefillSymbols(href: string) {
  const raw = new URL(href, "http://localhost").searchParams.get("monitorNew");
  return (JSON.parse(raw!) as { symbols: string[] }).symbols;
}

describe("screen monitor preview", () => {
  it("takes the first 20 rows of the server-sorted page and carries the same order", () => {
    const preview = screenMonitorPreview({
      asOf: "2026-11-17",
      // Filtered server total, which may be smaller than the run's candidateTotal.
      count: 25,
      candidates,
    })!;
    expect(preview.rows).toHaveLength(20);
    expect(preview.rows.map((row) => row.symbol)).toEqual(
      candidates.slice(0, 20).map((row) => row.symbol),
    );
    expect(preview.included).toBe(20);
    expect(preview.overflow).toBe(5);
    expect(preview.pageCount).toBe(25);
    expect(preview.totalCount).toBe(25);
    expect(prefillSymbols(preview.href)).toEqual(
      preview.rows.map((row) => row.symbol),
    );
    expect(preview.name).toBe("选股候选 2026-11-17");
    expect(preview.rows[0]).toEqual({
      symbol: "sh600000",
      name: "候选0",
      date: "2026-11-17",
    });
  });

  it("keeps the filtered total separate from the unfiltered run total", () => {
    const preview = screenMonitorPreview({
      asOf: null,
      count: 7,
      candidates: candidates.slice(0, 3),
    })!;
    expect(preview.totalCount).toBe(7);
    expect(preview.overflow).toBe(0);
  });

  it("has no entry without page candidates", () => {
    expect(
      screenMonitorPreview({ asOf: "2026-11-17", count: 0, candidates: [] }),
    ).toBeNull();
  });

  it("changes the content signature on order, snapshot, asOf or total changes", () => {
    const base = { asOf: "2026-11-17", count: 25, candidates };
    const signature = screenMonitorContentSignature(base);
    expect(screenMonitorContentSignature({ ...base })).toBe(signature);
    expect(
      screenMonitorContentSignature({ ...base, asOf: "2026-11-18" }),
    ).not.toBe(signature);
    expect(screenMonitorContentSignature({ ...base, count: 24 })).not.toBe(
      signature,
    );
    expect(
      screenMonitorContentSignature({
        ...base,
        candidates: [...candidates].reverse(),
      }),
    ).not.toBe(signature);
    expect(
      screenMonitorContentSignature({
        ...base,
        candidates: candidates.map((row, index) =>
          index === 0 ? { ...row, snapshotId: "other" } : row,
        ),
      }),
    ).not.toBe(signature);
  });
});

describe("screen monitor confirmation identity", () => {
  const captured = {
    key: "job-1/0/original/none/url",
    content: "content-1",
    urlKey: "url-1",
  };

  it("accepts only the page captured when the preview opened", () => {
    expect(screenMonitorCaptureMatches(captured, { ...captured })).toBe(true);
    // Same page key, refreshed rows (new snapshot/asOf) must not confirm.
    expect(
      screenMonitorCaptureMatches(captured, {
        ...captured,
        content: "content-2",
      }),
    ).toBe(false);
    // Back/forward or another page/task/query must not inherit the click.
    expect(
      screenMonitorCaptureMatches(captured, { ...captured, key: "job-2/0" }),
    ).toBe(false);
    expect(
      screenMonitorCaptureMatches(captured, { ...captured, urlKey: "url-2" }),
    ).toBe(false);
  });
});
