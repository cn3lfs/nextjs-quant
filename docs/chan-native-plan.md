# 缠论原生结构扩展计划（B4 挂起 9 项）

日期：2026-09-17。用户已授权单独拟定计划并拉分支实施。分支：`chan-native`。

对应 [B4 批次](trading-skills-execution-optimization.md) 挂起的 9 项：`CH06`、`CH07`、`CH08`、`CH09`、`CH10`、`CH11`、`CH12`、`CH13`、`CH18-small-to-large`。这 9 项在 B4 中被逐项登记为原生结构缺口或历史输入缺口，未用 kind 标签或趋势方向销账，也未自造近似冒充原文方法。

## 1. 调研结论（只读核查，已完成）

### 1.1 缺口不是算法缺失，是投影面缺失

| 事实 | 证据 |
| --- | --- |
| DLL 为第三方 GPL v3 作品，但**源码在本机且可重建** | `vendor/czsc/README.md`：来源 `D:\github\czsc-tdx` commit `b67f3c6`，848,571 字节，SHA-256 `c0ac4c51…`，2026-09-09 由管理者用 WSL Ubuntu-22.04 + MinGW-w64 `make mingw64` 重建 |
| 构建工具链可用 | `wsl -l -q` 返回 Ubuntu-22.04 |
| 完整结构在 C++ 侧本来就在内存里 | `src/CzscTdxExports.cpp:821/826/845` 的 `ApplyTradingSignal*(nCount, pOut, An.Candidates, An.Centers)`——`An.Candidates`、`An.Centers` 是完整集合 |
| 现有输出只投影**胜出候选**的属性，且每根 K 线一个 float | `czsc-worker.ts` 的 `CzscCalc(int n, float *out, …)`；`czsc.ts` 校验 `output <= 58` |
| 因此拿不到"走势成员列表""高级别候选表"这类数组 | 9 项缺口登记逐条指向这一点，例如 CH06「trendId 不是可访问的走势数组」、CH07「缺 output50 索引的完整高级别 Candidates 表」 |

**结论**：这 7 项原生缺口的正确解法是**在 C++ 侧新增只读投影并重建 DLL**，把已算好的结构以"每根 K 线一个标量"的形式暴露出来。这不违反既有不变量——不在 TS 移植算法、不并发进 DLL、仍是宿主内单一串行所有者。

### 1.2 依赖收敛：3 个原生能力解锁 7 个方法

| 原生能力 | 直接解锁 | 传递解锁 |
| --- | --- | --- |
| **N1 完整走势成员**：逐根投影所属走势编号、级别、完成状态（CH06 缺口） | CH06 | CH13（月线背驰后需趋势成员/完成证明） |
| **N2 高级别候选表**：逐根投影候选索引与起止段标记，不以胜出 signals 替代（CH07 缺口） | CH07 | CH12（需高级别背驰段与低级别买点包含关系） |
| **N3 已完成同级别走势序列**：逐根投影走势序号、连接边界、级别（CH08 缺口） | CH08 | CH09（下跌-盘整-下跌到上涨/盘整退出）、CH10（已完成走势到新走势确立的中阴进入/结束）、CH18（前趋势最后中枢的次级别完整走势类型与回抽退出边界） |

### 1.3 另两项不是 DLL 问题

- **CH13 月线底部**：`src/server/monthly-bars.ts` 的 `monthlyBars()` **已存在**，B4 当时被禁止新增通道才登记为缺口。实际只需把它接入缠论研究路径，加上 N1 的趋势成员证明。**周线不得代替月线**这条继续有效。
- **CH11 均线轮动板块强弱**：唯一真正的数据阻塞。需要**时点板块成分**与各板块同窗均线/强弱排序。`industry-blocks.ts` / `rps-block-source.ts` 提供的是**当前**成分名单（带 hash 与 mtime），不是历史成分。现有双基准 RS 不是板块轮动，不得冒充。

## 2. 分批实施

分支 `chan-native`，与 master 的 B7 收口批互不干扰。

| 批 | 内容 | 验收 |
| --- | --- | --- |
| **C1 原生投影扩展** | 在 `czsc-tdx` 源码新增 N1/N2/N3 三类投影（输出号 59 起），`make mingw64` 重建，`make sse-result-check` 证明既有输出逐字节不变 | 新旧 DLL 对**现有全部输出**逐根一致；golden 校验通过；记录新 DLL 的 SHA-256 与源码 commit |
| **C2 投影接线** | 更新 `vendor/czsc/`（DLL + README 的 hash/commit/构建方式）、放开 `czsc.ts` 的输出上限、把 N1/N2/N3 接入 `czsc-structures.ts` 与 `czsc-research-structures.ts` | 固定 fixture 上新投影与 C++ 侧结构一致；单一串行所有者与逐前缀不变；既有 czsc 测试全过 |
| **C3 七项方法** | CH06 → CH07 → CH08 → CH09/CH10/CH12/CH18 | 每项有正反例；候选与确认时间分离；不得用全区间最终结构回填过去 |
| **C4 CH13 月线** | 接入既有 `monthlyBars()` + N1 趋势成员证明 | 月线已完成周期判定显式；周线不代替月线；缺完整月线周期即不可用 |
| **C5 CH11 定性** | 时点板块成分为真实缺口：按"待数据策略"交付——规则 + 适配 + 固定输入可验证，`availableAt` 必需，缺历史成分即返回 missing | 不用当前成分回溯冒充历史；不把双基准 RS 说成板块轮动 |
| **C6 批末 L3** | `normalize:eol` → `verify:batch` → Playwright → format/diff | failures 为空；K6 planned 归零或仅剩明确登记的待数据项 |

## 3. 硬约束

- **不在 TS 移植缠论算法**；新增能力一律走原生投影。不并发进 DLL，宿主内单一串行所有者、整任务原子排队不变。
- **重建必须先证明无回归**：`make sse-result-check` 与现有 golden 比对通过，且新 DLL 对既有输出逐根一致，才允许替换 `vendor/czsc/CZSC64.dll`。替换时同步更新 README 的 hash、commit 与构建方式。
- **GPL v3**：源码与 DLL 为 Martin Tang 的 GPL v3 作品，修改版仍受 GPL。本计划只做本机研究用途；**对外分发与捆绑许可由用户决定**，不得因已有 exe 就认为许可已确认（沿用架构不变量）。
- 不把 DLL 的 `kind=1/2/3` 自动宣称原文全覆盖；仍不能由输出证明的方法继续标结构缺口，不自造近似。
- 月线/板块输入遵守时点纪律：报告期不是披露日、当前成分不回溯、`availableAt` 缺失即 missing。
- 提交与推送由管理者统一做；分支合并前跑一次完整 L3。

## 4. 与 master 的关系

master 上 B7（K12 14 + K13 12）继续收口，不受本分支影响。两边都完成后再合并，合并前重跑 L3；若 master 期间改了 `czsc.ts` 或方法清单，以合并时的实际冲突为准逐项核对，不盲目取一侧。
