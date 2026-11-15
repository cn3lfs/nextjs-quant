import { notFound } from "next/navigation";
import { TaskReportDetail } from "~/components/research/task-report-detail";

export default async function TaskReportPage({
  params,
}: {
  params: Promise<{ kind: string; id: string }>;
}) {
  const { kind, id } = await params;
  if (kind !== "report" || !id || id.length > 200) notFound();
  return <TaskReportDetail kind={kind} id={id} />;
}
