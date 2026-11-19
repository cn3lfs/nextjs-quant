# 同花顺（thsdk-hq）数据源全量接入交付记录

- 交付日期：2026-11-19（分支 `feat/thsdk-data-source`，Wave 0–4 已提交，Wave 5 验收件在工作区）
- 所属模块：`data-sources`（[模块地图](../modules/README.md)、[数据源适配](../modules/data-sources.md)）
- 上游基线：PyPI `thsdk 2.0.2` 的 Windows x64 `hq.dll`（11,536,896 字节，SHA-256 `d396628429f0c08809b069a20a8dd38bd4718d0361f48f41a061f688aa8323f0`），调用 ABI `2.0.0`
- 依据：[全量数据源实施规格](2026-11-19-thsdk-data-source-plan.md)、[真实 ABI 与全能力样本实证](2026-11-19-thsdk-sample-verification.md)

## 1. 背景与范围

观澜原有本地通达信 `vipdoc` + GBBQ 研究基线、`tstdx`、东方财富、westock 与问财等来源；盘中五档、分价、集合竞价、分时、涨停归因、异动、板块概念和同花顺口径资讯缺少稳定的第二来源。本分支把同花顺 `hq.dll` 接入为**显式可选**数据源：补齐上述能力，并为公式选股、策略研究与实验室回测提供可选输入；不替换已冻结的本地研究基线。在 `auto` 路由中，THS 仅作为 `pytdx → eastmoney → tencent` 之后的最后兜底，且必须同时满足 `enabled && allowAutoFallback && authenticated`（[free-chart-sources.ts](../../src/server/market/free-chart-sources.ts)）；未启用、未认证或 `allowAutoFallback === false` 时绝不静默进入，只能由用户在入口显式选择「同花顺」。

五个交付域：

| 交付域                    | 主要入口                                                                                                                             | 交付内容                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| 全局数据源与 `/system`    | `src/lib/market/market-source.ts`、`src/server/market/connection-check.ts`、`src/components/workbench/connections/thsdk-section.tsx` | 来源枚举与持久化、DLL 路径选择与暂存校验、启用/认证/登出状态机、连接检查回执绑定配置修订与认证世代，改配置或登出后旧回执自动失效 |
| `/scan` 实时终端          | `src/components/market/quote-book.tsx`、`tdx-side-panel.tsx`、`thsdk-market-panels.tsx`                                              | 五档盘口、分价表、集合竞价、分时；缺失字段保留 `null`，不冒充可成交量                                                            |
| `/scan?tab=sentiment`     | `src/components/market/limit-up-view.tsx`、`thsdk-sentiment-reference.tsx`、`src/server/data-sources/thsdk/thsdk-sentiment.ts`       | 涨停归因、实时信号、大盘异动、竞价异动；以独立折叠面板追加在东财榜单之后，分源标注                                               |
| `/scan?tab=wencai` 与资讯 | `thsdk-wencai-panel.tsx`、`thsdk-news-panel.tsx`、`/intel?tab=thsdk`                                                                 | 问财自然语言选股与热门板块、7×24 快讯、个股研报；与本地 CLS 新闻分源                                                             |
| 研究/公式/回测可选输入    | `formula-screen.tsx`、`formula-screen-service.ts`、`lab-backtest.ts`、`src/server/charts/chart-bars.ts`                              | 图表在线源、公式选股指定证券池、实验室组合回测；信号价与成交价口径显式分离                                                       |

## 2. 架构与 `hq.dll` v2.0.2 ABI 决策

```
UI（/system、/scan、/intel、公式与回测）
  → 领域服务 / 适配器（thsdk-adapter、-sentiment、-wencai、-news、-blocks）
  → 主进程单例串行队列（thsdk-client：≥65ms 间隔、15s 默认超时、崩溃熔断）
  → fork() 子进程 runtime/thsdk-worker.cjs（最小 env + 独占 cwd）
  → koffi 同步调用外部 hq.dll（CallAlloc / FreeResult）
```

