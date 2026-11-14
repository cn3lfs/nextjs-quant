import { connection } from "next/server";
import { TaskCenter } from "~/components/workbench/task-center";

export default async function TasksPage() {
  // Filters depend on the incoming URL. Render the controls with that URL
  // instead of prerendering a whole-page client-only Suspense fallback.
  await connection();
  return <TaskCenter />;
}
