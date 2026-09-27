# czsc-tdx 缠论计算 DLL

| 项 | 值 |
|---|---|
| 来源仓库 | `D:\github\czsc-tdx` |
| 来源 commit | `56d0d8f`（分支 `dev`，`czsc_build_commit()` 返回 `56d0d8f4729b`）：新 core/ + tdx/ 引擎与结构化 C API `adapter/czsc_api.h`（api v6：P0 基础结构、P1 研判语义、走势完成证据、区间套、递归节点/中枢/连接段、中阴、中枢成立时刻、逐根 MA5/MA20、构建 commit）。旧 Func30 接口已删除 |
| 文件 | `CZSC64.dll`（x64，静态链接 MinGW 运行时，自包含） |
| 大小 | `954260` 字节 |
| SHA-256 | `0f98600f7bcddff039d33216e13b5056983c6647c58704fc6f234d68845e807a` |
| 构建方式 | 来源仓库 `build/CZSC64.dll`（2026-09-27 12:42，make 构建，工作区干净），MinGW-w64 x64 |
| 许可 | GNU GPL v3（Copyright 2016, Martin Tang） |

## 为什么是重建的

来源仓库 `build/` 目录已在 commit `b67f3c6` 被加入 .gitignore，其中残留的
预编译 DLL（SHA-256 `cf560156…1206c`，802,636 字节）**早于**
`cbd3f91 feat: expand formula packages for full Func30 output surface`，
导出面与当前源码不符，导致 golden 比对失败。重建后大 46KB。

已用 `make sse-result-check` 确认当前源码重新生成的 `czsc_sse_result.txt`
与仓库已提交版本逐字节一致，即**源码与 golden 自洽**，此前唯一过期的是 DLL。

## 为什么放这里

`runtime/` 在 `.gitignore` 中且由 `pnpm runtime:build` 生成，不适合存放版本化资产。
本目录是 git 跟踪的事实来源；`scripts/build-runtime.mjs` 复制到
`runtime/czsc/CZSC64.dll`，`scripts/prepare-desktop.mjs` 已递归拷贝整个 `runtime/`，
桌面分发自动包含。

## 许可提示

源码头部为 GPL v3，来源仓库 README 声明「免费分享使用，没有任何限制」。
**私有仓库保存副本不构成分发。** 若要捆绑进对外分发的 `GuanlanQuant.exe`，
需先确认 GPL v3 义务。该决策由用户作出。
