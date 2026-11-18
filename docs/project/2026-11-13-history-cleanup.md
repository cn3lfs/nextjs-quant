# 历史产物清理（2026-11-13）

按用户“清掉项目用不到的历史数据，保留数据源”的要求执行，不另建历史备份。

已删除 **3,176 个文件，合计 2,267,442,952 字节（约 2.11 GiB）**。这是删除文件的逻辑大小，不是磁盘空闲空间增量。工作区删除尚未提交；Git 历史没有重写，因此 Git 对象体积不会同步减少。

| 类别 | 文件数 | 字节 |
| --- | ---: | ---: |
| isolated-test-output | 2507 | 920687200 |
| old-run-log | 74 | 261381 |
| derived-study-result | 40 | 1083616764 |
| derived-risk-evaluation | 75 | 64831407 |
| derived-factor-experiment | 91 | 181390991 |
| retired-browser-evidence | 2 | 385 |
| retired-visual-evidence | 84 | 12073066 |
| retired-review-and-dispatch-evidence | 303 | 4581758 |

范围：`.data` 下旧 CSI800 回测/风控/评价结果；`.codex-runs` 下重复研究输出、`quant-test-*` 隔离库、日志及旧派单/核验记录；`docs/review` 下旧截图和已不用的浏览器核验 JSON。原始输入、财务输入、因子面板及其来源说明不属于删除目标。

保留与边界：

- `.data/supermind-snapshots`、研究 `input.json`、财务原始输入/来源、现行因子输入，以及 `.codex-runs/s5` 中原始财报快照。
- `docs/data-sources`、WDZ 原始快照/来源、外部通达信和 Blocks 目录；WDZ 仍被脚本/测试使用，本次没有执行迁出，后续迁移需同时更新消费者。
- `.codex-runs/r3-results` 仍被策略目录及汇总工具引用；`docs/review/u8-calibration-distribution.json` 仍是脚本输入。它们属于当前引用项，本次不删；旧功能替换解除依赖后再清理，不因“历史证据”永久保留。
- `.codex-runs/wdz-reverse` 混有逆向源材料、二进制数据和修复凭据，未整体删除。未确认可丢弃的输入不按目录名猜测。
- 用户业务数据库、凭证、依赖、正式 release、Git 历史和已有代码改动未操作。源材料说明、方法文档与测试 fixture 保留。

验证：两批目标均在删除前核验完整路径、无 reparse 路径、逐文件 SHA-256、工作区修改和相关运行进程；删除后确认全部目标不存在。修正文档中指向已删文件的 Markdown 链接。更新项目指导和当前计划，使旧的永久保留要求不阻挡最新清理授权。

本次没有修改应用源码，不启动应用或数据库，不执行迁移、全套测试、构建、提交或打包。收尾时自动审批曾拒绝删除 `.codex-runs/cleanup-history-20261113`；随后用户自行执行 `scripts/cleanup-history-tools.ps1 -Apply`，退出码 0，删除剩余 4 个工具文件（1,168,142 字节）。已复核该目录不存在，无本次临时目录遗留。手动清理脚本保留在 `scripts/cleanup-history-tools.ps1`。WDZ 原始快照 2,319 个文件逐文件 SHA-256 与 manifest 一致。

## P0 后续：退役合成标定输出待手动清理

旧样本研究适配器和合成报告生成分支移除后，`docs/review/u8-calibration-distribution.json` 已无代码消费者。它是旧实验生成的 16,232 字节输出，不是原始数据源；上文将其视为脚本输入的判断现已纠正。账户标定脚本现只接受显式 `--from` / `--out`，仍会重放账户导出的 inputs，不采信内嵌判定结果。

已交付 `scripts/cleanup-retired-history.ps1`，仅允许删除这一个内容哈希固定的文件，拒绝目录链接、文件变化和正在运行的标定生成器。默认预演已通过，未执行删除；原文件仍在。用户可在仓库根目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/cleanup-retired-history.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/cleanup-retired-history.ps1 -Apply
```

WDZ 原始资料和其他历史输出不在此脚本范围内；`.codex-runs/r3-results` 的目录展示依赖尚待解除，不能将这次交付说成历史清理全部完成。
