import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const state = vi.hoisted(() => ({
  records: new Map<string, unknown>(),
  model: vi.fn(),
  news: vi.fn(),
}));
vi.mock("../src/server/db", () => ({
  get: (id: string) => state.records.get(id),
  put: (_kind: string, id: string, value: unknown) =>
    state.records.set(id, value),
  atomic: (fn: () => unknown) => fn(),
  sqlite: () => ({
    prepare: () => ({
      iterate: (model: string, method: string) =>
        [...state.records.entries()]
          .filter(([id, raw]) => {
            const value = raw as { model?: string; method?: unknown };
            return (
              id.startsWith("news-analysis-") &&
              value.model === model &&
              JSON.stringify(value.method) === method
            );
          })
          .map(([, value]) => ({ payload: JSON.stringify(value) })),
    }),
  }),
}));
vi.mock("../src/server/data-sources/cls/cls-news", () => ({
  readClsNews: state.news,
}));
vi.mock("../src/server/infra/settings", () => ({
  settings: () => ({ clsDbPath: "fixture" }),
}));
vi.mock("../src/server/research/research", () => ({
  researchModel: () => "codex:default",
  structured: state.model,
}));
import {
  analyzeNews,
  newsAnalysisView,
  type NewsAnalysis,
} from "../src/server/news/news-analysis";
const input = { cutoff: 1000, page: 0, query: "", historical: true };
let guidePath: string, guide: string;
beforeEach(async () => {
  state.records.clear();
  state.model.mockReset();
  const root = await mkdtemp(join(tmpdir(), "quant-news-method-"));
  vi.stubEnv("QUANT_SKILLS_DIR", root);
  const directory = join(root, "news-industry-classifier");
  await mkdir(join(directory, "references"), { recursive: true });
  guide = Array.from({ length: 34 }, (_, i) => `- 行业${i}：定义`).join("\n");
  guidePath = join(directory, "references/sw-industries.md");
  await writeFile(join(directory, "SKILL.md"), "fixture method");
  await writeFile(guidePath, guide);
  state.news.mockReturnValue({
    items: [1, 2].map((id) => ({
      id,
      title: `标题${id}`,
      content: "消息内容",
      hash: `hash-${id}`,
      publishedAt: "1970-01-01T00:00:00Z",
      collectedAt: null,
      url: null,
    })),
  });
  state.model.mockImplementation(async (prompt, schema, model) => {
    expect(model).toBe("codex:default");
    return {
      tokens: 10,
      data: schema.parse({
        items: JSON.parse(prompt.slice(prompt.lastIndexOf("\n新闻：") + 4)).map(
          (n: { id: number }) => ({
            id: n.id,
            industry: "行业0",
            impact: "uncertain",
            reason: "依据原文尚不明确",
            uncertainty: "缺少后续资料",
          }),
        ),
      }),
    };
  });
});
afterEach(() => vi.unstubAllEnvs());
it("archives source and rule hashes, aggregates deterministically and invalidates cache on method changes", async () => {
  const result = await analyzeNews(input);
  expect(result).toMatchObject({
    model: "codex:default",
    distribution: { 行业0: 2 },
    tokens: 10,
  });
  expect(result.news).toHaveLength(2);
  expect(result.method.files).toHaveLength(2);
  expect(await analyzeNews(input)).toEqual(result);
  expect(
    await analyzeNews({ ...input, cutoff: 2000, query: "另一查询" }),
  ).toEqual(result);
  expect(state.model).toHaveBeenCalledOnce();
  await writeFile(guidePath, guide + "\n新规则说明");
  expect((await analyzeNews(input)).id).not.toBe(result.id);
  expect(state.model).toHaveBeenCalledTimes(2);
});
it("shares concurrent model work for identical news across query scopes", async () => {
  let complete!: () => void;
  const ready = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const original = state.model.getMockImplementation()!;
  state.model.mockImplementation(async (...args) => {
    await ready;
    return original(...args);
  });
  const first = analyzeNews(input),
    second = analyzeNews({ ...input, cutoff: 2000 });
  await vi.waitFor(() => expect(state.model).toHaveBeenCalledOnce());
  complete();
  expect((await first).id).toBe((await second).id);
  expect(state.model).toHaveBeenCalledOnce();
});
it("reserves only uncached model work and cannot bypass a rejected budget", async () => {
  const reserve = vi.fn();
  await analyzeNews(input, undefined, undefined, "background", reserve);
  expect(reserve).toHaveBeenCalledOnce();
  await analyzeNews(input, undefined, undefined, "background", reserve);
  expect(reserve).toHaveBeenCalledOnce();
  await writeFile(guidePath, guide + "\nchanged");
  reserve.mockImplementation(() => {
    throw new Error("budget exhausted");
  });
  await expect(
    analyzeNews(input, undefined, undefined, "background", reserve),
  ).rejects.toThrow("budget exhausted");
  expect(state.model).toHaveBeenCalledOnce();
});
it("reuses overlapping in-flight news without serializing unrelated news", async () => {
  const sources = state.news().items;
  const third = { ...sources[0], id: 3, hash: "hash-3" };
  state.news.mockImplementation((_path, options) => ({
    items:
      options.query === "overlap"
        ? [sources[1], third]
        : options.query === "unrelated"
          ? [{ ...third, id: 4, hash: "hash-4" }]
          : sources,
  }));
  let unblock!: () => void;
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const original = state.model.getMockImplementation()!;
  const submitted: number[][] = [];
  state.model.mockImplementation(async (...args) => {
    const prompt = args[0];
    const ids = JSON.parse(
      prompt.slice(prompt.lastIndexOf("\n新闻：") + 4),
    ).map((n: { id: number }) => n.id);
    submitted.push(ids);
    if (ids.includes(1)) await gate;
    return original(...args);
  });
  const first = analyzeNews(input);
  await vi.waitFor(() => expect(submitted).toEqual([[1, 2]]));
  const overlap = analyzeNews({ ...input, query: "overlap" });
  const unrelated = await analyzeNews({ ...input, query: "unrelated" });
  expect(unrelated.items.map((n) => n.id)).toEqual([4]);
  expect(submitted).toEqual([[1, 2], [4]]);
  unblock();
  await first;
  const result = await overlap;
  expect(result.reusedItems).toBe(1);
  expect(result.items.map((n) => n.id).sort()).toEqual([2, 3]);
  expect(submitted).toEqual([[1, 2], [4], [3]]);
});

