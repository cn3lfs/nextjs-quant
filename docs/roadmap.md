# 观澜 · 路线图（唯一事实源）

生效日期：2026-09-09。本文件取代 `docs/optimization-progress.md` 中的 A–H 分模块目标。
`optimization-progress.md` 及 `output/` 下的验证记录**冻结归档**，只读引用，不再追加。

## 0. 项目定位

**自用的精简量化平台。** 三件事，不多做：

1. **看得见** —— 模仿 TradingView / 通达信的 K 线浏览：品种切换、周期切换、成交量与
   MA/MACD/KDJ/RSI/BOLL 指标展示、十字光标读数、缠论结构标注。
2. **算得出** —— 两个策略：**缠论**（复用 `czsc-tdx` 现成引擎）与**双突破**
   （`swing-trader` 技能方法），在本地数据上做确定性计算。
3. **推得到** —— 信号进入既有监控循环，推送到飞书/企微/Telegram/Discord，LLM 解读作为追加。

明确不是：不是回测平台，不是策略研究平台，不是多流派分析平台。

## 1. 已定架构决策

### 1.1 策略验证外包给聚宽

自建 A 股回测引擎需要公司行动因子链、停复牌、涨跌停排队、退市、历史证券池归档、官方交易日历。
这些聚宽已经做好且数据质量更高。**本项目不再投入回测方向。**

现有 `backtest-1..5`、`walk-forward`、`cost-experiment-1`、`cash-adjusted` 代码保留，
降级为"规则自检工具"，不再深化。README 中"不能用作正式策略业绩"的限定**永久保留**。

### 1.2 指标自己算，不走问财

`swing-trader` 技能通过 `hithink-market-query` 查询 MACD/KDJ/RSI，
那是给**没有本地数据的 LLM** 设计的路径。

本项目拥有完整的本地通达信日线/5分钟全历史，指标必须在本地用 TypeScript 计算：
可批量跑全市场、可离线、可回溯、无调用配额、无远端口径漂移。
技能提供的是**方法与阈值**，不是数据来源。

### 1.3 缠论用 FFI 调用现成 DLL，不移植算法

来源仓库：`D:\github\czsc-tdx`（7,243 行 C++，缠师原文 108 课实现）。

**不移植到 TypeScript。** 缠论的包含处理、笔/线段划分、中枢构造对细节极度敏感，
重写 5,000+ 行的出错概率远高于收益。该仓库的导出是干净的 C ABI：

```c
void Func30(int nCount, float *pOut, float *pHigh, float *pLow, float *pTime);
void Func40(int nCount, float *pOut, float *pClose, float *pVolume, float *pUnused);
```

`Func30` 单一入口覆盖 58 种输出（端点、中枢、三类买卖点、信号质量、背驰、
区间套、走势类型、中枢生命周期等），`pTime[0]` 传 mode 码 = `配置码*1000 + 输出类型*10`。
`build/CZSC64.dll` 已交叉编译并**静态链接 MinGW 运行时**，自包含，仅依赖系统
`KERNEL32.dll`/`msvcrt.dll`。本机无 C++ 工具链，也不需要——直接用二进制。

**已知约束（实现时必须遵守）**

- **全局状态**：DLL 内有单槽分析器缓存（`GetOrBuildPriceAnalyzer`，全字节指纹）
  且 `Func40` 旁路注册全局 C/V。**调用必须串行化**，或每个 worker 进程独立加载实例。
  绝不允许多线程并发进入。
- **float32**：DLL 全程用 32 位 float，JS 是 double。传入必须用 `Float32Array`，
  读出后按 float32 精度比较，不得用严格相等判断价格。
- **调用顺序**：依赖 MACD 的输出必须先调 `Func40` 注册真实 C/V。
- **许可证**：源码头部为 **GPL v3**（Copyright 2016, Martin Tang），
  而 README 声明"免费分享使用，没有任何限制"。**自用不分发无义务**；
  若将 DLL 捆绑进 `GuanlanQuant.exe` 对外分发，需先确认许可义务。
  实现时在 `THIRD_PARTY_NOTICES.md` 记录来源与许可，**分发决策留给用户**。

## 2. 范围外（冻结清单）

以下代码**保留可用、停止任何投入**。不得新增功能、不得重构、不得优化、不得补验收。

