# 工程工具与验证

## 职责与非职责

`scripts/` 为构建、迁移、数据校验、桌面准备和受控操作入口；`tests/` 为行为、契约、worker 和结构边界证据；各 workspace package 维护独立源码、构建和测试。验证目录不拥有生产逻辑；清理历史衍生结果时保留原始输入与正式包。

## 入口与消费者

- 根命令以 [package.json](../../package.json) scripts 为准：`typecheck`、`test`、`build`、`runtime:build`、`desktop:prepare`、`desktop:smoke`、`format:check`。
- `tests/<module>/` 按领域保存持久 `.test/.spec` 用例；`fixtures/`、共享 helpers、snapshots 与 setup 留在 `tests/` 公共层。
- `src-organization.test.ts`、`server-layout.test.ts` 保护已裁定的目录约束；workspace packages 各有 README 与测试命令。

## 契约与依赖

运行验证按 [operations](../operations.md) 的分层和改动风险选择，并对照 [invariants](../invariants.md) 与对应模块说明；命令可能打开 DB、构建 runtime 或读外部本地文件。数据库验证先设置隔离 `QUANT_DATA_DIR`；通达信和外部 Blocks 只读；网络/通知测试确认无未授权真实投递。`pnpm test` 运行根 Vitest 并显式运行策略 package 的 tests，package 子项目另有自有检查。

## 副作用与验证

测试 setup 会按需建临时 DB 目录；构建写入 `.next`、`runtime` 和桌面 prepare 目录；部分验收脚本可读本机数据或访问网络，必须先看具体脚本。代表结构检查：[src-organization](../../tests/engineering-validation/src-organization.test.ts)、[server-layout](../../tests/engineering-validation/server-layout.test.ts)；执行规则见 [operations](../operations.md)。

Vitest 的项目划分、并行度与超时以 [vitest.config.ts](../../vitest.config.ts) 和 `scripts/lib/test-projects.ts` 为准：`pure` 为不触及可写 IO 的文件，`io` 为其余文件。`io` 能并行的前提是 `tests/setup-data-dir.ts` 为每个测试文件单独创建 `QUANT_DATA_DIR`。新增测试若会写入每个文件隔离目录以外的共享位置（固定临时文件名、仓库文件、固定端口、全局进程），必须自行隔离；做不到时在配置中单独加串行项目并写明理由。测试发现不能漏项：移动或新增测试后核对 runner 与实际路径，排除 fixtures。

## 维护指南

持久用例归 `tests/<module>/` 或相应 package 测试，不因搬迁减少发现数。改变测试路径时同步更新相对 fixture、脚本、覆盖率、CI/命令发现规则和文档。结构护栏保护模块归属、目录公共入口和服务端依赖方向；不建立另一套全语言静态分析器。
