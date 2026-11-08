# 独立绩效评价与主流策略桌面交付

用户于开发验收后授权“提交打包”。本次包含主流策略扩展与独立绩效评价，按两项本地提交整理，不推送。主流策略提交`fb9407f`；绩效模块、构建链及本说明随本次绩效提交保存。原有`__pycache__`缓存不纳入提交，受保护MCP不改动。

## Windows产物

- 入口：`release/win-unpacked/GuanlanQuant.exe`。使用/复制时保留整个`win-unpacked`目录。
- 构建ID：`L6WVmN9sEv9XRl3B_SO0u`，包内`resources/server/.next/BUILD_ID`与本次`.next/BUILD_ID`一致。
- EXE SHA256：`DB2B8CF5CE1CE7C2F3ED1D5AD019814C99A5D675E8C23160C54A3DFB7059F650`。
- `resources/app.asar` SHA256：`101C420F3C754CFB0B70E879CEC37413D61CCE4A33E5F6084FA7F88E3564D5C5`。

`pnpm desktop:pack`成功：内部执行build（含worker/runtime）→desktop:prepare→electron-builder x64 dir→检查应用未占用→替换唯一`release/win-unpacked`。打包前后未运行用户常用数据目录的应用，没有数据库迁移、删库、交易或通知。

## 验收

- 开发全量：根11927项通过、28项既有跳过；workspace策略5、共享策略核心18、回测13、独立绩效7项全部通过。类型检查、独立包构建/类型/测试及应用目录外ESM、禁止依赖反例通过，见[绩效规格](../product/specs/backtest-evaluation.md)。
- 构建后生产浏览器：真实Next/RPC/隔离SQLite，历史实验→绩效评价→季度→月份→完整JSON导出，通过；合成279日数据，不代表真实业绩。
- 本次另用包内`resources/server/node-runtime/node.exe`启动包内`resources/server/server.js`，复用相同浏览器验收，再次验证季度/月度下钻及导出。测试支持`QUANT_EVALUATION_NODE`、`QUANT_EVALUATION_SERVER`指定打包入口；默认仍验证`.next/standalone`。
- `node scripts/desktop-smoke.mjs --packaged`通过，EXE退出码0，必需页面标签齐全，无启动错误；只读茅台源6037条、末日2026-11-06，核对前后源字节一致。使用临时隔离数据库与Electron配置，测试目录和自有进程已清理。
- 本次相关源代码/测试文件Prettier及`git diff --check`通过。全仓`format:check`仍有105个既有未改动文件问题，未进行无关格式化。

打包日志包含非Windows目标可选依赖的缺失/排除及默认图标提示；Windows x64打包、包内服务与EXE实测均通过，不宣称其他平台可运行。没有对外分发、签名可信性认证或真实策略样本外业绩认证。

## 使用与边界

在回测报告的“绩效评价”查看全程风险指标和年/季/月复盘。评价包`quant-performance`独立于回测撮合、账户事务和UI；服务只读冻结实验。旧离线茅台结果保留原样，主流策略扩展仍为离线研究，不因本次打包自动成为应用中的可执行策略。

旧报告和历史决策中的“未提交/未打包”描述各自开发验收时状态；本说明记录此次后续授权后的实际桌面交付。原工作区已通过同一轮验证的主流策略扩展一并纳入，未新增付费数据或外部操作。