| 冻结项 | 涉及范围 |
|---|---|
| 回测与滚动检验 | `backtest-*`、`walk-forward*`、`cash-dividends`、`backtest-costs` |
| CANSLIM | `canslim-*`（30+ 文件）、`canslim-panel.tsx` |
| 威科夫 | `wyckoff-*`、`wyckoff-panel.tsx` |
| 基本面 / 价值 / 估值 | `fundamental-*`、`valuation-*`、`annual-cash-flow`、`financial-*` |
| 市场情绪 / TMT | `market-sentiment`、`tmt-*` |
| 新闻行业链 | `news-*` |
| 其余未接入技能 | `trading-skill-ids.json` 中除 `swing-trader`、`chan-theory` 与量价快评外全部 |
| 性能优化 | 选股已从 40.84s 优化至 165ms（250 倍），**目标已达成，停止** |
| 组合 / 风控 / 归因 | 不实现 |
| 多品种扩展 | ETF、港美股、期货、可转债，不实现 |

**例外**：现有 `chan-*`（`chan-panel.tsx`、缠论 LLM 报告链路）是**基于技能原文的解读层**，
与 M3 的 DLL 计算层不同。M3 完成后再决定是否合并，在此之前同样冻结，不要在旧链路上改。

上述模块的现有 UI 面板从主界面收进二级"研究"入口即可，不删除、不改造。

## 3. 里程碑

**2026-09-09：M1–M5 的 A 层全部由管理者独立验收通过。**
155 文件 783 测试、typecheck、build、desktop:prepare + desktop:smoke（exitCode 0）通过。
`output/` 零新增。各里程碑的 B 层人工事项汇总见 `docs/next-plan.md`。

| 里程碑 | A 层 | 关键实证 |
|---|---|---|
| M1 指标层 | ✅ | 口径经 `tdx-doc examples` 与 `czsc-tdx` C++ 两独立来源交叉佐证 |
| M2 图表 | ✅ | 截图 legend 中 `2×(DIF−DEA)=MACD` 实证 ×2 正确 |
| M3 缠论 FFI | ✅ | golden 157/158/18/17 + 15/2/2 全中，35 条结构逐字段零差异 |
| M4 信号推送 | ✅ | 受控假渠道端到端，实际网络投递数 **0** |
| M5 双突破 | ✅ | 三例取自真实本地日线（含 sourceHash/barsHash/cutoff）；全市场 6145 只冷跑 3.94s / 基准 5.03s |

后续工作见 `docs/next-plan.md`。以下为原始里程碑定义，保留备查。

五个里程碑**严格串行**。前一个未通过验收，不得开始下一个。

**排序理由**：缠论（M3）排在双突破（M5）之前，因为它是现成的、有 golden 数据可验证的
低风险资产；双突破的趋势线与支撑压力位识别主观性最强、最容易做偏。先落地确定的东西。

---

### M1 — 指标计算层

**交付**：`src/lib/indicators.ts`，纯函数，无 UI，无 IO。

实现 MA、EMA、MACD(12,26,9)、KDJ(9,3,3)、RSI(6,12,24)、BOLL(20,2)。

**唯一高风险点：口径必须对齐通达信。**

`tdx-doc` 技能是**函数字典**，只有 `STD`/`EMA`/`SMA` 等的功能说明，
不含 RSI/BOLL/MACD 系统指标的完整公式。已核实，不要再去那里找。
下面 §3.1 是本项目认定的口径，**以此为准**。

##### 3.1 通达信口径（认定值）

递推基元：

```
EMA(X,N):  Y = (2*X + (N-1)*Y') / (N+1)，  Y0 = X0
SMA(X,N,M): Y = (M*X + (N-M)*Y') / N,      Y0 = X0
```

注意 `SMA(X,N,1)` 展开即 `(X + (N-1)*Y')/N`，**这就是 Wilder 平滑**。
（本文件早前版本称 RSI "非 Wilder 平滑"，是错的，已更正。）

六个指标：

