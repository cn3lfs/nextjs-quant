import { expect, it } from "vitest";
import {
  readTaskHistoryLocation,
  taskHistoryHref,
} from "~/lib/research/workflow/task-history-location";
import { useTaskSession } from "~/lib/stores/task-history-session";

it("shares exact task filters without treating an identifier as a query fragment", () => {
  const filter = {
    status: "failed" as const,
    type: "screen" as const,
    id: "job?x=1& y/中文",
  };
  const href = taskHistoryHref(filter);
  expect(href).toContain("id=job%3Fx%3D1%26+y%2F");
  expect(
    readTaskHistoryLocation(new URL(href, "http://fixture").search),
  ).toEqual({
    filter,
    error: "",
  });
  expect(taskHistoryHref({})).toBe("/tasks");
});

it.each([
  "status=unknown",
  "type=unrecognized",
  "id=",
  `id=${"x".repeat(201)}`,
])("rejects invalid task filters: %s", (search) => {
  expect(readTaskHistoryLocation(search).error).not.toBe("");
});

it("keeps pending cancellation across consumers and allows a retry after failure", () => {
  useTaskSession.setState({ cancellations: {} });
  expect(useTaskSession.getState().beginCancel("task-a")).toBe(true);
  expect(useTaskSession.getState().beginCancel("task-a")).toBe(false);
  expect(useTaskSession.getState().beginCancel("task-b")).toBe(true);
  useTaskSession.getState().finishCancel("task-a", { error: "offline" });
  expect(useTaskSession.getState().cancellations["task-a"]).toEqual({
    error: "offline",
  });
  expect(useTaskSession.getState().beginCancel("task-a")).toBe(true);
  useTaskSession.setState({ cancellations: {} });
});
