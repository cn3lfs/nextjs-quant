import { z } from "zod";
import { taskHistoryInput } from "./task-history";

const filterSchema = taskHistoryInput.omit({ cursor: true });
export type TaskHistoryFilter = z.infer<typeof filterSchema>;

export function readTaskHistoryLocation(search: string) {
  const params = new URLSearchParams(search);
  const result = filterSchema.safeParse({
    status: params.get("status") ?? undefined,
    type: params.get("type") ?? undefined,
    id: params.get("id") ?? undefined,
  });
  return result.success
    ? { filter: result.data, error: "" }
    : {
        filter: {} as TaskHistoryFilter,
        error: "任务筛选链接无效，请清除筛选后重试。",
      };
}

export function taskHistoryHref(filter: TaskHistoryFilter) {
  const params = new URLSearchParams();
  if (filter.status) params.set("status", filter.status);
  if (filter.type) params.set("type", filter.type);
  if (filter.id) params.set("id", filter.id);
  return `/system/tasks${params.size ? `?${params}` : ""}`;
}