```
MA(C,N)     = 最近 N 根收盘均值

MACD(12,26,9):
  DIF  = EMA(C,12) - EMA(C,26)
  DEA  = EMA(DIF,9)
  MACD = (DIF - DEA) * 2          ← 柱值有 ×2，漏了会与通达信差一倍

KDJ(9,3,3):
  RSV = (C - LLV(L,9)) / (HHV(H,9) - LLV(L,9)) * 100
  K   = SMA(RSV,3,1)
  D   = SMA(K,3,1)
  J   = 3*K - 2*D

RSI(N):
  LC  = REF(C,1)
  RSI = SMA(MAX(C-LC,0),N,1) / SMA(ABS(C-LC),N,1) * 100

BOLL(20,2):
  MID   = MA(C,20)
  UPPER = MID + 2*STD(C,20)
  LOWER = MID - 2*STD(C,20)
  STD 为「估算标准差」，分母 N−1
  （依据 tdx-doc 00-函数总索引：STD=估算标准差、STDP=总体标准差 的区分）
```

##### 3.2 预热与 null 规则

- **窗口类**（`MA`、`STD`、`HHV`、`LLV`）语义明确：不足窗口返回 `null`。
  因此 MA20 前 19 根、BOLL 前 19 根、KDJ 的 RSV 前 8 根为 `null`。
- **递推类**（`EMA`、`SMA`）从第 0 根起就有值，**不屏蔽预热期**
  （`EXPMEMA` 才有"不足 N 周期返回无效值"的语义，本项目不用它）。
  MACD 的 DEA 用完整 DIF 序列递推，不隐藏早期值。
- `null` 另用于真正无法计算的情形：输入为空、`HHV==LLV` 除零。
- 一律不得用 0 或首值填充。

##### 3.3 存疑项交由 B 层人工定案

§3.1/§3.2 中以下三点**必须在核对表里单独列出并让用户对着通达信验证**，
不得因为"看起来对"就跳过：

1. `STD` 的分母是 N−1 还是 N（BOLL 上下轨会整体偏移）
2. MACD 柱是否 ×2
3. 递推类指标不屏蔽预热期的早期取值（列 3 个早期日期）

每个指标的实现注释标注所依据的出处：本文件 §3.1 条目，
或 `tdx-doc` 的具体文件与章节（仅 `EMA`/`SMA`/`STD` 基元有出处）。

##### 3.4 退化边界的处理规则

递推序列遇到无效输入（除零、空值）时，**状态连续、不重新初始化**：

- KDJ：某日 `HHV(H,9) == LLV(L,9)`（连续一字板）→ 该日 `RSV` 记为 `null`，
  当日不更新 `K`/`D`，输出沿用前一有效值；`RSV` 恢复有效后，
  继续以断点前的 `K`/`D` 作为前值递推，**不以恢复当日的 RSV 重新初始化**。
  理由：`SMA` 是连续递推，重置会造成人为跳变。
  若首个有效 `RSV` 出现前就遇到该情况，`K`/`D` 保持 `null`。
- 同一规则适用于其他递推类指标遇到无效输入的情形。

##### 3.5 何时停下汇报，何时自行决定

前两轮执行因为对极罕见边界逐个上报而零产出。规则收紧如下：

**必须停下汇报**（影响范围或不可逆）：

- 改变里程碑范围、交付物或验收标准
- 影响外部可见行为的架构选择（数据源、依赖引入、进程模型）
- 不可逆操作（删文件、改数据库、打包分发）
- 许可证与分发义务

**自行决定并继续**（局部、可改、不改变范围）：

- 计算边界与退化情形（除零、极值退化、空输入、精度取舍）
- 函数签名、内部数据结构、测试组织方式
- 命名、注释、文件拆分

自行决定的口径必须做三件事：代码注释写明选择与理由；
在 `docs/decisions.md` 记入「待确认口径」；在核对表中单列供人工验证。
**不得因为一个边界未定就中止整个实现。**

**输入契约**：接收 `Bar[]`（`src/lib/domain.ts` 已存在），不复权，按时间升序。
历史长度不足以计算某指标时该点返回 `null`，**不得用 0 或首值填充**。

**验收**

分两层。执行者只能完成 A 层，**B 层由用户人工完成，执行者不得代劳或声称已完成**。

A 层（执行者自证，二值，全部满足）

1. 每个指标至少 1 个**手算可验证**的小 fixture（8–30 根构造 K 线），
   期望值在测试注释中写出算式，任何人可用计算器复核。
