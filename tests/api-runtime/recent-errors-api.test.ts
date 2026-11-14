import { expect, it } from "vitest";
import { appRouter } from "~/server/api/root";
import { recordRuntimeError } from "~/server/infra/runtime-errors";
it("exposes bounded diagnostics through the task read capability", async () => {
  expect(appRouter._def.procedures.recentErrors._def.meta).toEqual({
    capability: "tasks",
    operation: "read",
  });
  recordRuntimeError(
    "scheduler-tick",
    Object.assign(new Error("authorization-secret"), { code: "SQLITE_BUSY" }),
  );
  const result = await appRouter
    .createCaller({ headers: new Headers() })
    .recentErrors();
  expect(result.available).toBe(true);
  expect(result.entries).toEqual([
    expect.objectContaining({ code: "SQLITE_BUSY", module: "调度服务" }),
  ]);
  expect(JSON.stringify(result)).not.toContain("authorization-secret");
});
