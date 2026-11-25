import { expect, it } from "vitest";
import { put, sqlite } from "~/server/db";
import { taskEvidence } from "~/server/db/task-evidence";
import { taskState } from "~/server/db/task-history";

const id = "job-diagnose-evidence";
const archiveId = `lab-${id}`;
const job = {
  id,
  type: "backtest",
  input: { type: "lab-diagnose" },
  status: "completed",
  progress: 100,
  createdAt: 1,
  updatedAt: 2,
  result: {
    archiveId,
    title: "分组诊断",
    strategyKeys: ["research-chan"],
    symbols: ["sh600000", "sh600519"],
    scenarios: ["strict", "clamp"],
    statusCounts: { ok: 2, blocked: 1, failed: 1, zeroSignal: 1 },
    boundaryState: "blocked",
    driftWarningsCount: 3,
    missingFilesCount: 0,
  },
};

it("从任务摘要直接读取诊断证据与归档链接，无需磁盘归档", () => {
  put("job", id, job);
  expect(sqlite().pragma("user_version", { simple: true })).toBe(25);
  expect(taskState(id)).toMatchObject({
    localEvidence: true,
    sourceLink: { href: "/lab/backtest" },
    resultLink: {
      href: `/lab/backtest?archive=${archiveId}`,
      label: "查看诊断归档",
    },
  });
  const evidence = taskEvidence(id);
  expect(evidence?.kind).toBe("lab-diagnose");
  expect(evidence?.boundary).toContain("零信号");
  expect(
    Object.fromEntries(
      evidence!.fields.map(({ label, value }) => [label, value]),
    ),
  ).toEqual({
    策略: "research-chan",
    标的: "sh600000、sh600519",
    执行情景: "strict、clamp",
    状态汇总: "正常 2 · 阻断 1 · 失败 1 · 零信号 1",
    归档状态: "blocked",
    漂移警告: "3",
    缺失文件: "0",
    归档编号: archiveId,
  });
});

it.each(["queued", "running", "failed", "cancelled"])(
  "%s 状态即使带回执也不显示诊断结果",
  (status) => {
    put("job", id, { ...job, status });
    expect(taskEvidence(id)).toBeNull();
    expect(taskState(id)?.resultLink).toBeUndefined();
  },
);

it("旧回执保留归档入口与未知计数，非法归档编号不生成入口", () => {
  put("job", id, { ...job, result: { archiveId } });
  expect(taskEvidence(id)?.fields).toContainEqual({
    label: "缺失文件",
    value: "未知",
  });
  expect(taskState(id)?.resultLink?.href).toBe(
    `/lab/backtest?archive=${archiveId}`,
  );
  put("job", id, { ...job, result: { archiveId: "../another" } });
  expect(taskState(id)?.resultLink).toBeUndefined();
});

it("已完成任务不能链接到另一任务格式合法的归档", () => {
  const reportId = "unrelated-replay";
  put("financial-replay", reportId, { input: { symbols: ["sh600000"] } });
  put("job", id, {
    ...job,
    result: { ...job.result, archiveId: "lab-job-other", reportId },
  });
  expect(taskState(id)?.resultLink).toBeUndefined();
});
