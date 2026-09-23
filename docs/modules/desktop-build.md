# 桌面与构建交付

## 职责与非职责

Electron 主进程创建窗口/托盘、分配本地端口、启动并停止 standalone Node server；Node server 承载 Next 与数据库/领域服务；runtime 目录是 worker 和原生依赖的构建产物来源。桌面宿主不承载业务逻辑，生成产物不作为源码编辑点。

## 入口与消费者

- 源码入口 `electron/main.ts` 由 `scripts/build-runtime.mjs` bundle 成 `desktop/main.cjs`，`package.json` 的 `main` 指向后者。
- Next 独立构建后由 `scripts/prepare-desktop.mjs` 拷贝 static/public/runtime/node，并写入 BUILD_ID marker。
- worker 构建清单在 `scripts/build-runtime.mjs`；`runtime/*.cjs`、`runtime/czsc/` 及 native module 是输出/随包资产。
- `electron-builder.yml` 声明桌面包的文件与资源范围；smoke 入口为 `scripts/desktop-smoke.mjs`。

## 契约与依赖

主进程通过 loopback health endpoint 确认服务可用；`QUANT_DATA_DIR` 可覆盖用户数据目录；worker dir 指向随包 runtime。退出时要停止服务进程树。打包前服务必须已停止，准备脚本仅操作 `.next/standalone`；正式桌面准备/交付需按授权和目录规则执行。

## 状态、副作用与验证

构建会覆盖/生成 `.next`、`desktop/main.cjs`、`runtime` 产物；Electron 启动会创建用户数据目录及日志并启动子进程。代表测试：[t4-desktop-guards](../../tests/desktop-build/t4-desktop-guards.test.ts)；运行入口 `pnpm desktop:smoke`。桌面交付再按要求执行 `pnpm desktop:prepare`，实际启动/打包状态须分别报告。

## 维护指南

新增 worker 需登记源码入口、bundle 格式、external 依赖、宿主加载路径与关闭/重启语义。运行时 DLL 由 vendor 固定资产复制，不自行替换或移植算法。未获打包授权不运行 pack，也不在应用运行中覆盖 release。