- **独立 Node 子进程 + `koffi`**：不引入 Python/pandas，复用 `czsc-worker` 范式；DLL 只在子进程内加载，主进程崩溃或超时可整进程回收。
- **指针与解码**：`CallAlloc(const char*) -> void*`，返回值必须声明为 `void *`；响应统一用 `koffi.decode(ptr, "char", -1)` 解码（`decode(ptr, "str")` 会把 JSON 首 8 字节当二级指针解引用而崩溃），解码后立即校验 `Buffer.byteLength <= 8 MiB`，并在 `finally` 中调用 `FreeResult`。
- **Go 运行时 DLL 不卸载**：进程结束前只调 `_close` 并 `process.exit(0)`，从不调用 `library.unload()`；父进程看门狗每秒探测，父进程消失即 `SIGKILL` 自身（同步 FFI 阻塞时消息端口无法处理）。
- **方法白名单**：原生清单 80 个方法 = 70 个只读 + 10 个自选股写方法；只读方法按用途放行，10 个写方法在进入 FFI 之前直接拒绝，不依赖 DLL 侧校验。控制面另有 6 个方法（`version`/`methods`/`auth`/`auth_qrcode`/`logout`/`_close`），只由认证与生命周期代码调用。
- **串行与限频**：单进程单队列，最小间隔 65ms（底层约 50ms 限频窗口）；限流按 `retry_after_ms` 退避，连续 3 次崩溃进入 30s 熔断。
- **会话独占**：会话目录固定为 `QUANT_DATA_DIR/runtime-sessions/thsdk/`；同目录被其他进程占用时返回 `session_locked`，不做并发复用。
- **二进制来源**：仓库与 `release/win-unpacked` 不分发闭源 DLL；用户在 `/system` 指定外部路径，加载前校验存在性、PE 头、体积、SHA-256 与已知清单（当前仅登记 2.0.2），并暂存到会话目录后使用。
- **凭据**：Windows DPAPI 存于 `credentials/thsdk-credentials.bin`（标识 `thsdk-credentials`），提供指纹比较与删除入口；错误、日志不输出账号、密码、MAC、会话内容或内部路径。
- **认证策略**：默认个人账号（扫码或账密）；游客模式是显式开关（`guestModeEnabled`，默认 `false`），失败如实返回，不静默切换账号或降级到共享游客凭据。

## 3. 关键不变量

- **零数据库迁移**：SQLite `PRAGMA user_version = 20` 保持不变（[migrations.ts](../../src/server/db/migrations.ts) 未新增迁移）；仅把 `dataDirectory()` 抽到 [infra/paths.ts](../../src/server/infra/paths.ts)，避免路径消费者加载 `better-sqlite3`。
- **东财情绪链路不动**：[limit-sentiment.ts](../../src/server/market/limit-sentiment.ts)（`LimitSentimentCore`）与前端 IndexedDB 缓存未修改；同花顺参考以追加面板呈现，两源各自标注、不静默合并去重。
- **`src/server/mcp.ts` 未改**：本分支对该文件零改动。
- **防重复复权**：THS 序列以 `adjustmentSource: "thsdk-native"` 标记前复权 `qfq` / 后复权 `hfq` 信号价，并同时冻结同源 `rawBars` 未复权原价用于成交；`chart-bars.ts` 在远端来源为 `thsdk-hq` 且要求复权时改用原生复权序列，不再叠加本地 GBBQ；实验室冻结对象分开记录 `adjustment`、`adjustmentSource`、`volumeUnit`。
- **盘中未完成门控**：[read-bars.ts](../../src/server/market/bar-store/read-bars.ts) 以北京时间 15:00 为界，把当日尚未收盘的 bar 放入 `formingDates`；THS 日线消费同一门控，不把未完成 K 线当已完成历史。
- **主进程执行 THS 公式与回测**：[formula-screen-service.ts](../../src/server/screening/formula-screen-service.ts) 与 [strategy-lab.ts](../../src/server/api/routers/strategy-lab.ts) 在 `source === "thsdk"` 时走 `executeFormulaScreen` / `executeLabBacktest` 而非 `runWorker`；[formula-shards.ts](../../src/server/screening/formula-shards.ts) 在该来源下把线程数压到 1。原因：会话目录单进程独占，多个 `worker_threads` 并发会争抢同一 `session_dir` 并触发 `session_locked`。
- **URL 消毒**：快讯与研报链接只保留 `http:`/`https:`（[thsdk-news.ts](../../src/server/data-sources/thsdk/thsdk-news.ts) 的 `httpUrl`），前端渲染前再校验一次。

