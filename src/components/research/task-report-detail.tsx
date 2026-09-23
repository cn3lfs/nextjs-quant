"use client";
import Link from "next/link";
import { api } from "~/trpc/react";
import { Button } from "../ui/button";
import { ReportCard } from "../workbench/reports";
import { ChanPanel } from "./chan-panel";
import { CanslimPanel } from "./canslim-panel";
import { WyckoffPanel } from "./wyckoff-panel";

function GeneralReport({ id }: { id: string }) {
  const detail = api.archivedReport.useQuery(id, { retry: false });
  const directory = api.securityNames.useQuery(undefined, { staleTime: 60000 });
  return (
    <>
      {detail.isPending && <p role="status">正在读取研究报告…</p>}
      {detail.error && (
        <p role="alert">
          报告读取失败：{detail.error.message}{" "}
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
  return (
    <section className="mx-auto w-full max-w-6xl space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">研究报告详情</h1>
        <Button asChild variant="outline">
          <Link href="/" scroll={false}>
            返回工作台
          </Link>
        </Button>
      </div>
      {kind === "report" && <GeneralReport id={id} />}
      {kind === "chan-report" && (
        <ChanPanel key={id} archive initialReportId={id} />
      )}
      {kind === "canslim-report" && (
        <CanslimPanel key={id} archive initialReportId={id} />
      )}
      {kind === "wyckoff-report" && (
        <WyckoffPanel key={id} archive initialReportId={id} />
      )}
    </section>
  );
}
