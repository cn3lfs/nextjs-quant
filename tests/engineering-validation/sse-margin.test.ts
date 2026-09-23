import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import probe from "../fixtures/sse-margin-20260908.json";
import * as sse from "~/server/data-sources/sse/sse-margin";
import {
  mergeSseMargin,
  updateTmtMargin,
} from "~/server/strategies/sentiment/tmt-margin-update";
import {
  tmtCrowding,
  type TmtInput,
} from "~/server/strategies/sentiment/tmt-crowding";
import { get, put, sqlite } from "~/server/db";
const now = Date.parse("2026-09-09T12:00:00+08:00");
process.env.QUANT_DATA_DIR = mkdtempSync(join(tmpdir(), "quant-sse-test-"));
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  sqlite().prepare("DELETE FROM records").run();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const archive = () =>
  sse.parseSseMargin([probe.raw], "20260901", "20260908", now);
it("replays source summary using named fields, verifies duplicates and produces ascending dates", () => {
  const data = archive(),
    rows = sse.sseMarginRows(data);
  expect(rows).toHaveLength(6);
  expect(rows[0]).toEqual({ date: "2026-09-01", balance: 1346761287237 });
  expect(rows.at(-1)).toEqual({ date: "2026-09-08", balance: 1339945793683 });
  expect(
    sse.parseSseMargin(data.pages, data.start, data.end, data.fetchedAt),
  ).toEqual(data);
});
it("rejects wrong scope, identity, ranges, duplicate dates, inconsistent totals and source errors", () => {
  for (const mutate of [
    (p: typeof probe.raw) => {
      p.tabType = "mxtype";
    },
    (p: typeof probe.raw) => {
      p.beginDate = "20260801";
    },
    (p: typeof probe.raw) => {
      p.pageHelp.total = 7;
    },
    (p: typeof probe.raw) => {
      p.pageHelp.pageCount = 2;
    },
    (p: typeof probe.raw) => {
      p.result[0]!.rzye++;
    },
    (p: typeof probe.raw) => {
      p.result[0]!.opDate = "20260907";
      p.pageHelp.data[0]!.opDate = "20260907";
    },
    (p: typeof probe.raw) => {
      p.result[0]!.opDate = "20260230";
    },
  ]) {
    const raw = structuredClone(probe.raw);
    mutate(raw);
    expect(() =>
      sse.parseSseMargin([raw], "20260901", "20260908", now),
    ).toThrow();
  }
  expect(() =>
    sse.parseSseMargin(
      [{ ...probe.raw, actionErrors: ["denied"] }],
      "20260901",
      "20260908",
      now,
    ),
  ).toThrow();
  expect(() =>
    sse.parseSseMargin(
      [probe.raw],
      "20260901",
      "20260908",
      Date.parse("2026-09-07"),
    ),
  ).toThrow();
});
function syntheticPage(page: number) {
  const raw = structuredClone(probe.raw),
    total = 101;
  const rows = Array.from({ length: page === 1 ? 100 : 1 }, (_, i) => ({
    ...raw.result[0]!,
    opDate: new Date(Date.UTC(2026, 8, 8) - ((page - 1) * 100 + i) * 86400000)
      .toISOString()
      .slice(0, 10)
      .replaceAll("-", ""),
  }));
  raw.beginDate = "20260501";
  raw.result = rows;
  Object.assign(raw.pageHelp, {
    data: rows,
    total,
    pageCount: 2,
    pageNo: page,
  });
  return raw;
}
it("fetches all pages exactly once and does not mistake the first hundred rows for the whole range", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(syntheticPage(1))))
    .mockResolvedValueOnce(new Response(JSON.stringify(syntheticPage(2))));
  vi.stubGlobal("fetch", fetch);
  const data = await sse.querySseMargin("20260501", "20260908");
  expect(sse.sseMarginRows(data)).toHaveLength(101);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(
    new URL(String(fetch.mock.calls[1]![0])).searchParams.get(
      "pageHelp.pageNo",
    ),
  ).toBe("2");
});
it("does not retry authentication/HTTP failures or perform requests after cancellation", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(new Response("denied", { status: 403 }));
  vi.stubGlobal("fetch", fetch);
  await expect(sse.querySseMargin("20260901", "20260908")).rejects.toThrow(
    "请求失败",
  );
  expect(fetch).toHaveBeenCalledOnce();
  const cancel = new AbortController();
  cancel.abort(new Error("cancelled"));
  await expect(
    sse.querySseMargin("20260901", "20260908", cancel.signal),
  ).rejects.toThrow("cancelled");
  expect(fetch).toHaveBeenCalledOnce();
});
it("keeps baseline immutable, records source revisions and requires overlap with the previous tail", () => {
  const seed = [{ date: "2026-09-01", balance: 1000 }],
    before = structuredClone(seed);
  const merged = mergeSseMargin(seed, archive());
  expect(seed).toEqual(before);
  expect(merged.rows).toHaveLength(6);
  expect(merged.revisions).toEqual([
    { date: "2026-09-01", before: 1000, after: 1346761287237 },
  ]);
  expect(() =>
    mergeSseMargin([{ date: "2026-08-31", balance: 1000 }], archive()),
  ).toThrow("基线尾日");
});
function base() {
  const input: TmtInput = {
    amount: [],
    daily: [],
    margin: Array.from({ length: 61 }, (_, i) => ({
      date: new Date(Date.UTC(2026, 8, 1) - (60 - i) * 86400000)
        .toISOString()
        .slice(0, 10),
      balance: 1000,
    })),
    cutoff: "2026-09-08",
    maxAgeDays: 7,
  };
  return {
    key: randomUUID(),
    input,
    facts: tmtCrowding(input),
    readAt: now,
    sources: [],
  };
}
it("updates and archives once, shares identical results, and never labels a lone market proxy as TMT crowding", async () => {
  const query = vi.spyOn(sse, "querySseMargin").mockResolvedValue(archive()),
    seed = base();
  const [a, b] = await Promise.all([
    updateTmtMargin(seed),
    updateTmtMargin(seed),
  ]);
  expect(a).toEqual(b);
  expect(query).toHaveBeenCalledOnce();
  expect(a.input.margin.at(-1)!.date).toBe("2026-09-08");
  expect(a.facts).toMatchObject({
    used: 1,
    scope: "market-proxy-only",
    score: null,
    band: null,
  });
  expect(a.facts.availableWeightedScore).not.toBeNull();
  expect(seed.input.margin.at(-1)!.date).toBe("2026-09-01");
  expect(get(a.updates.sourceIds[0]!)).toBeTruthy();
  expect(await updateTmtMargin(seed)).toEqual(a);
  expect(query).toHaveBeenCalledOnce();
});
it("caches lagging successful reads across candidates and does not grow the increment chain for unchanged data", async () => {
  const query = vi.spyOn(sse, "querySseMargin").mockResolvedValue(archive());
  const seed = base();
  seed.input.cutoff = "2026-09-09";
  seed.facts = tmtCrowding(seed.input);
  const first = await updateTmtMargin(seed);
  expect(first.updates.status).toBe("lagging");
  expect(first.updates.sources[0]).toMatchObject({
    archiveId: first.updates.sourceIds[0],
    fetchedAt: now,
    start: "20260901",
    end: "20260908",
  });
  expect(await updateTmtMargin(seed)).toEqual(first);
  const reloaded = await updateTmtMargin({ ...seed, key: randomUUID() });
  expect(reloaded.updates.status).toBe("cooldown");
  expect(reloaded.facts).toEqual(first.facts);
  expect(query).toHaveBeenCalledOnce();
  vi.mocked(Date.now).mockReturnValue(now + 11 * 60000);
  const refreshed = await updateTmtMargin(seed);
  expect(query).toHaveBeenCalledTimes(2);
  expect(refreshed.updates.status).toBe("lagging");
  expect(refreshed.updates.sourceIds).toEqual(first.updates.sourceIds);
  expect(refreshed.updates.sources).toEqual(first.updates.sources);
  expect(refreshed.facts).toEqual(first.facts);
  await updateTmtMargin({ ...seed, key: randomUUID() });
  expect(query).toHaveBeenCalledTimes(2);
});
it("source failure retains old facts and applies cooldown, while cancellation is propagated", async () => {
  const query = vi
      .spyOn(sse, "querySseMargin")
      .mockRejectedValue(new Error("source failed")),
    seed = base();
  const first = await updateTmtMargin(seed);
  expect(first.updates.status).toBe("failed");
  expect(first.facts).toEqual(seed.facts);
  const second = await updateTmtMargin(seed);
  expect(second.updates.status).toBe("cooldown");
  expect(query).toHaveBeenCalledOnce();
  const cancel = new AbortController();
  cancel.abort(new Error("cancel"));
  await expect(updateTmtMargin(seed, cancel.signal)).rejects.toThrow("cancel");
});
it("reconstructs increments from source archives and rejects tampering before applying them", async () => {
  vi.spyOn(sse, "querySseMargin").mockResolvedValue(archive());
  const seed = base(),
    first = await updateTmtMargin(seed);
  const id = first.updates.sourceIds[0]!,
    saved = get<sse.SseMarginArchive>(id)!;
  saved.pages[0]!.result[0]!.rzye++;
  put("market-source", id, saved);
  await expect(
    updateTmtMargin({ ...seed, key: randomUUID() }),
  ).rejects.toThrow();
});
