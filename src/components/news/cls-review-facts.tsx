"use client";
import { ClsSelect } from "./cls-review-fields";
import { ClsReviewText } from "./cls-review-text";
import { useState } from "react";
import { api } from "~/trpc/react";
import type { ClsFactDraft } from "~/lib/news/cls-review-workspace";
import type { ClsReportArchive } from "~/server/news/cls-review-store";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { ClsError, ClsPages, clsPct, clsTime } from "./cls-review-fields";
export function ClsReviewFacts({
  report,
  visible,
  draft,
  change,
  saved,
}: {
  report: ClsReportArchive;
  visible: boolean;
  draft: ClsFactDraft;
  change: (patch: Partial<ClsFactDraft>) => void;
  saved: (id: string, revision: number) => void;
}) {
  const utils = api.useUtils();
  const [mode, setMode] = useState<"current" | "history">("current");
  const [verdict, setVerdict] = useState<ClsFactDraft["verdict"] | "all">(
    "all",
  );
  const [pages, setPages] = useState<(string | undefined)[]>([undefined]);
  const [feedback, setFeedback] = useState("");
  const [anchor, setAnchor] = useState<{
    sectionId: string;
    quote: string;
    token: number;
  } | null>(null);
  const [fullOpen, setFullOpen] = useState(false);
  const facts = api.clsReviewFactPage.useQuery(
    {
      reportId: report.id,
      mode,
      verdict: verdict === "all" ? undefined : verdict,
      cursor: pages.at(-1),
    },
    { enabled: visible, gcTime: 0 },
  );
  const save = api.clsReviewSaveFact.useMutation();
  const section = report.report.sections.find(
    (row) => row.id === draft.sectionId,
  );
  async function submit() {
    const revision = draft.revision,
      id = report.id;
    try {
      await save.mutateAsync({
        reportId: id,
        sectionId: draft.sectionId,
        quote: draft.quote,
        evidence: draft.evidence,
        verdict: draft.verdict,
      });
      saved(id, revision);
      await utils.clsReviewFactPage.invalidate(
        { reportId: id },
        { refetchType: "active" },
      );
      setFeedback("事实核对已保存，历史记录已保留");
    } catch {
      /* Mutation error is rendered; keep the draft. */
    }
  }
  return (
    <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-2">
        <section className="min-w-0 space-y-2" aria-label="报告原文">
          <label className="block text-sm">
            原文章节
            <ClsSelect
              label="原文章节"
              value={draft.sectionId}
              onChange={(value) => change({ sectionId: value })}
              placeholder="选择章节"
              options={report.report.sections.map((row) => ({
                value: row.id,
                label: row.name,
              }))}
            />
          </label>
          {section ? (
            <>
              <p className="text-xs text-nc-text-3">
                原文第 {section.line}—{section.endLine} 行；重复摘录按章节定位。
              </p>
              <div
                id="cls-section-text"
                tabIndex={0}
                className="min-w-0 rounded outline-offset-2"
              >
                <ClsReviewText
                  key={`${section.id}:${anchor?.token ?? 0}`}
                  text={section.text}
                  label="章节原文"
                  locate={
                    anchor?.sectionId === section.id ? anchor.quote : undefined
                  }
                />
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  const selection = window.getSelection();
                  const node = document.getElementById("cls-section-text");
                  if (
                    selection?.anchorNode &&
                    selection.focusNode &&
                    node?.contains(selection.anchorNode) &&
                    node.contains(selection.focusNode)
                  ) {
                    const quote = selection.toString().trim();
                    if (
                      quote &&
                      quote.length <= 3000 &&
                      section.text.includes(quote)
                    )
                      change({ quote });
                  }
                }}
              >
                将选中文字填入摘录
              </Button>
            </>
          ) : (
            <p className="text-sm text-nc-text-3">选择章节后阅读并核对原文。</p>
          )}
          <details onToggle={(event) => setFullOpen(event.currentTarget.open)}>
            <summary className="cursor-pointer text-sm">完整已保存原文</summary>
            {fullOpen && (
              <ClsReviewText text={report.report.markdown} label="完整原文" />
            )}
          </details>
        </section>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className="block text-sm">
            核对结果
            <ClsSelect
              label="核对结果"
              value={draft.verdict}
              onChange={(value) =>
                change({ verdict: value as ClsFactDraft["verdict"] })
              }
              options={[
                { value: "unresolved", label: "待核对" },
                { value: "supported", label: "有依据支持" },
                { value: "contradicted", label: "被反证" },
              ]}
            />
          </label>
          <label className="block text-sm">
            事实原文摘录
            <Textarea
              aria-label="事实原文摘录"
              required
              maxLength={3000}
              value={draft.quote}
              onChange={(event) => change({ quote: event.target.value })}
            />
          </label>
          <label className="block text-sm">
            核对依据
            <Textarea
              aria-label="核对依据"
              required
              maxLength={5000}
              value={draft.evidence}
              onChange={(event) => change({ evidence: event.target.value })}
            />
          </label>
          <p className="text-xs text-nc-text-3">
            填写公告、原始来源，或无法核实的原因。切换报告会保留本会话草稿。
          </p>
          <Button
            disabled={
              !section ||
              !draft.quote.trim() ||
              !draft.evidence.trim() ||
              save.isPending
            }
          >
            {save.isPending ? "正在保存…" : "保存事实核对"}
          </Button>
          <ClsError error={save.error} />
          <p role="status" className="text-sm">
            {feedback}
          </p>
        </form>
      </div>
      <section className="space-y-2" aria-label="事实核对记录">
        <h3 className="text-sm font-semibold">事实核对记录</h3>
        {facts.data && (
          <p className="text-sm">
            全报告当前结论：支持 {facts.data.statistics.supported} · 反证{" "}
            {facts.data.statistics.contradicted} · 待核对{" "}
            {facts.data.statistics.unresolved} · 已核对支持率{" "}
            {clsPct(facts.data.statistics.supportRate)}
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          <label className="text-sm">
            记录范围{" "}
            <ClsSelect
              label="记录范围"
              value={mode}
              onChange={(value) => {
                setMode(value as typeof mode);
                setPages([undefined]);
              }}
              options={[
                { value: "current", label: "当前结论" },
                { value: "history", label: "全部追加历史" },
              ]}
            />
          </label>
          <label className="text-sm">
            结论筛选{" "}
            <ClsSelect
              label="结论筛选"
              value={verdict}
              onChange={(value) => {
                setVerdict(value as typeof verdict);
                setPages([undefined]);
              }}
              options={[
                { value: "all", label: "全部" },
                { value: "supported", label: "有依据支持" },
                { value: "contradicted", label: "被反证" },
                { value: "unresolved", label: "待核对" },
              ]}
            />
          </label>
        </div>
        <ClsError error={facts.error} retry={() => void facts.refetch()} />
        {facts.isLoading ? (
          <p role="status">正在读取事实核对…</p>
        ) : facts.data?.items.length === 0 ? (
          <p className="text-sm">没有符合条件的核对记录。</p>
        ) : null}
        {facts.data?.items.map((fact) => (
          <article
            key={fact.id}
            className="space-y-1 border-t border-nc-border-soft py-2 text-sm"
          >
            <p>{fact.quote}</p>
            <p>
              {fact.verdict === "supported"
                ? "有依据支持"
                : fact.verdict === "contradicted"
                  ? "被反证"
                  : "待核对"}{" "}
              · {clsTime(fact.reviewedAt)}
            </p>
            <p className="whitespace-pre-wrap break-words">{fact.evidence}</p>
            {!!fact.truncated && (
              <ClsFactFull
                reportId={report.id}
                id={fact.id}
                visible={visible}
              />
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                change({ sectionId: fact.sectionId });
                setAnchor((value) => ({
                  sectionId: fact.sectionId,
                  quote: fact.quote,
                  token: (value?.token ?? 0) + 1,
                }));
                requestAnimationFrame(() =>
                  document.getElementById("cls-section-text")?.focus(),
                );
              }}
            >
              回到原文章节
            </Button>
          </article>
        ))}
        <ClsPages
          count={pages.length}
          more={facts.data?.hasMore ?? false}
          busy={facts.isFetching || !!facts.error}
          previous={() => setPages((value) => value.slice(0, -1))}
          next={() => {
            if (facts.data?.nextCursor)
              setPages((value) => [...value, facts.data.nextCursor!]);
          }}
        />
      </section>
    </div>
  );
}

function ClsFactFull({
  reportId,
  id,
  visible,
}: {
  reportId: string;
  id: string;
  visible: boolean;
}) {
  const [open, setOpen] = useState(false);
  const detail = api.clsReviewFactDetail.useQuery(
    { reportId, id },
    { enabled: visible && open, gcTime: 0 },
  );
  return (
    <div>
      <Button
        size="sm"
        variant="outline"
        onClick={() => setOpen((value) => !value)}
      >
        {open ? "收起完整事实证据" : "摘要已截短，读取完整事实证据"}
      </Button>
      {open && (
        <>
          <ClsError error={detail.error} retry={() => void detail.refetch()} />
          {detail.isLoading ? (
            <p>正在读取…</p>
          ) : detail.data ? (
            <div className="whitespace-pre-wrap break-words">
              <p>{detail.data.quote}</p>
              <p>{detail.data.evidence}</p>
            </div>
          ) : (
            <p>记录已不存在。</p>
          )}
        </>
      )}
    </div>
  );
}
