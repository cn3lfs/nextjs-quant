import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { TaskReportDetail } from "../../src/components/research/task-report-detail";
import TaskReportPage from "../../src/app/reports/[kind]/[id]/page";

const queries = vi.hoisted(() => ({
  calls: [] as { name: string; input: unknown; options: unknown }[],
  missing: false,
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("404");
  },
}));
vi.mock("../../src/trpc/react", () => {
  const query = (name: string) => ({
    useQuery: (input: unknown, options: unknown) => {
      queries.calls.push({ name, input, options });
      return {
        data:
          name === "securityNames" ? {} : queries.missing ? null : undefined,
        isSuccess: queries.missing,
        isLoading: !queries.missing,
        isPending: !queries.missing,
      };
    },
  });
  const mutation = { useMutation: () => ({}) };
  return {
    api: {
      useUtils: () => ({}),
      archivedReport: query("archivedReport"),
      securityNames: query("securityNames"),
      chanReport: query("chanReport"),
      canslimReport: query("canslimReport"),
      wyckoffReport: query("wyckoffReport"),
      chanHistory: query("chanHistory"),
      canslimHistory: query("canslimHistory"),
      wyckoffHistory: query("wyckoffHistory"),
      job: query("job"),
      chanAnalyze: mutation,
      canslimAnalyze: mutation,
      wyckoffAnalyze: mutation,
      cancel: mutation,
    },
  };
});
beforeEach(() => {
  queries.calls.length = 0;
  queries.missing = false;
});

it.each([
  ["report", "archivedReport"],
  ["chan-report", "chanReport"],
  ["canslim-report", "canslimReport"],
  ["wyckoff-report", "wyckoffReport"],
])("opens %s by exact ID without fetching an archive list", (kind, query) => {
  const id = `${kind}-${"a".repeat(64)}`;
  const html = renderToStaticMarkup(
    createElement(TaskReportDetail, { kind: kind!, id }),
  );
  expect(html).toContain("正在读取");
  expect(queries.calls.find((call) => call.name === query)?.input).toBe(id);
  for (const call of queries.calls.filter((call) =>
    call.name.endsWith("History"),
  ))
    expect(call.options).toEqual({ enabled: false });
  expect(html).not.toContain("<select");
});
it.each(["report", "chan-report", "canslim-report", "wyckoff-report"])(
  "shows a missing %s without a stale result",
  (kind) => {
    queries.missing = true;
    const html = renderToStaticMarkup(
      createElement(TaskReportDetail, {
        kind,
        id: `${kind}-${"a".repeat(64)}`,
      }),
    );
    expect(html).toContain("不存在");
  },
);
it("rejects unsupported and malformed destinations before a detail request", async () => {
  for (const params of [
    { kind: "final-validation", id: "sealed" },
    { kind: "chan-report", id: "wrong" },
    { kind: "report", id: "x".repeat(201) },
  ])
    await expect(
      TaskReportPage({ params: Promise.resolve(params) }),
    ).rejects.toThrow("404");
  const page = await TaskReportPage({
    params: Promise.resolve({ kind: "report", id: "exact-report" }),
  });
  expect(page.props).toEqual({ kind: "report", id: "exact-report" });
  expect(queries.calls).toEqual([]);
});
