# Q2b 收尾核验（2026-09-10）

范围：保留上轮 Q0 契约适配与 Q2b 实现，收尾结构护栏、DLL 测试准备、浏览器链路及模拟成交对账。未优化耗时，未更改数据库迁移、路线图或冻结模块。

## 公式函数清单

实际 **60 个可调用函数**，其中 Q2b 新增 **39 个**；行情字段别名不计入数量。

既有 21 个：REF、MA、EMA、SMA、HHV、LLV、SUM、COUNT、CROSS、BARSLAST、FILTER、LAST、EXIST、IF、AND、OR、NOT、ABS、MAX、MIN、STD。

新增 39 个：WMA、DMA、TMA、HHVBARS、LLVBARS、BARSCOUNT、AVEDEV、SLOPE、STDP、VAR、INTPART、ROUND、POW、SQRT、LOG、MOD、SGN、BETWEEN、VALUEWHEN、RANGE、IFF、EVERY、IFN、CEILING、FLOOR、FRACPART、SIGN、EXP、LN、SIN、COS、TAN、ASIN、ACOS、ATAN、MEMA、EXPMA、VARP、DEVSQ。

新增未来函数黑名单条目：**0**。沿用 Q2a 的 31 项：ZIG、ZIGA、PEAK、PEAKBARS、TROUGH、TROUGHBARS、BACKSET、BARSNEXT、REFX、REFXV、XMA、DRAWLINE、DHIGH、DOPEN、DLOW、DCLOSE、DVOL、FILTERX、REFDATE、CONST、ALIGNRIGHT、CURRBARSCOUNT、TOTALBARSCOUNT、ISLASTBAR、BARSTATUS、IFC、TESTSKIP、FINDHIGH、FINDHIGHBARS、FINDLOW、FINDLOWBARS。

`tests/q2b-functions.test.ts` 对每个新增名称检查手算值、确定性、不可变输入、空输入、追加未来 bar 后历史输出不变，并把全部黑名单逐项置于未使用赋值中验证拒绝执行；另测负 REF 和不能静态证明安全的偏移。未删除或跳过 Q2a 不变量。

局部口径：窗口要求静态整数；窗口不足为 null。DMA 权重可为序列，严格 0<A<1；TMA 系数静态且小于 1；递推遇无效输入保留状态。ROUND 为半值远离零，LOG 为常用对数、LN 为自然对数；BETWEEN 包含端点、RANGE 不含端点。尚无通达信终端逐项人工核对，函数覆盖不等于与所有通达信动态参数形式兼容。

## 浏览器证据

`tests/q2b-visual-review.mjs` 在隔离目录 `.test-data/q2b/data` 完成：命名与参数保存 → 刷新恢复 → 三条真实原文不支持函数报错 → 死分支未来函数拒绝 → 全市场 worker 执行 → 运行中展开函数目录 → 现有候选表 → 下载完整 JSON 并校验格式和候选。

- [浏览器记录](browser-evidence.json)
- [编辑器](editor-ready.png)、[未来函数拒绝](future-rejected.png)
- [运行中进度](running-progress.png)、[候选表与导出按钮](real-candidates.png)
- 原文拒绝截图：[巴菲特](q2b-buffett.png)、[老鸭头原文](q2b-old-duck-original.png)、[涨跌停公式](q2b-price-limits.png)

浏览器本次实跑：基准日 **2026-09-09**，**6145 → 15**，读取错误 **0**，计算 **112.84 秒**（截图），满足用户主动批处理 <10 分钟标准。上轮独立 worker 记录为 **110.44 秒**，同为 15 个候选；保留 [local-evidence.json](local-evidence.json)，不把旧时间冒充本次时间。上轮真实取消用例也记录于该文件。

该截图拍摄后发现进度卡仍显示扫描阶段隔离数11，而日期对齐后的结果隔离数为606；已补最终计数上报和对应单元断言。保留原截图，不把旧任务证据伪装成修正后重新执行。此计数改动不影响候选集合或导出。

执行公式明确命名为「老鸭头（价量部分，非原公式）」；包含 FINANCE 等依赖的原文完整版本被拒绝，未静默删除函数或宣称原文等价。此名称在保存、候选表和导出中保持一致。

浏览器用例原先等待了不存在的状态文字「执行中」，产品实际标签为「运行中」；修正用例。保存名称加入本轮唯一后缀，避免前次中断遗留同名记录导致 Playwright strict locator 歧义，没有删除旧记录。

## DLL 文件级失败判定

本次修改前全量复现为 1039/1041，仅结构指纹两项失败。两个 DLL 文件当次分别约 1.41 秒、0.20 秒，不能据此声称 20 秒超时。

发现两个 `beforeAll` 均无条件 copyFile 覆盖 `runtime/czsc/CZSC64.dll`。受控独立进程加载并持有该 DLL 后，原版两个文件稳定同时失败：`EBUSY: resource busy or locked, copyfile vendor/czsc/CZSC64.dll -> runtime/czsc/CZSC64.dll`，分别位于原第 13、33 行。失败发生在 beforeAll，14 个用例尚未进入，符合文件级失败特征。保持同一占用进程不退出，改后两个文件全部可运行。

修法：测试共享准备函数只用 COPYFILE_EXCL 首次复制；文件已存在则逐字节核对 vendor 二进制，不覆盖已加载文件。内容不一致仍明确失败，不能吞掉锁错误或使用旧 DLL。新增持久回归用例先让串行 worker 加载 DLL，再执行准备并比对前后计算结果。

未放宽任何 timeout。`projectCzsc` 既有 promise 队列串行发送整个任务，子进程同步执行 Func40 与全部 Func30，未见并发进入 DLL 的路径，不重写串行化。**上一轮偶发失败的原始栈没有找到，不能断言其每次都由 EBUSY 引发；已稳定重现并修复的是上述具体缺陷。**

## 剩余事项

Q0 已核实买入成交并落本地账本，对账见 [Q0 记录](../q0-mock-trading-log.md) 和 [脱敏证据](q0-reconciliation.json)。当日远程可卖 0，卖出被 T+1 门禁阻止；尚未完成卖出成交，不能标为完整往返闭环。下一可卖交易日需用当日价格/限价续做。9/8/: 含义仍未知，不阻塞现有上海交易核验。

没有新的范围决策需要用户批准。现有人工函数口径核对仍可进行。日线日历在盘中落后一天导致普通录入门禁拒绝当日成交的问题单独记入 decisions，未扩展修改产品日历逻辑。

## 最终检查

166 个测试文件、1046 项测试全部通过（接手时1041项，没有减少）；`pnpm typecheck`、最终 `pnpm build`（含 runtime:build）、`pnpm desktop:prepare`、`git diff --check` 通过。构建也使用隔离 QUANT_DATA_DIR。未执行 desktop:smoke、desktop:pack、依赖安装、commit 或 push；没有新增迁移。
