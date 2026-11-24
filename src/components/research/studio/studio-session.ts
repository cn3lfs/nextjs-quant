import {
  researchStudioDraftSchema,
  studioResultSchema,
  type ResearchStudioDraftInput,
  type StudioResult,
} from "~/lib/research/studio-result";

export type StudioSessionRun = {
  id: string;
  createdAt: number;
  draft: ResearchStudioDraftInput;
  result: StudioResult;
};

const keyPrefix = "quant:studio-run:v1:";

export function readSessionRuns(): StudioSessionRun[] {
  try {
    const runs: StudioSessionRun[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (!key?.startsWith(keyPrefix)) continue;
      try {
        const raw = sessionStorage.getItem(key);
        if (!raw) continue;
        const run: StudioSessionRun = JSON.parse(raw);
        if (
          run.id !== key.slice(keyPrefix.length) ||
          !Number.isFinite(run.createdAt)
        )
          continue;
        const result = studioResultSchema.safeParse(run.result);
        const draft = researchStudioDraftSchema.safeParse(run.draft);
        if (
          result.success &&
          draft.success &&
          draft.data.template === result.data.template
        )
          runs.push({ ...run, draft: draft.data, result: result.data });
      } catch {
        // A partially written or obsolete entry cannot hide other results.
      }
    }
    return runs;
  } catch {
    return [];
  }
}

export function saveSessionRun(
  draft: ResearchStudioDraftInput,
  result: StudioResult,
) {
  const id = result.jobId ?? `studio-${crypto.randomUUID()}`;
  const run = { id, createdAt: Date.now(), draft, result };
  try {
    sessionStorage.setItem(keyPrefix + id, JSON.stringify(run));
    return { run, persisted: true };
  } catch {
    return { run, persisted: false };
  }
}

export function studioRunMarkdown(
  run: StudioSessionRun,
  pct: (value: number | null) => string,
) {
  const { result, draft, id } = run;
  return [
    `# 策略研究结果 · ${result.strategyKey ?? result.template}`,
    "",
    `- 运行编号：${id}`,
    `- 历史区间：${draft.start} 至 ${draft.end}`,
    `- 累计收益：${pct(result.totalReturn)}`,
    `- 最大回撤：${pct(result.maxDrawdown)}`,
    "",
    "## 成本敏感性",
    "",
    "| 成本情景 | 累计收益 | 最大回撤 |",
    "| --- | --- | --- |",
    ...result.costScenarios.map(
      (row) =>
        `| ${row.costScenario} | ${pct(row.totalReturn)} | ${pct(row.maxDrawdown)} |`,
    ),
    "",
    "## 研究口径",
    "",
    ...result.disclosures.map((note) => `- ${note}`),
    "",
    "完整冻结输入与回测结果见 JSON 导出。",
  ].join("\n");
}
