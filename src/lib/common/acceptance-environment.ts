/** Only explicit acceptance-server profiles mark synthetic UI; never infer from a data path. */
export function acceptanceEnvironment(profile: string | undefined) {
  return ["core", "pool", "workbench"].includes(profile ?? "")
    ? "隔离验收环境 · 含合成测试数据 · 非正式工作区"
    : null;
}
