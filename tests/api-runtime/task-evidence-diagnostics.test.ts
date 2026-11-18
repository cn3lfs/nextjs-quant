import { expect, it, vi } from "vitest";
import { put } from "~/server/db";
import { taskEvidence } from "~/server/db/task-evidence";

it("shows unknown closes and missing periods even with no fills, without parsing bulk evidence", () => {
  put("job", "empty-triple-evidence", {
    status: "completed",
    input: { type: "lab-backtest" },
    result: {
      result: { fills: [] },
      overview: { totalReturn: { value: 0 }, maxDrawdown: { value: 0 } },
      inputDiagnostics: [
        { evaluated: 10, unknown: 7, reasons: { gap: 7 } },
        { evaluated: 20, unknown: 2 },
      ],
      frozen: {
        boundary: "规则自检",
        sources: [
          { missing: { execution: 3, setup: 2, background: 1 } },
          { missing: { execution: 4, setup: 0, background: 2 } },
        ],
        request: { archive: "BULK-EVIDENCE-".repeat(100000) },
      },
    },
  });
  const parse = vi.spyOn(JSON, "parse");
  try {
    expect(taskEvidence("empty-triple-evidence")).toEqual({
      kind: "lab-backtest",
      boundary: "规则自检",
      fields: [
        { label: "收益", value: "0.00%" },
        { label: "最大回撤", value: "0.00%" },
        { label: "成交", value: "0" },
        { label: "已评估收盘", value: "30" },
        { label: "未知判定", value: "9" },
        { label: "执行周期缺槽", value: "7" },
        { label: "准备周期缺槽", value: "2" },
        { label: "背景周期缺槽", value: "3" },
      ],
    });
    expect(
      parse.mock.calls.some(([value]) =>
        String(value).includes("BULK-EVIDENCE-"),
      ),
    ).toBe(false);
  } finally {
    parse.mockRestore();
  }
});

it("preserves absent diagnostics while displaying explicit known zero counts", () => {
  for (const withDiagnostics of [false, true]) {
    const id = `task-evidence-${withDiagnostics}`;
    put("job", id, {
      status: "completed",
      input: { type: "lab-backtest" },
      result: {
        result: { fills: [] },
        ...(withDiagnostics
          ? {
              inputDiagnostics: [{ evaluated: 2, unknown: 0 }],
              frozen: {
                sources: [
                  { missing: { execution: 0, setup: 0, background: 0 } },
                ],
              },
            }
          : {}),
      },
    });
    const fields = taskEvidence(id)!.fields;
    expect(fields).toHaveLength(withDiagnostics ? 8 : 3);
    if (withDiagnostics)
      expect(fields.slice(4).every((field) => field.value === "0")).toBe(true);
  }
});
