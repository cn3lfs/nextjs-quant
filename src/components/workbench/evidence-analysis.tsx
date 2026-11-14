import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { ArrowUpRight, Check, Sparkles } from "lucide-react";
import { Button } from "../ui/button";
import { LatestReport } from "../research/latest-report";
import { Sparkle } from "@phosphor-icons/react/ssr";
import { PageGrid, Panel } from "../panels";

import { Field } from "./shared";
import Link from "next/link";
import { defaultStrategy, type Snapshot } from "~/lib/domain";
import { useResearchSession } from "~/lib/stores/research-session";
import { api } from "~/trpc/react";
import { useTaskVisible } from "./use-task-visible";

export function EvidenceAnalysis({
  loaded,
  notify,
}: {
  loaded: Snapshot | null;
  notify: (text: string) => void;
}) {
  const visible = useTaskVisible();
  const provider = api.status.useQuery(undefined, {
    enabled: visible,
    refetchInterval: visible ? 30000 : false,
    select: (value) => value.settings.llmProvider,
  });
  const { question, setQuestion, method, setMethod } = useResearchSession();
  const analyze = api.analyze.useMutation({
    onSuccess: () => notify("研究任务已加入队列，可在研究档案查看"),
    onError: (error) => notify(error.message),
  });
  return (
    <PageGrid>
      <Panel
        span={4}
        tone="accent"
        icon={Sparkle}
        title="研究问题"
        tag={
          provider.data === "deepseek"
            ? "DeepSeek"
            : provider.data === "claude"
              ? "Claude Code"
              : provider.data === "codex"
                ? "Codex"
                : provider.error
                  ? "配置读取失败"
                  : "正在读取配置"
        }
        note="研究结果写入研究档案，可导出 Markdown。"
      >
        {provider.error && (
          <p role="alert">
            研究配置未刷新：{provider.error.message}{" "}
            <Button
              variant="outline"
              size="sm"
              onClick={() => void provider.refetch()}
            >
              重试研究配置
            </Button>
          </p>
        )}
        <p className="m-0 mb-3 text-[13px] text-nc-text-2">
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
            value={method}
            onValueChange={(value) => setMethod(value as "general" | "sepa")}
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
              method,
              strategy: defaultStrategy,
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
        <Button variant="plain" className="text-link" asChild>
          <Link href="/reports" scroll={false}>
            查看研究档案 <ArrowUpRight size={14} />
          </Link>
        </Button>
      </Panel>
      <LatestReport symbol={loaded?.symbol} />
    </PageGrid>
  );
}
