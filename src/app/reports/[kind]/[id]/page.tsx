import { notFound } from "next/navigation";
import { TaskReportDetail } from "~/components/task-report-detail";

export default async function TaskReportPage({
  params,
}: {
  params: Promise<{ kind: string; id: string }>;
}) {
  const { kind, id } = await params;
  if (
    !["report", "chan-report", "canslim-report", "wyckoff-report"].includes(
      kind,
    ) ||
    !id ||
    id.length > 200
  )
    notFound();
  if (kind !== "report" && !new RegExp(`^${kind}-[a-f0-9]{64}$`).test(id))
    notFound();
  return <TaskReportDetail kind={kind} id={id} />;
}
