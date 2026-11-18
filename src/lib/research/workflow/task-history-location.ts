import { z } from "zod";
import { taskHistoryInput } from "./task-history";

const filterSchema = taskHistoryInput.omit({ cursor: true });
export type TaskHistoryFilter = z.infer<typeof filterSchema>;
type TaskHistoryLocation = {
  filter: TaskHistoryFilter;
  error: string;
  detailId?: string;
};

export function readTaskHistoryLocation(search: string): TaskHistoryLocation {
  const params = new URLSearchParams(search);
  const result = filterSchema.safeParse({
    status: params.get("status") ?? undefined,
    type: params.get("type") ?? undefined,
    id: params.get("id") ?? undefined,
  });
  if (!result.success) {
    return {
      filter: {} as TaskHistoryFilter,
      error: "任务筛选链接无效，请清除筛选后重试。",
    };
  }
  // Only an exact valid identifier plus an explicit detail marker requests an
  // automatic open; every other location keeps its previous filter-only shape.
  return params.get("detail") === "1" && result.data.id
    ? { filter: result.data, error: "", detailId: result.data.id }
    : { filter: result.data, error: "" };
}

export function taskHistoryHref(filter: TaskHistoryFilter) {
  const params = new URLSearchParams();
  if (filter.status) params.set("status", filter.status);
  if (filter.type) params.set("type", filter.type);
  if (filter.id) params.set("id", filter.id);
  return `/system/tasks${params.size ? `?${params}` : ""}`;
}