## 4. 提交与文件地图

| Wave | 提交       | 范围                                                                                            |
| ---- | ---------- | ----------------------------------------------------------------------------------------------- |
| 0    | `9f1bdbe6` | `hq.dll` ABI 实证（`tests/manual/thsdk-abi-probe.mjs`）、治理限制清理、测试守卫现代化           |
| 1    | `c75267a9` | `koffi` 隔离子进程、串行客户端、DPAPI 凭据与删除、DLL 路径暂存、认证与关停生命周期              |
| 2    | `fc1dd6eb` | 全局来源分发器、`/system` 认证与诊断、`QuoteBook` 与 `/scan` 终端面板                           |
| 3    | `338f541c` | 情绪、板块、问财 NLP、7×24 快讯与研报                                                           |
| 4    | `168ef16b` | BarStore、图表、公式选股与实验室回测的可选 THS 来源                                             |
| 5    | 工作区     | `tests/desktop-build/thsdk-package.test.ts`、`tests/e2e/thsdk-acceptance.spec.ts`；E2E 隔离修正 |

核心文件：

- 契约与驱动：[thsdk-contract.ts](../../src/server/data-sources/thsdk/thsdk-contract.ts)、[thsdk-client.ts](../../src/server/data-sources/thsdk/thsdk-client.ts)、[thsdk-worker.ts](../../src/server/data-sources/thsdk/thsdk-worker.ts) → [runtime/thsdk-worker.cjs](../../runtime/thsdk-worker.cjs)
- 适配与领域：[thsdk-adapter.ts](../../src/server/data-sources/thsdk/thsdk-adapter.ts)、[thsdk-sentiment.ts](../../src/server/data-sources/thsdk/thsdk-sentiment.ts)、[thsdk-blocks.ts](../../src/server/data-sources/thsdk/thsdk-blocks.ts)、[thsdk-wencai.ts](../../src/server/data-sources/thsdk/thsdk-wencai.ts)、[thsdk-news.ts](../../src/server/data-sources/thsdk/thsdk-news.ts)
- 认证与路径：[thsdk-auth.ts](../../src/server/data-sources/thsdk/thsdk-auth.ts)、[thsdk-path.ts](../../src/server/data-sources/thsdk/thsdk-path.ts)、[thsdk-known-hashes.ts](../../src/server/data-sources/thsdk/thsdk-known-hashes.ts)、[vault.ts](../../src/server/vault.ts)

## 5. 验证与证据

已落盘的自动化验证：

