# V 系列执行日志

管理者：Claude。执行者：codex（`codex exec -s workspace-write`，后台运行）。
立项依据：[个人量化软件调研](../personal-quant-survey.md) 的差距对照。
排期与边界：[next-plan §7](../next-plan.md)。

顺序：V1 → V2 → V3 → V4 → V5，串行。

## 每批的固定流程

1. codex 按任务书实现（后台运行，避开 10 分钟命令超时）
2. 管理者独立跑 `pnpm typecheck` / `pnpm test` / 改动文件的 prettier
3. 管理者审 diff：口径、缺失语义、是否越界、是否动了不该动的
4. 通过则本地提交；不通过则带着具体证据打回
5. 结果记入本文件

沿用 U 系列踩过的坑：跑测试不设 `QUANT_DATA_DIR`；`codex exec` 后台运行；
只保证本批改动文件通过 prettier，不批量修历史文件。

## 授权边界（本系列全程有效）

本地提交、**不推送**；不打包、不接触生产库、不外发、不新增依赖；
除非任务书明确允许，不新增数据库迁移。

## 批次记录

（按批次追加）
