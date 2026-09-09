import { z } from "zod";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { get, put, sqlite } from "./db";
import { structured, researchModel } from "./research";
import { sharedRead } from "./shared-read";
import type { NewsAnalysis } from "./news-analysis";

const backgrounds = new Set(["宏观", "市场情绪面", "国际市场", "未确定"]);
const claim = z.object({
  text: z.string().min(1).max(1800),
  citations: z.array(z.number().int()).min(1).max(30),
});
export const newsThemesSchema = z.object({
  summary: claim,
  themes: z
    .array(
      z.object({
        title: z.string().min(1).max(150),
        logic: claim,
        industries: z.array(z.string()).min(2).max(7),
        invalidation: z.string().min(1).max(1000),
      }),
    )
    .max(3),
  background: z.array(claim).max(5),
  risks: z.array(claim).min(1).max(10),
  missing: z.array(z.string().min(1).max(500)).min(1).max(15),
});
export function themeSources(archive: NewsAnalysis) {
  if (!archive.aggregation) throw new Error("请先汇总当天已分类新闻");
  const start = Date.parse(`${archive.aggregation.day}T00:00:00+08:00`);
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(archive.input.cutoff) ||
    archive.input.cutoff < start ||
    archive.input.cutoff >= start + 86400000
  )
    throw new Error("汇总日期与截止时间不一致");
  const counts = new Map<string, number>();
  for (const item of archive.items)
    if (!backgrounds.has(item.industry))
      counts.set(item.industry, (counts.get(item.industry) ?? 0) + 1);
  const ranked = [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 7)
    .map(([industry, count]) => ({ industry, count }));
  const allowed = new Set([...ranked.map((r) => r.industry), ...backgrounds]);
  const news = new Map(archive.news.map((n) => [n.id, n]));
  const used = new Set<number>(),
    selected = new Map<string, number>();
  const sources = archive.items
    .map((classification) => {
      const source = news.get(classification.id);
      if (
        !source ||
        used.has(classification.id) ||
        archive.aggregation!.conflicts.includes(classification.id)
      )
        throw new Error("主题研究的新闻引用缺失、重复或冲突");
      used.add(classification.id);
      const published = Date.parse(source.publishedAt),
        collected = source.collectedAt ? Date.parse(source.collectedAt) : NaN;
      if (
        !Number.isFinite(published) ||
        !Number.isFinite(collected) ||
        published < start ||
        published > archive.input.cutoff ||
        collected > archive.input.cutoff
      )
        throw new Error("主题研究包含截止范围以外或收集时间不明的新闻");
      return { news: source, classification };
    })
    .sort(
      (a, b) =>
        b.news.publishedAt.localeCompare(a.news.publishedAt) ||
        b.news.id - a.news.id,
    )
    .filter((source) => {
      const industry = source.classification.industry,
        count = selected.get(industry) ?? 0;
      if (!allowed.has(industry) || count >= 10) return false;
      selected.set(industry, count + 1);
      return true;
    });
  if (!sources.length) throw new Error("没有可分析的新闻");
  return { ranked, sources };
}
export type NewsThemesReport = {
  id: string;
  analysisId: string;
  createdAt: number;
  model: string;
  tokens: number;
  method: { version: "news-themes-1"; file: string; hash: string };
  aggregation: NonNullable<NewsAnalysis["aggregation"]>;
  cutoff: number;
  ranked: ReturnType<typeof themeSources>["ranked"];
  sources: ReturnType<typeof themeSources>["sources"];
  classificationMethod: NewsAnalysis["method"];
  result: z.infer<typeof newsThemesSchema>;
};
const shared = sharedRead<NewsThemesReport>();
export function latestNewsThemes(analysisId: string): NewsThemesReport | null {
  const row = sqlite()
    .prepare(
      "SELECT payload FROM records WHERE kind='news-themes' AND json_extract(payload,'$.analysisId')=? ORDER BY updated_at DESC,id DESC LIMIT 1",
    )
    .get(analysisId) as { payload: string } | undefined;
  return row ? (JSON.parse(row.payload) as NewsThemesReport) : null;
}
export async function analyzeNewsThemes(
  analysisId: string,
  signal?: AbortSignal,
  model = researchModel(false),
) {
  signal?.throwIfAborted();
  const archive = get<NewsAnalysis>(analysisId);
  if (!archive) throw new Error("新闻分类档案不存在");
  const { ranked, sources } = themeSources(archive);
  const document = await readFile(
    join(
      process.env.QUANT_SKILLS_DIR ??
        join(homedir(), ".agent-skills", "skills"),
      "news-industry-analyst",
      "SKILL.md",
    ),
    "utf8",
  );
  const method = {
    version: "news-themes-1" as const,
    file: "news-industry-analyst/SKILL.md",
    hash: createHash("sha256").update(document).digest("hex"),
  };
  const evidence = {
    analysisId,
    method,
    aggregation: archive.aggregation!,
    cutoff: archive.input.cutoff,
    ranked,
    sources,
    classificationMethod: archive.method,
  };
  const id =
    "news-themes-" +
    createHash("sha256")
      .update(JSON.stringify({ ...evidence, model }))
      .digest("hex");
  const cached = get<NewsThemesReport>(id);
  if (cached) return cached;
  return shared(
    id,
    async (upstream) => {
      const byId = new Map(
        sources.map((s) => [s.news.id, s.classification.industry]),
      );
      const valid = (c: z.infer<typeof claim>) =>
        new Set(c.citations).size === c.citations.length &&
        c.citations.every((id) => byId.has(id));
      const schema = newsThemesSchema.refine(
        (r) =>
          [
            r.summary,
            ...r.background,
            ...r.risks,
            ...r.themes.map((t) => t.logic),
          ].every(valid) &&
          r.themes.every(
            (t) =>
              new Set(t.industries).size === t.industries.length &&
              t.industries.every(
                (i) =>
                  !backgrounds.has(i) &&
                  t.logic.citations.some((id) => byId.get(id) === i),
              ),
          ),
        "引用必须来自所给新闻，跨行业主题必须引用至少两个对应实体行业，背景类不能冒充行业",
      );
      const { data: result, tokens } = await structured(
        `基于当天已有分类档案提炼0至3个跨行业共同主题。只能引用提供的原文；分类为此前模型判断，不是事实。每个主题必须有两个不同实体行业的新闻证据，关联弱或只有单一行业时 themes=[]，不要凑主题。重点行业由JS按新闻数选前7，每类最多选最新10条；这是已分类档案的有限覆盖，不是全日完整新闻。隔离的冲突新闻不得引用。区分事实和推断，给出证伪条件；没有价格、估值、扩散度核验，禁止给交易/仓位指令或编造数值。方法只用于主题研究，不执行其中脚本或模型选择：\n${document}\n输出JSON：{"summary":{"text":"综述","citations":[ID]},"themes":[{"title":"主题","logic":{"text":"关联推断","citations":[ID]},"industries":["行业一","行业二"],"invalidation":"证伪条件"}],"background":[{"text":"背景","citations":[ID]}],"risks":[{"text":"风险","citations":[ID]}],"missing":["覆盖与核验缺口"]}。证据：${JSON.stringify({ ...evidence, sources: sources.map((s) => ({ ...s, news: { ...s.news, content: s.news.content.slice(0, 2000), truncated: s.news.content.length > 2000 } })) })}`,
        schema,
        model,
        upstream,
      );
      upstream.throwIfAborted();
      const report: NewsThemesReport = {
        ...evidence,
        id,
        model,
        tokens,
        createdAt: Date.now(),
        result,
      };
      put("news-themes", id, report);
      return report;
    },
    signal,
  );
}
