# czsc-tdx 缠论计算 DLL

| 项 | 值 |
|---|---|
| 来源仓库 | `D:\github\czsc-tdx` |
| 来源 commit | `cf0159c`（分支 `dev`，`czsc_build_commit()` 返回 `cf0159cc7488`）：api v9（结构化接口与 ab31cce 相同）；上游近两次只调整通达信公式与快速买卖点（earlySignals，仅通达信导出启用），C 接口与默认输出不变 |
| 文件 | `CZSC64.dll`（x64，静态链接 MinGW 运行时，自包含） |
| 大小 | `972544` 字节 |
| SHA-256 | `297b0ec6f5f372bf0c89e1ad9682760d04bd66bba09f7ec835460cca922927dd` |
| 构建方式 | 来源仓库 WSL `make mingw64` → `build/CZSC64.dll`（2026-10-01，工作区干净），MinGW-w64 x64 |
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
