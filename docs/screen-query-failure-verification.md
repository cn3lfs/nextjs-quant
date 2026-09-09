# 候选查询失败与旧结果状态

2026-09-09，模块 C 增量。

浏览器故障复现：拦截包含 screenResults 的 tRPC 合并请求并让重试全部失败，原页面将已完成的 434 候选任务显示为“0 个”“运行后显示真实结果”，并提示重新运行规则，没有读取失败或重试入口。证据 `output/playwright/screen-failure-before.txt`。

修复后读取失败显示未知数量、任务已完成以及具体错误，提供“重试读取候选”和“恢复默认候选视图”，不误报零候选或要求重新选股。查询切换时如临时显示上一查询数据，明确标注“暂时保留上次结果”，设置表格忙状态，并禁用这些旧行的研究按钮。当前条件已有的有效缓存不受此限制。

## 验证

- 142 文件 / 673 测试，typecheck、build（含 runtime）、desktop:prepare、desktop:smoke 均通过。
- 同一隔离 434 候选样本：断网失败后出现提示和重试按钮，无零候选误报；移除拦截点击重试后，同排序条件 434 条恢复。证据 `output/playwright/screen-failure-after.txt`、`screen-failure-retried.txt`。
- 暂挂查询时提示旧数据，研究按钮 disabled；移除拦截后提示消失、研究按钮恢复、434 条正常。证据 `output/playwright/screen-failure-held.txt`、`screen-failure-released.txt`。
- 首次使用定时延迟脚本的自动释放观察超时，后改为明确暂挂/移除拦截；一次额外 route.continue 报请求已处理，已移除重复处理并重验成功。最终片段为 `output/delay-screen-query.txt`、`release-screen-query.txt`、`fail-screen-query.txt`；不把这些测试工具问题算作应用检查通过。
- 最后再次运行原 434 候选十种排序的 HTTP 比对，原任务与导出不变。恢复默认按钮的状态重置代码已检查，本次浏览器独立操作覆盖重试恢复及移除拦截恢复，未单独点击恢复默认按钮。

未调用模型、重新选股、写通达信文件、发送通知或打包 EXE。此增量不代表 A–H 整体完成。
