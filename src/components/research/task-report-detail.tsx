"use client";
import Link from "next/link";
import { ReadingLayout } from "../common/reading-layout";
import { Component, useEffect, useState, type ReactNode } from "react";
import { archiveReturnHref } from "~/lib/research/workflow/archive-navigation";
import { api } from "~/trpc/react";
import { Button } from "../ui/button";
import { ReportCard } from "../workbench/reports";

function GeneralReport({ id }: { id: string }) {
  const detail = api.archivedReport.useQuery(id, {
    retry: false,
    staleTime: 0,
    gcTime: 5 * 60_000,
  });
  const directory = api.securityNames.useQuery(undefined, { staleTime: 60000 });
  return (
    <>
      {detail.isPending && <p role="status">正在读取研究报告…</p>}
      {detail.error && (
        <p role="alert">
          {detail.data
            ? "刷新未成功，以下是上次读取的报告："
            : "报告读取失败："}
          {detail.error.message}{" "}
          <Button onClick={() => void detail.refetch()}>重试报告</Button>
        </p>
      )}
      {detail.data === null && <p>报告不存在或已被清理。</p>}
      {detail.data && (
        <ReportCard
          report={detail.data}
          securityContext={detail.data.securityContext}
          names={directory.data ?? {}}
        />
      )}
    </>
  );
}

export function TaskReportDetail({ kind, id }: { kind: string; id: string }) {
  const [returnHref, setReturnHref] = useState("/reports");
  useEffect(() => setReturnHref(archiveReturnHref(window.location.search)), []);
  return (
    <section className="mx-auto w-full min-w-0 max-w-full space-y-4 break-words p-4 sm:p-6 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:whitespace-pre-wrap [&_pre]:break-all">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">研究报告详情</h1>
        <Button asChild variant="outline">
          <Link href={returnHref} scroll={false}>
            返回研究档案
          </Link>
        </Button>
      </div>
      <details className="rounded-lg border border-nc-border bg-nc-card p-3">
        <summary className="cursor-pointer text-sm text-nc-text-3">
          报告身份与时间口径
        </summary>
        <p className="mt-2 break-all text-sm text-nc-text-3">
          类型：{kind} · 报告 ID：{id} · 历史产物，生成时间不代表数据时点。
        </p>
      </details>
      <ReadingLayout>
        <ArchiveReadBoundary key={`${kind}:${id}`}>
          {kind === "report" && <GeneralReport id={id} />}
        </ArchiveReadBoundary>
      </ReadingLayout>
    </section>
  );
}

/** Old or damaged persisted reports must not take down the workbench. */
class ArchiveReadBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <p role="alert">
        报告格式无法读取，原始档案未被修改。
        <Button onClick={() => window.location.reload()}>重新读取报告</Button>
      </p>
    ) : (
      this.props.children
    );
  }
}