2. 历史不足、停牌零成交、单根 K 线等边界返回 `null` 而非异常值，有测试覆盖。
3. 同一输入重复调用结果完全一致（确定性），有测试覆盖。
4. 每个指标的实现注释标注所依据的 `tdx-doc` 函数定义出处（文件 + 章节）。
5. `pnpm typecheck` 与 `pnpm test` 通过。
6. 产出 `docs/m1-tdx-checklist.md`：3 只真实 A 股（sh600519、sz002084、bj920748）
   读取本地通达信日线，每个指标各列 5 个具体日期及本实现算出的数值，
   留空白列供人工填写通达信显示值。表头注明使用的数据根目录与最后一根 K 线日期。

B 层（用户人工，执行者不得填写）

7. 用户对照通达信软件逐格填写 `m1-tdx-checklist.md`，一致到小数点后 2 位。

**2026-09-09 状态更新：M1 A 层已由管理者独立验收通过**
（逐条复算 EMA/MACD/KDJ/BOLL 递推、typecheck、148 文件 736 测试全通过）。
§3.3 三项存疑已用 `tdx-doc examples/专家系统.md` 与 `czsc-tdx/src/CzscDynamics.cpp`
两个独立来源交叉佐证，实现无需修改，详见 `m1-tdx-checklist.md` 末节与 `decisions.md`。

因此 **B 层降级为「建议做」**，用于排除数据读取、复权设置、历史起点差异，
**不再是 M1 通过的前置条件，不阻塞 M2**。

**不做**：不接 UI，不接策略，不做性能优化，不实现其他指标。

---

### M2 — 图表增强

**交付**：`src/components/chart.tsx` 扩展（当前 95 行，仅 K 线 + 成交量）。

| 项 | 要求 |
|---|---|
| 主图 | K 线 + MA5/10/20/60 叠加；BOLL 上中下轨可开关 |
| 副图 | 成交量 / MACD / KDJ / RSI，用 lightweight-charts 独立 pane，可切换显示 |
| 十字光标 | legend 实时显示当前 bar 的 OHLCV 及所有已开启指标的数值 |
| 周期切换 | 日线 / 5分钟（数据已有，复用现有 `periodSchema`） |
| 历史加载 | 向左滚动加载更多历史，替代当前一次性 `fitContent()` |

**验收**

A 层（执行者自证）

1. 图表只消费 `src/lib/indicators.ts`，不得重算或内联第二套指标公式。
2. 十字光标读数与 M1 函数输出一致：抽 3 个 bar 写成自动化断言。
3. 周期切换后指标重算正确、无残留；向左滚动加载不重复不丢 bar。有测试覆盖。
4. 指标为 `null` 的区间（MA20 前 19 根等）在图上留空，不画成 0，不连线跨越。
5. 保留 TradingView 归属标识（`THIRD_PARTY_NOTICES.md` 许可要求）。
6. `pnpm typecheck`、`pnpm test`、`pnpm build` 通过。
7. 里程碑末用 Playwright 对 sh600519 日线截图，各副图各一张，
   存入 `docs/m2-review/`，并生成 `docs/m2-visual-checklist.md`
   列出每张图应核对的要点。**不得自行判定"视觉一致"。**

B 层（用户人工）

8. 用户对照通达信同一标的同一时段，逐张核对 `docs/m2-review/` 截图。

**不做**：画线工具、多图联动、自定义指标编辑器、分时图、复权切换。

---

### M3 — 缠论引擎接入（FFI）

**交付**：`src/server/czsc.ts` + `runtime/CZSC64.dll`。

依据本文件 §1.3 的架构决策与全部已知约束。

**架构决策（管理者已定，执行者不得更改）**

- FFI 库用 **koffi**。理由：活跃维护、提供预编译二进制、支持 Electron，
  不需要本机 C++ 工具链（本机确认无 g++/MinGW）。
  不用 `ffi-napi`（已停止维护，需 node-gyp 编译）。
- DLL 已由管理者预置在 `vendor/czsc/CZSC64.dll`（git 跟踪，来源 commit `b67f3c6`，
  SHA-256 `cf5601...1206c`，详见 `vendor/czsc/README.md`）。**不引用仓库外路径。**
  执行者需在 `scripts/build-runtime.mjs` 增加一步：复制到 `runtime/czsc/CZSC64.dll`。
  `scripts/prepare-desktop.mjs:6` 已递归拷贝整个 `runtime/`，桌面分发自动包含，
  不需要改它。
  （不放 `runtime/` 是因为该目录在 `.gitignore` 中且由 `runtime:build` 生成。）
