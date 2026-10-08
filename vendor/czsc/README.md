# czsc-tdx 缠论计算 DLL

| 项 | 值 |
|---|---|
| 来源仓库 | `D:\github\czsc-tdx` |
| 来源 commit | `ef5f6180fc69839b8312c5b8b291b89355f47d5a`（分支 `dev`，`czsc_build_commit()` 返回 `ef5f6180fc69`）：**api v21**——端点值 1 从旧 first 改为相邻次高次低补选 second（社区口径）；结构体布局与 v20 一致，默认极值配置保持原 golden |
| 文件 | `CZSC64.dll`（x64，静态链接 MinGW 运行时，自包含） |
| 大小 | `399872` 字节 |
| SHA-256 | `3412dcefe29818599516cb20c37a95532e3d0b59a83b99841358a1991027189c` |
| 构建方式 | 来源仓库 WSL `make mingw64` → `build/CZSC64.dll`（2026-10-08，工作区干净，`--strip-all`），MinGW-w64 x64 |
| 许可 | GNU GPL v3（Copyright 2016, Martin Tang） |

## 升级与设置迁移

来源仓库预置 DLL 虽返回 API v21，但构建标识为 `bc6f3460df57-dirty`。
本次从干净的 `ef5f618` 源码运行 WSL `make mingw64` 重建，并核对实际 API、构建标识与 hash。

API v21 移除旧 `first` 语义；图表持久设置版本升级到 2，旧版端点值 1
恢复为默认极值延伸，其他设置保留。用户重新选择「相邻次高次低」后才使用新规则：
极值仅因跨度不足时尝试其后紧邻的次高/次低分型，成笔后恢复正常极值延伸。
此选项为社区口径，不归为第 62/65 课原文规则。

来源仓库的 SSE golden 与本仓 fixture 逐字节一致，无需更新预期数据。
历史研究结果按 DLL hash 隔离，不把旧结果改写为新版本结果。

## 为什么放这里

`runtime/` 在 `.gitignore` 中且由 `pnpm runtime:build` 生成，不适合存放版本化资产。
本目录是 git 跟踪的事实来源；`scripts/build-runtime.mjs` 复制到
`runtime/czsc/CZSC64.dll`，`scripts/prepare-desktop.mjs` 已递归拷贝整个 `runtime/`，
桌面分发自动包含。

## 许可提示

源码头部为 GPL v3，来源仓库 README 声明「免费分享使用，没有任何限制」。
**私有仓库保存副本不构成分发。** 若要捆绑进对外分发的 `GuanlanQuant.exe`，
需先确认 GPL v3 义务。该决策由用户作出。
