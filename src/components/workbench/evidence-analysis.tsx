import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { ArrowUpRight, Check, Sparkles } from "lucide-react";
import { CanslimPanel } from "../research/canslim-panel";
import { ChanPanel } from "../research/chan-panel";
import { Button } from "../ui/button";
import { WyckoffPanel } from "../research/wyckoff-panel";
import { LatestReport } from "../research/latest-report";
import { Sparkle, Stack } from "@phosphor-icons/react/ssr";
import { PageGrid, Panel } from "../panels";

import { Field } from "./shared";
import { type WorkbenchState } from "./use-workbench-state";

export function EvidenceAnalysis({
  state,
}: {
  state: Pick<
    WorkbenchState,
    | "setTab"
    | "loaded"
    | "strategy"
    | "question"
    | "setQuestion"
    | "researchMethod"
    | "setResearchMethod"
    | "status"
    | "analyze"
  >;
}) {
  const {
    setTab,
    loaded,
    strategy,
    question,
    setQuestion,
    researchMethod,
    setResearchMethod,
    status,
    analyze,
  } = state;
  return (
    <PageGrid>
      <Panel
        span={4}
        tone="accent"
        icon={Sparkle}
        title="研究问题"
        tag={
          status.data?.settings.llmProvider === "deepseek"
            ? "DeepSeek"
            : status.data?.settings.llmProvider === "claude"
              ? "Claude Code"
              : "Codex"
        }
        note="研究结果写入研究档案，可导出 Markdown。"
      >
        <p className="m-0 mb-3 text-[12px] text-nc-text-2">
          {loaded
            ? `快照：${loaded.name ?? loaded.symbol.toUpperCase()} · ${loaded.period} · 截至 ${loaded.bars.at(-1)?.date ?? "—"}`
            : "先在行情图表加载一只证券，研究基于当前行情与计算指标。"}
        </p>
        <Field label="研究问题">
          <Textarea
            className="field-sizing-fixed"
            rows={4}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
          />
        </Field>
        <Field label="研究方法">
          <Select
            value={researchMethod}
            onValueChange={(value) =>
              setResearchMethod(value as "general" | "sepa")
            }
          >
            <SelectTrigger aria-label="研究方法" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="general">通用证据分析</SelectItem>
              <SelectItem value="sepa">SEPA 分阶段研究</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Button
          className="full"
          disabled={!loaded || analyze.isPending}
          onClick={() =>
            loaded &&
            analyze.mutate({
              snapshotId: loaded.id,
              question,
              method: researchMethod,
              strategy,
            })
          }
        >
          <Sparkles size={15} />
          开始研究
        </Button>
        <div className="evidence-note">
          <Check size={14} />
          数据来源与时间可追溯
          <br />
          <Check size={14} />
          缺少证据时明确标注
        </div>
        <Button
          variant="plain"
          className="text-link"
          onClick={() => setTab("reports")}
        >
          查看研究档案 <ArrowUpRight size={14} />
        </Button>
      </Panel>
      <LatestReport symbol={loaded?.symbol} />
      <Panel
        icon={Stack}
        title="方法面板"
        meta="CAN SLIM · 缠论 · 威科夫"
        bodyClassName="flex flex-col gap-[var(--nc-gap)]"
      >
        <CanslimPanel snapshot={loaded ?? undefined} />
        <ChanPanel snapshot={loaded ?? undefined} />
        <WyckoffPanel snapshot={loaded ?? undefined} />
      </Panel>
    </PageGrid>
  );
}