- **koffi 3.2.1 已由管理者预装**（`package.json` 已含依赖，`node_modules` 已就绪）。
  执行者**不要再运行 `pnpm add`/`pnpm install`**——沙箱内无网络，必然失败。
  缺任何依赖一律停下汇报，由管理者预置。
- 调用模型：**单一专用 worker 进程内串行**。不得在多个 worker 并发加载同一 DLL。
- 若 koffi 在本项目 Electron/Next 环境下无法加载，**停下汇报**，
  不要改用其他 FFI 方案或自行移植算法。

**实现顺序**

1. 引入 koffi，加载 `runtime/czsc/CZSC64.dll`，封装 `Func30` / `Func40` 的类型安全调用。
   调用必须串行化，float32 数组转换独立成函数并测试。
2. **先做验证再做集成**：用 `czsc-tdx/tests/SseIndexDaily.h` 的 2038 根上证指数日线
   （2018-01-26 ~ 2026-06-26）作为固定 fixture 移入 `tests/fixtures/`，
   调用 DLL 后与期望输出逐项比对。**这一步不通过，不得继续。**

   **golden 权威顺序（管理者已裁定，2026-09-09）**

   1. `czsc-tdx/tests/CzscCoreTests.cpp` 中的**断言**——唯一权威，
      期望值一律从这里提取。
   2. `czsc-tdx/tests/czsc_sse_result.txt`——生成输出，与断言一致时可作辅助参考。
   3. `czsc-tdx/tests/czsc_sse_golden_notes.md` 的锚点表——**不作为验收依据**。

   裁定依据：该 notes 文件自述"生成输出会被重新生成""同级别中枢全量输出会使
   后续标号偏移"，其 SZ00–SZ03 四行表与当前 C++ 断言冲突（断言为 2 个线段中枢），
   属过期人工标注。

   **关键：七个期望值来自两套不同配置，不是一套（管理者 2026-09-09 定位）。**

   `czsc-tdx/tests/DumpSseResult.cpp:1058-1079` 构建了两个 analyzer：

   ```cpp
   BuildAnalyzerFromPrice(StrokeAn,  ..., DefaultConfig());   // 配置码 0
   CzscConfig SegmentConfig = DefaultConfig();
   SegmentConfig.nCenterUnit    = CZSC_UNIT_SEGMENT;          // 百位 = 1
   SegmentConfig.nSegmentMethod = CZSC_SEG_FEATURE;           // 千位 = 1
   BuildAnalyzerFromPrice(SegmentAn, ..., SegmentConfig);     // 配置码 1100
   ```

   `DefaultConfig()`（`src/CzscCommon.cpp:89`）= 严格笔 + 严格笔结束 +
   笔中枢 + 启发式线段 → 配置码各位全 0。

   | 期望值 | 来源表达式 | 配置码 |
   |---|---|---:|
   | 严格笔 157 | `Strokes.size()` | 0 |
   | 笔端点 158 | `StrokeAn.Points.size()` | 0 |
   | **线段端点 15** | `SegmentAn.Points.size()` | **1100** |
   | 笔中枢 18 | `StrokeAn.Centers.size()` | 0 |
   | **线段中枢 2** | `SegmentAn.Centers.size()` | **1100** |
   | 笔买卖点 17 | `StrokeAn.Candidates.size()` | 0 |
   | **线段买卖点 2** | `SegmentAn.Candidates.size()` | **1100** |

   `Func30` 的 mode 码 = 配置码×1000 + 输出类型×10，
   故线段族的 mode 基数为 1,100,000（float32 可精确表示至 2^24，安全）。

   **仅比对总数不够**：`czsc_sse_result.txt` 逐条列出了 BZ00–BZ17（18 个笔中枢）、
   SZ00–SZ01（2 个线段中枢）、L001–L015（15 个线段端点）的方向、起止日期与
   ZG/ZD/GG/DD。数量对上后必须逐条比对这些字段，数量相同但内容不同同样算失败。

   线段中枢锚点（取自 `TestRealSseGoldenSegmentCentersPresent`，
   `nCenterUnit=CZSC_UNIT_SEGMENT`、`nSegmentMethod=CZSC_SEG_FEATURE`）：

   | 方向 | 起 | 止 | ZG | ZD |
   |---|---|---|---|---|
   | 上升(1) | 2018-11-19 | 2020-07-09 | 2822.19 | 2822.19 |
   | 下降(−1) | 2020-09-25 | 2023-06-26 | 3418.95 | 3312.72 |

   笔中枢锚点同样从 `CzscCoreTests.cpp` 的对应断言提取，不要用 notes 表。
   若再遇到来源冲突，一律以 `CzscCoreTests.cpp` 为准，不必再问。
