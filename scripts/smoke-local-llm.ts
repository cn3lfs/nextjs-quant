import { localCompletion } from "../src/server/local-llm";
import { analyze, interpret, snapshotEvidence } from "../src/server/research";
import { settings } from "../src/server/settings";
import { readSnapshot } from "../src/server/tdx";
import { defaultStrategy } from "../src/lib/domain";
if (process.argv.includes("--research")) {
  const draft = await interpret("寻找均线多头排列且放量的股票");
  const snapshot = await readSnapshot(settings().tdxRoot, "sh600519", "day");
  const report = await analyze(
    snapshot.id,
    "基于提供的数据简要分析趋势和风险",
    snapshotEvidence(snapshot, defaultStrategy),
  );
  console.log(
    JSON.stringify({
      provider: settings().llmProvider,
      draftValid: Boolean(draft.strategy),
      reportId: report.id,
      citations: report.citations.length,
      tokens: report.tokens,
    }),
  );
} else
  for (const provider of ["codex", "claude"] as const) {
    const reply = await localCompletion(
      provider,
      '不要调用任何工具。只返回 JSON：{"ok":true}',
      "",
    );
    if (JSON.parse(reply.text).ok !== true)
      throw new Error(`${provider} returned invalid JSON`);
    console.log(
      JSON.stringify({ provider, success: true, tokens: reply.tokens }),
    );
  }
