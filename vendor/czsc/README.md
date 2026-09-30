# czsc-tdx 缠论计算 DLL

| 项 | 值 |
|---|---|
| 来源仓库 | `D:\github\czsc-tdx` |
| 来源 commit | `fb3eb7a`（分支 `dev`，`czsc_build_commit()` 返回 `fb3eb7a2125c`）：api v8 = v7 + 线段分界点显示（配置万位 0 极值笔 / 1 合并起始笔 / 2 合并最后笔，仅特征序列线段）与 `czsc_pivot.extremeIndex`（size 24→28）；分析始终按真实极值，配置 0/1100 除 pivot 尾部新增字段外与 v7 逐字节一致（czsc-tdx 已比对） |
| 文件 | `CZSC64.dll`（x64，静态链接 MinGW 运行时，自包含） |
| 大小 | `957537` 字节 |
| SHA-256 | `2660af993b594572bd86e96e129e46ef3dd2b6f29cfda0c18f17ca75a5815ed2` |
| 构建方式 | 来源仓库 WSL `make mingw64` → `build/CZSC64.dll`（2026-09-30，工作区干净），MinGW-w64 x64 |
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