3. 定义 TS 侧结构化结果类型：`{ 端点[], 中枢[], 买卖点[], 走势类型[], 信号质量[], 背驰段[] }`，
   由多次 `Func30` 调用组装。记录使用的配置码与 DLL 文件 hash。
4. 缠论结构渲染到 M2 图表：笔/线段连线、中枢矩形（ZG/ZD 上下沿）、
   三类买卖点标记、背驰段区间。
5. `THIRD_PARTY_NOTICES.md` 记录 czsc-tdx 来源、版本、GPL v3 许可。

**验收**

1. 第 2 步的 golden 比对全项通过，写死进 `tests/czsc.test.ts`。
2. 真实本地通达信数据（sh600519 等 3 只）跑通，结构渲染到图上，人工视觉核对合理。
3. 串行化有效：并发请求下结果与串行调用一致，有测试覆盖。
4. 数据不足（K 线过少）时明确返回"无结构"，不产生虚假笔/中枢，有测试覆盖。
5. `pnpm build` + `pnpm desktop:prepare` + `pnpm desktop:smoke` 通过，DLL 正确随打包分发。

**不做**：不移植 C++ 算法、不改 DLL、不接推送（M4 做）、不做多级别联立。

**分发决策**：GPL v3 义务问题**停下来问用户**，不自行决定是否捆绑分发。

---

### M4 — 策略插槽与信号推送

现有推送链路已完成（60 秒监控、完成 K 线判定、基线建立、"不满足→满足"边沿触发、
outbox 重试、四渠道格式、LLM 解读追加）。本里程碑做插槽化 + 接线。

1. `strategySchema`（`src/lib/domain.ts:42`）从写死双均线泛化为
   `{ type: "ma-cross" | "czsc", params }`，保持旧配置向后兼容。
2. 缠论信号接入现有 monitor 循环，**仅日线**，15:05 后触发。
   信号定义：新出现的一/二/三类买卖点（用 M3 的 `信号质量` 过滤，仅"确认"及以上）。
3. 推送消息补充：买卖点类型、信号质量、所属中枢 ZG/ZD、背驰依据、
   **失效条件**、数据日期、策略版本、DLL 版本。
4. LLM 解读用 `chan-theory` 技能生成课文溯源说明，作为追加消息，
   失败不影响规则信号已发送。

**验收**

A 层（执行者自证，**不得向任何第三方发送真实消息**）

1. 信号从缠论结果生成到进入 outbox 的完整链路，用受控假渠道端到端测试；
   断言 outbox 记录内容含全部必需字段，实际网络投递数为 **0**。
2. 生成的消息文本快照写入 `docs/m4-message-samples.md`，供用户目视确认可读性。
3. 旧的双均线订阅升级后行为不变，有测试覆盖。
4. 停牌、数据过旧、非交易日、重复边沿不产生信号，有测试覆盖。
5. LLM 解读失败不影响规则信号已发送，有测试覆盖。
6. `pnpm typecheck`、`pnpm test`、`pnpm build`、
   `pnpm desktop:prepare` 后 `pnpm desktop:smoke` 通过。
   （注意顺序：不先跑 `desktop:prepare` 必然失败，前两个里程碑均因此误报。）

B 层（用户人工）

7. 用户在已配置的飞书渠道点「发送测试通知」，确认真实投递与内容。
   这是唯一一次真实外发，由用户触发，**执行者不得代劳**。

**不做**：5 分钟线信号（日线运行一段时间后再评估）、自动下单、模拟盘。

---

### M5 — 双突破引擎（自研）

**交付**：`src/server/breakout.ts`，确定性计算，不调用 LLM，不调用外部数据源。

