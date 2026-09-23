# 工程工具与验证

## 职责与非职责

`scripts/` 为构建、迁移、数据校验、桌面准备和受控操作入口；`tests/` 为行为、契约、worker 和结构边界证据；workspace packages 各自维护独立源码、构建和测试。验证目录不拥有生产逻辑，也不能清理/重建正式输出或历史证据档案。

## 入口与消费者

- 根命令以 [package.json](../../package.json) scripts 为准：`typecheck`、`test`、`build`、`runtime:build`、`desktop:prepare`、`desktop:smoke`、`format:check`。
- `tests/<module>/` 按领域保存 487 个 `.test/.spec` suites；`fixtures/`、共享 helpers、snapshots 与 setup 留在 `tests/` 公共层。
- `src-organization.test.ts`、`server-layout.test.ts` 保护已裁定的目录约束；workspace packages 各有 README 与测试命令。

## 契约与依赖

运行验证必须读 `docs/operations.md`、`docs/invariants.md` 和对应模块说明；命令可能打开 DB、构建 runtime 或读外部本地文件。数据库验证先设置隔离 `QUANT_DATA_DIR`；通达信和外部 Blocks 只读；网络/通知测试确认无未授权真实投递。`pnpm test` 运行根 Vitest 并显式运行策略 packages 的 tests，package 子项目另有自有检查。

## 副作用与验证

测试 setup 会按需建临时 DB 目录；构建写入 `.next`、`runtime` 和桌面 prepare 目录；部分验收脚本可读本机数据或访问网络，必须先看具体脚本。代表结构检查：[src-organization](../../tests/engineering-validation/src-organization.test.ts)、[server-layout](../../tests/engineering-validation/server-layout.test.ts)；执行规则见 [operations](../operations.md)。

## 维护指南

持久用例归 `tests/<module>/` 或相应 package 测试，不因搬迁减少发现数。改变测试路径时同步更新相对 fixture、脚本、覆盖率、CI/命令发现规则和文档。结构护栏保护模块归属、目录公共入口和服务端依赖方向；不建立另一套全语言静态分析器。
