import {
  ArchiveEvidence,
  ArchiveMetadata,
  ArchiveText,
} from "../research/archive-evidence";
import { DownloadSimple, Sparkle } from "@phosphor-icons/react/ssr";
import { type Report } from "~/lib/domain";
import {
  archivedNameHint,
  securityDisplayName,
} from "~/lib/market/security-display";
import { RsSourceDownload } from "../market/rs-source-download";
import { StageCards } from "../panels";
import { Button } from "../ui/button";

import { archiveStamp as stamp } from "../research/archive-evidence";
import { useArchiveDownload } from "../research/use-archive-download";

export function ReportCard({
  report,
  securityContext,
  names,
}: {
  report: Report;
  securityContext: { symbol: string; archivedName?: string } | null;
  names: Record<string, string>;
}) {
  const exporter = useArchiveDownload();
  const stageNames = {
    market: "市场与行业",
    fundamentals: "基本面",
    trend: "趋势与相对强度",
    vcp: "VCP形态",
    "entry-risk": "入场与风险",
    conclusion: "综合结论",
  };
  function download() {
    exporter.save(
      () =>
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
        `\n## 版本与证据\n\n模型：${report.model || "未记录"}\n提示词：${report.promptVersion || "未记录"}\n技能：${JSON.stringify(report.skills ?? [])}\n批次用量：${JSON.stringify(report.batchUsage ?? null)}\n时间：${stamp(report.createdAt)}\n\n` +
        report.evidence
          .map(
            (e) =>
              `${e.id} | ${e.source} | ${e.asOf}\n\n证据元数据：${JSON.stringify(e.envelope ?? "旧报告未记录")}\n\n${e.text}\n`,
          )
          .join("\n"),
      `研究报告-${report.createdAt}.md`,
      "text/markdown;charset=utf-8",
    );
  }
  return (
    <article className="report-card">
      {exporter.error && <p role="alert">{exporter.error}</p>}
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-nc-text-4">
        <Sparkle size={13} className="text-nc-accent" /> AI 研究 ·{" "}
        {stamp(report.createdAt)}
        <span
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
          ·{" "}
          {securityContext
            ? `关联证券：${securityDisplayName(securityContext.symbol, names, securityContext.archivedName)} · ${securityContext.symbol.toUpperCase()}`
            : "未确认关联证券"}
        </span>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          onClick={download}
        >
          <DownloadSimple size={13} />
          导出报告
        </Button>
      </div>
      <ArchiveMetadata
        createdAt={report.createdAt}
        model={report.model}
        version={report.promptVersion}
      />
      <h3 className="nc-report-headline mt-2">{report.title}</h3>
      <p className="nc-report-summary">{report.summary}</p>
      {report.stages && report.stages.length > 0 && (
        <StageCards
          stages={report.stages.map((stage) => ({
            key: stage.id,
            title: stageNames[stage.id],
            status:
              stage.status === "supported"
                ? "support"
                : stage.status === "contradicted"
                  ? "counter"
                  : "insufficient",
            body: stage.summary,
            note: [
              stage.missing.length > 0
                ? `缺口：${stage.missing.join("；")}`
                : "",
              `引用：${stage.citations.join("、")}`,
            ]
              .filter(Boolean)
              .join(" · "),
          }))}
        />
      )}
      <div className="report-grid mt-3">
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
      <ArchiveEvidence title="查看证据与版本">
        {() => (
          <>
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
                <ArchiveText text={e.text} />
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
          </>
        )}
      </ArchiveEvidence>
    </article>
  );
}
