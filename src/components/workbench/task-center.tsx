import { Workflow } from "lucide-react";
import { TaskHistory } from "../common/task-history";
import { type WorkbenchState } from "./use-workbench-state";

export function TaskCenter({
  state,
}: {
  state: Pick<WorkbenchState, "selectFormulaJob" | "setTab">;
}) {
  return (
    <section className="task-bar">
      <div className="panel-title">
        <Workflow size={16} />
        <h3>全部任务</h3>
      </div>
      <TaskHistory
        onOpenScreen={(id) => {
          state.selectFormulaJob(id);
          state.setTab("screen");
        }}
      />
    </section>
  );
}