it("keeps the first 25 results when the second batch fails and resumes only unfinished news", async () => {
  state.news.mockReturnValue({
    items: Array.from({ length: 50 }, (_, i) => ({
      id: i + 1,
      title: `标题${i}`,
      content: "原文",
      hash: `hash-${i}`,
      publishedAt: "1970-01-01T00:00:00Z",
      collectedAt: null,
      url: null,
    })),
  });
  const submitted: number[][] = [];
  state.model.mockImplementation(async (prompt, schema) => {
    const batch = JSON.parse(prompt.slice(prompt.lastIndexOf("\n新闻：") + 4));
    submitted.push(batch.map((n: { id: number }) => n.id));
    if (submitted.length === 2) throw new Error("quota fixture");
    return {
      tokens: 10,
      data: schema.parse({
        items: batch.map((n: { id: number }) => ({
          id: n.id,
          industry: "行业0",
          impact: "uncertain",
          reason: "依据原文",
          uncertainty: "待核验",
        })),
      }),
    };
  });
  const partial = await analyzeNews(input);
  expect(partial).toMatchObject({ status: "partial", tokens: 10 });
  expect(partial.items).toHaveLength(25);
  expect(partial.news).toHaveLength(50);
  state.news.mockReturnValue({ items: [] });
  const complete = await analyzeNews({ ...input, resumeId: partial.id });
  expect(complete).toMatchObject({
    status: "complete",
    tokens: 20,
    distribution: { 行业0: 50 },
  });
  expect(complete.items).toHaveLength(50);
  expect(submitted.map((ids) => ids.length)).toEqual([25, 25, 25]);
  expect(submitted[1]).toEqual(submitted[2]);
  expect(submitted[2]).not.toContain(1);
  await analyzeNews({ ...input, resumeId: complete.id });
  expect(state.model).toHaveBeenCalledTimes(3);
});
it("budget exhaustion archives the first batch and resumes only the remaining frozen news", async () => {
  const source = state.news().items[0];
  state.news.mockReturnValue({
    items: Array.from({ length: 50 }, (_, i) => ({
      ...source,
      id: i + 1,
      hash: `hash-${i}`,
    })),
  });
  let remaining = 1;
  const reserve = vi.fn(() => {
    if (!remaining) throw new Error("daily budget exhausted");
    remaining--;
  });
  const partial = await analyzeNews(
    input,
    undefined,
    undefined,
    "background",
    reserve,
  );
  expect(partial.status).toBe("partial");
  expect(partial.items).toHaveLength(25);
  expect(state.model).toHaveBeenCalledOnce();
  expect(reserve).toHaveBeenCalledTimes(2);
  state.news.mockReturnValue({ items: [] });
  remaining = 1;
  const result = await analyzeNews(
    { ...input, cutoff: 2000, resumeId: partial.id },
    undefined,
    undefined,
    "background",
    reserve,
  );
  expect(result.status).toBe("complete");
  expect(result.items).toHaveLength(50);
  expect(result.input.cutoff).toBe(input.cutoff);
  expect(state.model).toHaveBeenCalledTimes(2);
  const prompt = state.model.mock.calls[1]![0] as string;
  const submitted = JSON.parse(
    prompt.slice(prompt.lastIndexOf("\n新闻：") + 4),
  ) as { id: number }[];
  expect(submitted.map((n) => n.id)).toEqual(
    Array.from({ length: 25 }, (_, i) => i + 26),
  );
});

