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
    <aside className="panel research-panel">
      <div className="panel-title">
        <Sparkles size={18} />
        <h3>证据分析</h3>
        <span className="tag ai">
          {status.data?.settings.llmProvider === "deepseek"
            ? "DeepSeek"
            : status.data?.settings.llmProvider === "claude"
              ? "Claude Code"
              : "Codex"}
        </span>
      </div>
      <div className="research-intro">
        <div className="orbit">
          <Sparkles size={28} />
        </div>
        <h3>多看一层，少猜一步</h3>
        <p>基于当前行情与计算指标，分析趋势、反向证据和潜在风险。</p>
      </div>
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
      <CanslimPanel snapshot={loaded ?? undefined} />
      <ChanPanel snapshot={loaded ?? undefined} />
      <WyckoffPanel snapshot={loaded ?? undefined} />
    </aside>
  );
}