方法依据：`~/.agent-skills/skills/swing-trader/SKILL.md` Phase 3–4
及 `references/trading-system.md` 第 1–4 节。实现时必须重新读取技能原文，
并记录 `skillId` 与文件 hash（复用现有 `research-skills.ts` 机制）。

**实现顺序**

1. **摆动高低点识别** —— 复用 `vcp-diagnostic-2` 已有逻辑（前后各 3 根严格极值、
   `confirmedAt` 标记、同日高低歧义作为屏障）。不要重写第二套。
2. **趋势线拟合** —— 连接摆动高点得下降趋势线、摆动低点得上升趋势线；
   记录触及次数，触及不足 2 次不成立。
3. **支撑压力位** —— 波段高低点、缩量整理平台上下沿、放量长阳/长阴收盘价、
   MA20/MA60、整数关口。每个位标注来源类型。
4. **双突破判定** —— 做多：阳线实体收盘突破下降趋势线 + 突破近期压力位 +
   成交量 ≥ 20 日均量 × 1.5。做空对称。三要素各自返回 是/否/数据不足。
5. **信号质量评分** —— 5 项：趋势线突破、关键位突破、放量确认、
   指标确认（MACD/KDJ/RSI/BOLL 中 ≥2 个同向，用 M1 结果）、K 线形态确认。输出 `x/5`。
6. **风险回报比** —— 止损取结构位，目标一/二取上方压力位；
   统一写作 `1:X`，`X = 第二目标空间 / 止损空间`。
7. 接入 M4 的策略插槽，`type` 增加 `"dual-breakout"`。

**边界**：K 线形态识别只实现评分第 5 项所需的最少几种
（锤子线、看涨/看跌吞没、启明星/黄昏之星），**不做完整形态库**。

**数据不足时一律返回"未知"**，不得用局部极值、短历史或缺失指标拼凑成立的信号。

**验收**

1. 3 个人工确认的历史案例（1 个有效突破、1 个假突破、1 个数据不足）逐项复算通过，
   写死进 `tests/breakout.test.ts`。
2. 信号在 M2 图表上可视化标注，与人工判断一致。
3. 追加未来 bar 不改变历史信号（复用现有 future-leak 测试基建）。
4. 全市场日线批量运行不超过既有选股任务耗时的 2 倍。

---

## 4. 工程纪律

### 4.1 验证分层

时间黑洞是把全套验证绑在每个微改动上。改为：

```
每次改动     → vitest run --changed + tsc --noEmit        （秒级）
每个子任务   → pnpm test                                   （全量）
每个里程碑   → build + desktop:prepare + desktop:smoke
               + Playwright + desktop:pack                 （全程仅 5 次）
```

**禁止**为单个函数改动运行桌面冒烟或 Playwright。

### 4.2 禁止新建一次性脚本

`output/` 已有 545 个文件 / 27 MB，全部未被 git 跟踪，且被 25 篇 `docs/*.md` 引用为证据。
**冻结不删**（删除会破坏文档引用），但**不得再新增任何文件**。

需要验证的东西，要么写成 `tests/` 下的持久用例，要么不写。

### 4.3 决策日志取代进度日志

`docs/optimization-progress.md` 冻结归档，不再追加。
新记录写入 `docs/decisions.md`，只记三件事：

- 做了什么决策
- 放弃了什么、为什么
- 遇到的与预期不符的事实

**禁止记录**"N 项测试通过 / 类型检查通过 / 构建通过 / 桌面冒烟通过"——
这是 CI 的职责，不是文档的。前一份日志 1159 行里绝大部分是这类内容。

### 4.4 范围控制

- 里程碑严格串行，M1 未验收不得开始 M2。
- **执行者不得自行扩展范围。** 发现"顺手也该做"的事，记入 `docs/decisions.md`
  的待议清单，不实现。
- 遇到本文件未覆盖的决策点，**停下来汇报**，不自行决定。
- 冻结清单中的模块，即使发现 bug 也只记录不修复，除非它阻塞当前里程碑。

### 4.5 保持不变的既有约束

`AGENTS.md` 中关于通达信源数据只读、密钥处理、通知需显式订阅、
打包统一 `pnpm desktop:pack` 且只保留 `release/win-unpacked` 的规定继续有效。