it("rejects missing, duplicated or invented classifications without saving a fake macro fallback", async () => {
  for (const items of [
    [],
    [1, 1].map((id) => ({
      id,
      industry: "行业0",
      impact: "neutral",
      reason: "解释",
      uncertainty: "未知",
    })),
    [1, 2].map((id) => ({
      id,
      industry: "编造标签",
      impact: "neutral",
      reason: "解释",
      uncertainty: "未知",
    })),
  ]) {
    state.model.mockImplementationOnce(async (_prompt, schema) => ({
      tokens: 1,
      data: schema.parse({ items }),
    }));
    await expect(analyzeNews(input)).rejects.toThrow();
    expect(state.records.size).toBe(0);
  }
});
it("retains committed batches on cancellation and refuses a late second-batch result", async () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({
    id: i + 1,
    title: `标题${i}`,
    content: "原文",
    hash: `hash-${i}`,
    publishedAt: "1970-01-01T00:00:00Z",
    collectedAt: null,
    url: null,
  }));
  state.news.mockReturnValue({ items: rows });
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const upstream: AbortSignal[] = [];
  state.model.mockImplementation(async (prompt, schema, _model, signal) => {
    upstream.push(signal);
    const batch = JSON.parse(prompt.slice(prompt.lastIndexOf("\n新闻：") + 4));
    if (upstream.length === 2) await delayed;
    return {
      tokens: 10,
      data: schema.parse({
        items: batch.map((n: { id: number }) => ({
          id: n.id,
          industry: "行业0",
          impact: "uncertain",
          reason: "依据原文",
          uncertainty: "待核验",
        })),
      }),
    };
  });
  const controller = new AbortController();
  const run = analyzeNews(input, controller.signal),
    rejected = expect(run).rejects.toThrow();
  await vi.waitFor(() => expect(state.model).toHaveBeenCalledTimes(2));
  controller.abort();
  await rejected;
  expect(upstream[1]!.aborted).toBe(true);
  const before = [...state.records.values()][0];
  expect(before).toMatchObject({ status: "partial", tokens: 10 });
  expect((before as { items: unknown[] }).items).toHaveLength(25);
  expect(
    [...state.records.keys()].filter((key) => key.startsWith("news-item-")),
  ).toHaveLength(25);
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect([...state.records.values()][0]).toEqual(before);
});
it("freezes a bounded query range once and preserves coverage notices on a content-cache hit", async () => {
  const rows = Array.from({ length: 150 }, (_, i) => ({
    id: i + 1,
    title: `标题${i}`,
    content: "原文",
    hash: `hash-${i}`,
    publishedAt: "1970-01-01T00:00:00Z",
    collectedAt: null,
    url: null,
  }));
  state.news.mockImplementation((_path, options) => ({
    count: 150,
    items: rows.slice(0, options.limit),
  }));
  state.model.mockImplementation(async (prompt, schema) => {
    const batch = JSON.parse(prompt.slice(prompt.lastIndexOf("\n新闻：") + 4));
    return {
      tokens: 1,
      data: schema.parse({
        items: batch.map((n: { id: number }) => ({
          id: n.id,
          industry: "行业0",
          impact: "uncertain",
          reason: "依据原文",
          uncertainty: "未知",
        })),
      }),
    };
  });
  const range = await analyzeNews({ ...input, scope: "range", maxItems: 100 });
  expect(range).toMatchObject({
    status: "complete",
    totalMatches: 150,
    hitLimit: true,
    requestCoverage: { scope: "range", totalMatches: 150, hitLimit: true },
  });
  expect(range.items).toHaveLength(100);
  expect(state.model).toHaveBeenCalledTimes(4);
  expect(state.news).toHaveBeenLastCalledWith(
    "fixture",
    expect.objectContaining({ page: 0, limit: 100 }),
  );
  const page = await analyzeNews(input);
  expect(page.requestCoverage?.hitLimit).toBe(false);
  const limited = await analyzeNews({ ...input, scope: "range", maxItems: 50 });
  expect(limited.id).toBe(page.id);
  expect(limited.requestCoverage?.hitLimit).toBe(true);
  expect(state.model).toHaveBeenCalledTimes(4);
  expect(page.reusedItems).toBe(50);
  expect(page.tokens).toBe(0);
});
it("复用交叠范围中的旧分类，只分析新增或改动的原文，保留来源与新增用量", async () => {
  const first = await analyzeNews(input);
  const newItem = {
    ...first.news[0]!,
    id: 3,
    hash: "new-hash",
    content: "新新闻",
  };
  const submitted: number[][] = [];
  state.model.mockImplementation(async (prompt, schema) => {
    const batch = JSON.parse(prompt.slice(prompt.lastIndexOf("\n新闻：") + 4));
    submitted.push(batch.map((n: { id: number }) => n.id));
    return {
      tokens: 7,
      data: schema.parse({
        items: batch.map((n: { id: number }) => ({
          id: n.id,
          industry: "行业0",
          impact: "uncertain",
          reason: "新分析",
          uncertainty: "待验证",
        })),
      }),
    };
  });
  state.news.mockReturnValue({ items: [...first.news, newItem] });
  const expanded = await analyzeNews({ ...input, query: "扩大范围" });
  expect(submitted).toEqual([[3]]);
  expect(expanded).toMatchObject({
    status: "complete",
    reusedItems: 2,
    tokens: 7,
    distribution: { 行业0: 3 },
  });
  expect(expanded.itemOrigins?.map((o) => o.analysisId)).toEqual([
    first.id,
    first.id,
  ]);
  state.news.mockReturnValue({
    items: [
      { ...first.news[0]!, content: "同ID与源hash但正文被修改" },
      newItem,
    ],
  });
  const changed = await analyzeNews(input);
  expect(submitted).toEqual([[3], [first.news[0]!.id]]);
  expect(changed.reusedItems).toBe(1);
});
it("旧档案没有逐条缓存时从历史批次迁移，规则变更不复用", async () => {
  const first = await analyzeNews(input);
  for (const key of state.records.keys())
    if (key.startsWith("news-item-")) state.records.delete(key);
  state.news.mockReturnValue({ items: [first.news[0]!] });
  const subset = await analyzeNews(input);
  expect(subset).toMatchObject({
    tokens: 0,
    reusedItems: 1,
    status: "complete",
  });
  expect(state.model).toHaveBeenCalledTimes(1);
  await writeFile(guidePath, guide + "\n规则变化");
  await analyzeNews(input);
  expect(state.model).toHaveBeenCalledTimes(2);
});
it("下一批与历史恢复保留同一查询语境，使用时间及ID边界且最后一批停止", async () => {
  const rows = Array.from({ length: 150 }, (_, i) => ({
    id: 150 - i,
    title: `新闻${i}`,
    content: "原文",
    hash: `hash-${i}`,
    publishedAt: "1970-01-01T00:00:01Z",
    collectedAt: null,
    url: null,
  }));
  state.news.mockImplementation((_path, options) => {
    const selected = rows.filter(
      (n) => !options.before || n.id < options.before.id,
    );
    return { count: selected.length, items: selected.slice(0, options.limit) };
  });
  const original = {
    ...input,
    cutoff: 2000,
    query: "固定查询",
    scope: "range" as const,
    maxItems: 100,
  };
  const first = await analyzeNews(original);
  expect(first.nextInput).toMatchObject({
    ...original,
    before: { time: 1, id: 51 },
  });
  expect(
    newsAnalysisView(state.records.get(first.id) as NewsAnalysis).nextInput,
  ).toEqual(first.nextInput);
  const next = await analyzeNews(first.nextInput!);
  expect(next.news).toHaveLength(50);
  expect(next.nextInput).toBeUndefined();
  expect(next.input).toMatchObject({
    ...original,
    before: { time: 1, id: 51 },
  });
  expect([...first.news, ...next.news].map((n) => n.id)).toEqual(
    rows.map((n) => n.id),
  );
  expect(next.status).toBe("complete");
  await expect(
    analyzeNews({ ...original, scope: "page", before: { time: 1, id: 51 } }),
  ).rejects.toThrow("游标仅用于");
});
