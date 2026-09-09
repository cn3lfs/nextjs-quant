import { ArrowDownToLine, Sparkles } from "lucide-react";
import { useState } from "react";
import { type Report } from "~/lib/domain";
import { archivedNameHint, securityDisplayName } from "~/lib/security-display";
import { api } from "~/trpc/react";
import { RsSourceDownload } from "../rs-source-download";
import { Button } from "../ui/button";

import { stamp } from "./shared";

export function ReportArchive({
  names,
  active,
}: {
  names: Record<string, string>;
  active: boolean;
}) {
  const utils = api.useUtils();
  const [cursors, setCursors] = useState<
    ({ createdAt: number; id: string } | undefined)[]
  >([undefined]);
  const [selected, setSelected] = useState("");
  const history = api.reportHistory.useQuery(
    { cursor: cursors.at(-1) },
    {
      staleTime: Infinity,
      refetchInterval: cursors.length === 1 ? (active ? 2000 : 30000) : false,
    },
  );
  const detail = api.archivedReport.useQuery(selected, {
    enabled: !!selected,
    staleTime: Infinity,
  });
  return (
    <section className="panel">
      <h3>通用研究报告</h3>
      <p className="muted">
        选择报告查看完整正文与证据。共 {history.data?.total ?? 0} 份 · 第{" "}
        {cursors.length} 页
      </p>
      <Button
        variant="outline"
        onClick={() => {
          setCursors([undefined]);
          void utils.reportHistory.invalidate();
        }}
      >
        刷新列表
      </Button>
      {history.isLoading && <p role="status">正在读取报告列表…</p>}
      {history.error && <p role="alert">{history.error.message}</p>}
      {history.data?.items.map((item) => (
        <div key={item.id}>
          <button className="text-link" onClick={() => setSelected(item.id)}>
            {item.securityContext
              ? `${securityDisplayName(item.securityContext.symbol, names, item.securityContext.archivedName)} · ${item.securityContext.symbol} · `
              : ""}
            {item.title} · {stamp(item.createdAt)}
          </button>
        </div>
      ))}
      {history.data?.total === 0 && <p>暂无通用研究报告。</p>}
      <Button
        variant="outline"
        disabled={cursors.length === 1 || history.isFetching}
        onClick={() => setCursors(cursors.slice(0, -1))}
      >
        上一页报告
      </Button>
      <Button
        variant="outline"
        disabled={!history.data?.nextCursor || history.isFetching}
        onClick={() => {
          if (history.data?.nextCursor)
            setCursors([...cursors, history.data.nextCursor]);
        }}
      >
        下一页报告
      </Button>
      {selected && detail.isLoading && <p role="status">正在读取完整报告…</p>}
      {detail.error && (
        <p role="alert">
          {detail.error.message}
          <Button onClick={() => void detail.refetch()}>重试报告</Button>
        </p>
      )}
      {selected && detail.isSuccess && !detail.data && <p>该报告不存在。</p>}
      {detail.data && (
        <ReportCard
          report={detail.data}
          securityContext={detail.data.securityContext}
          names={names}
        />
      )}
    </section>
  );
}
export function ReportCard({
  report,
  securityContext,
  names,
}: {
  report: Report;
  securityContext: { symbol: string; archivedName?: string } | null;
  names: Record<string, string>;
}) {
  const stageNames = {
    market: "市场与行业",
    fundamentals: "基本面",
    trend: "趋势与相对强度",
    vcp: "VCP形态",
    "entry-risk": "入场与风险",
    conclusion: "综合结论",
  };
  function download() {
    const markdown =
      `# ${report.title}\n\n${report.summary}\n\n` +
      [
        ["支持证据", report.supporting],
        ["反向证据", report.opposing],
        ["风险", report.risks],
        ["缺失数据", report.missing],
        ["下一步", report.nextSteps],
      ]
        .map(
          ([title, items]) =>
            `## ${title}\n\n${(items as string[]).map((t) => "- " + t).join("\n")}\n`,
        )
        .join("\n") +
      (report.stages ?? [])
        .map(
          (s) =>
            `\n## ${stageNames[s.id]}\n\n${s.status}：${s.summary}\n\n缺口：${s.missing.join("；")}\n引用：${s.citations.join("、")}\n`,
        )
        .join("\n") +
      `\n## 版本与证据\n\n模型：${report.model}\n提示词：${report.promptVersion}\n技能：${JSON.stringify(report.skills ?? [])}\n批次用量：${JSON.stringify(report.batchUsage ?? null)}\n时间：${stamp(report.createdAt)}\n\n` +
      report.evidence
        .map(
          (e) =>
            `${e.id} | ${e.source} | ${e.asOf}\n\n证据元数据：${JSON.stringify(e.envelope ?? "旧报告未记录")}\n\n${e.text}\n`,
        )
        .join("\n");
    const url = URL.createObjectURL(
        new Blob([markdown], { type: "text/markdown;charset=utf-8" }),
      ),
      link = document.createElement("a");
    link.href = url;
    link.download = `研究报告-${report.createdAt}.md`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <article className="report-card">
      <div className="eyebrow">
        <Sparkles size={13} /> AI 研究 · {stamp(report.createdAt)}
        <Button size="sm" variant="ghost" onClick={download}>
          <ArrowDownToLine size={13} />
          导出报告
        </Button>
      </div>
      <p
        className="muted"
        title={
          securityContext
            ? archivedNameHint(
                securityContext.symbol,
                names,
                securityContext.archivedName,
              )
            : undefined
        }
      >
        {securityContext
          ? `关联证券：${securityDisplayName(securityContext.symbol, names, securityContext.archivedName)} · ${securityContext.symbol.toUpperCase()}`
          : "未确认关联证券"}
      </p>
      <h3>{report.title}</h3>
      <p>{report.summary}</p>
      {report.stages?.map((stage) => (
        <section key={stage.id}>
          <h4>
            {stageNames[stage.id]} ·{" "}
            {stage.status === "supported"
              ? "证据支持"
              : stage.status === "contradicted"
                ? "存在反证"
                : "证据不足"}
          </h4>
          <p>{stage.summary}</p>
          {stage.missing.length > 0 && <p>缺口：{stage.missing.join("；")}</p>}
          <small>引用：{stage.citations.join("、")}</small>
        </section>
      ))}
      <div className="report-grid">
        {[
          ["支持证据", report.supporting],
          ["反向证据", report.opposing],
          ["主要风险", report.risks],
          ["待补充数据", report.missing],
          ["下一步观察", report.nextSteps],
        ].map(([title, items]) => (
          <div key={title as string}>
            <h4>{title as string}</h4>
            <ul>
              {(items as string[]).map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <details>
        <summary>查看证据与版本</summary>
        <p className="muted">
          {report.model} · {report.promptVersion} ·{" "}
          {report.batchUsage
            ? `本批 ${report.batchUsage.tokens} tokens / ${report.batchUsage.reports} 份报告`
            : `${report.tokens} tokens`}
        </p>
        {report.skills?.map((skill) => (
          <div key={skill.skillId}>
            <strong>
              {skill.skillId} · {skill.ruleVersion} · {skill.outputSchema}
            </strong>
            <p>前提：{skill.prerequisites.join("；")}</p>
            <pre>
              {skill.files
                .map((file) => `${file.file}: ${file.hash}`)
                .join("\n")}
            </pre>
          </div>
        ))}
        {report.evidence.map((e) => (
          <div key={e.id}>
            <strong>
              {e.id} · {e.source} · {e.asOf}
            </strong>
            <pre>{e.text}</pre>
            {[
              "hithink-astock-selector/rs",
              "hithink-astock-selector/price-rs",
            ].includes(e.envelope?.source ?? "") && (
              <RsSourceDownload reportId={report.id} evidence={e} />
            )}
            {e.envelope && (
              <div>
                <p>
                  数据时点：{e.envelope.asOf ?? "未核验"} · 抓取时间：
                  {stamp(e.envelope.fetchedAt)}
                </p>
                <p>{e.envelope.warnings.join("；")}</p>
                <details>
                  <summary>来源与口径</summary>
                  <pre>{JSON.stringify(e.envelope, null, 2)}</pre>
                </details>
              </div>
            )}
          </div>
        ))}
      </details>
    </article>
  );
}