- [thsdk-contract.test.ts](../../tests/data-sources/thsdk-contract.test.ts)：代码映射、白名单、请求/响应边界
- [thsdk-lifecycle.test.ts](../../tests/data-sources/thsdk-lifecycle.test.ts)：串行、超时、崩溃回收、熔断、会话独占
- [thsdk-adapter.test.ts](../../tests/data-sources/thsdk-adapter.test.ts)、[thsdk-sentiment.test.ts](../../tests/data-sources/thsdk-sentiment.test.ts)、[thsdk-extensions.test.ts](../../tests/data-sources/thsdk-extensions.test.ts)：字段、单位、缺失语义与失败分类
- [thsdk-path.test.ts](../../tests/data-sources/thsdk-path.test.ts)、[thsdk-vault.test.ts](../../tests/data-sources/thsdk-vault.test.ts)：DLL 校验/暂存、DPAPI 与非法标识
- [thsdk-bar-store.test.ts](../../tests/market-chart/market-data/thsdk-bar-store.test.ts)、[thsdk-formula-source.test.ts](../../tests/screening-rps/thsdk-formula-source.test.ts)、[thsdk-backtest-integration.test.ts](../../tests/research-backtest/thsdk-backtest-integration.test.ts)：来源选择、复权口径与冻结输入
- [thsdk-package.test.ts](../../tests/desktop-build/thsdk-package.test.ts)：打包后的 worker 不含凭据字面量/令牌/`unload` 调用，runtime 不含外部 DLL、会话与凭据产物；本轮实跑 `pnpm exec vitest run tests/desktop-build/thsdk-package.test.ts` 为 1 个文件、5 个用例全部通过（2026-11-20）
- [thsdk-acceptance.spec.ts](../../tests/e2e/thsdk-acceptance.spec.ts)：默认关闭且初始导航零 THS 请求、设置保存与游客说明、离线情绪/Wencai/资讯/公式/回测界面，以及 1440/1024 双宽度无横向溢出；由 `pnpm e2e` 的 workbench 项目（`**/*.spec.ts`）自动发现

### Wave 5 门禁回执（2026-11-20）

以下检查已实际执行并全部通过：

- `pnpm format:check`、`pnpm check:dependencies`（1454 个模块，0 错误，0 循环）、`pnpm runtime:build`、`pnpm typecheck`、`pnpm lint`
- 完整 Vitest 套件：753 个文件、7,668 个测试，另有 4 个 workspace 包测试套件
- `pnpm build`、`pnpm desktop:prepare`、`node scripts/desktop-smoke.mjs --startup-only`（返回 `desktopSmoke: true`）
- 隔离 Playwright E2E：[thsdk-acceptance.spec.ts](../../tests/e2e/thsdk-acceptance.spec.ts) 的 3/3 场景在 1440×900 与 1024×768 下通过

未执行：`pnpm desktop:pack`。上述回执覆盖源码、构建与运行冒烟，不代表桌面安装包已产出或已验证。

## 6. 运行边界与用户设置

1. 自行取得 `hq.dll`（当前只承认 2.0.2 的 SHA-256），在 `/system` → 「同花顺行情（THSDK）」选择路径；路径只接受盘符绝对路径，拒绝网络共享、符号链接/目录联接、备用数据流与尾随点/空格。未登记哈希需显式打开「允许未登记哈希」开关才会暂存。
2. 选择认证方式：扫码登录或保存账密（DPAPI）；游客快速体验默认关闭，开启后使用上游随包的短生命周期账号，受上游限频与风控约束。
3. 使用前先做连接检查；检查回执绑定配置修订与认证世代，改配置或登出后旧回执自动失效。
4. 失败语义：`rate_limited`、`auth_required`、`session_expired`、`timeout`、`invalid`、`empty`、`unavailable` 等结构化错误直接呈现，不静默切回东财或本地源。
5. 研究口径：THS 来源标记为「同花顺延迟行情」，信号价为原生前复权、成交价为同源未复权原价，未计入公司行动分红送转，历史 ST/IPO/排队未认证；结果只作规则自检，不是可信策略业绩。
6. 分发：仓库与 `release/win-unpacked` 不含闭源 DLL、会话或凭据文件；随包分发需单独决策。

## 7. 后续可选动作

- 将 `feat/thsdk-data-source` 合入 `master`（需提交/合并授权）。
- 经用户授权后执行 `pnpm desktop:pack` 并核对安装包不含外部 DLL、会话与凭据产物。
