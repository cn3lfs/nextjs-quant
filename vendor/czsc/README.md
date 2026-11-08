# czsc-tdx 缠论计算 DLL

| 项 | 值 |
|---|---|
| 来源仓库 | `D:\github\czsc-tdx` |
| 来源 commit | `27de58024474249e0a6504d7e20345f41a6b5b38`（分支 `dev`，`czsc_build_commit()` 返回 `27de58024474`）：**api v22**——特征序列转折两侧不合并，线段终点保持段内极值，新增起点被破处理 |
| 文件 | `CZSC64.dll`（x64，静态链接 MinGW 运行时，自包含） |
| 大小 | `406528` 字节 |
| SHA-256 | `257ecbfce519ab8790d637386bf56b2860e5678f8854f86b4d4a3e82efb00cae` |
| 构建方式 | 来源仓库 WSL `make mingw64` → `build/CZSC64.dll`（2026-11-08，工作区干净，`--strip-all`），MinGW-w64 x64 |
| 许可 | GNU GPL v3（Copyright 2016, Martin Tang） |

## 升级与设置迁移

本次从干净的 `27de580` 源码运行 WSL `make mingw64` 重建，并在 Windows 实际加载核对 API、构建标识与 hash。

API v22 在 `czsc_config` 末尾追加 `segmentStartBreak`（offset 32），结构体由 32 增至 36 字节。
worker 严格要求 v22；旧 DLL 不能与新 FFI 混用。业务行及显示投影结构布局不变。

`segment.method=feature`（值 1）采用更新后的第 67/71 课特征序列规则；
`featureMerged`（值 2）保留连续合并方式，标为社区口径，仍使用本版的线段极值及起点破坏规则。
`segment.startBreak` 提供 `keep`（默认不回改）、`revise`（修正前段）和 `stroke`（一笔成段），
三项均按上游 schema 标为非原文选择。图表设置自动显示这些选项，研究/监控保留 DLL 默认口径。
原持久设置版本 2 的合法值继续保留；未设置的新字段采用 `keep`，不自动切换到连续合并算法。

API v21 移除旧 `first` 语义；图表持久设置版本升级到 2，旧版端点值 1
恢复为默认极值延伸，其他设置保留。用户重新选择「相邻次高次低」后才使用新规则：
极值仅因跨度不足时尝试其后紧邻的次高/次低分型，成笔后恢复正常极值延伸。
此选项为社区口径，不归为第 62/65 课原文规则。

本仓 SSE golden 同步自该提交，笔级主基准保持不变；线段级端点 11→20、中枢 1→3、事后信号 0→2。
默认特征序列的“合并首笔”显示与极值一致；需要旧连续合并显示时显式选择 `featureMerged`。
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
