# 项目模块重构与文档计划

状态：用户已于 2026-09-23 授权执行；R0—R6 已完成。本文是本轮范围、裁定和验收基线。

## 1. 目标

把项目整理成可以按模块理解、维护和验证的结构。每个模块都要能回答：它负责什么、不负责什么；从哪里进入；对外提供什么；依赖哪些模块；会读写什么状态或产生哪些外部效果；由哪些检查保护。

重构按可独立验收的模块逐批推进。允许移动目录、拆分职责、缩小公开接口和删除确认过时的转发层；不能以减少文件数或追求整齐为验收标准。模块职责改变前，先记录现有行为与调用契约。

## 2. 现状依据

- 当前项目入口是 Next.js App Router、React 工作台、tRPC 服务端、SQLite、本地行情及 Electron 桌面宿主。主要数据流和约束已在 [architecture.md](architecture.md)、[invariants.md](invariants.md) 与 [operations.md](operations.md) 中说明。
- `src/server` 已按策略、数据源、回测、研究、筛选、监控、组合等职责完成 S0—S5 分域。该成果与验收记在 [strategy-consolidation-plan.md](strategy-consolidation-plan.md)；本计划不重做这轮搬迁。
- 仍有显著的集中点：`src/server/api/root.ts` 约 2,093 行；`src/server/runtime.ts` 约 735 行；`src/lib` 根目录有 182 个 TypeScript 文件；`tests/` 有 487 个平铺的测试/规格文件。
- `src/components` 已按工作台、行情、筛选、研究、组合等领域分目录；`src/lib` 与 `src/server` 也有多处对应领域目录，但跨层模块契约主要集中在一份总览文档，尚无统一的模块清单与模块级文档约定。
- 独立 package `trading-strategy-core`、`trading-strategies`、`tstdx` 已各有 README；它们的职责不同，不应为了统一目录而合并。
- `docs/README.md` 当前状态日期仍为 2026-09-11，而路线图和模块地图包含更晚的变更。文档首批工作应先校准阅读入口与真实模块状态。

以上是初步证据，不代表已完成所有文件的依赖图、动态路径、反射加载、worker 与构建入口盘点。准确搬迁清单必须在获批后的模块基线阶段逐项生成。

## 3. 架构方向

建议保留运行时和框架有意义的顶层边界：

```text
src/app          Next 路由与页面组装
src/components   展示、交互和工作台布局
src/lib          纯规则、领域类型与输入/输出契约
src/server       应用服务、持久化、数据源和后台协调
src/trpc         客户端/服务端传输适配
packages         有独立构建与复用边界的 package
electron         桌面窗口、服务进程生命周期与宿主能力
scripts          构建、迁移、审计和一次性运维入口
tests            行为、契约和进程边界验证
```

在这些边界内按业务域建立明确模块；不把所有代码机械搬入新的 `src/features`，也不保留让所有职责都落入 `lib`、`common` 或 `utils` 的模糊入口。理由是 Next 客户端/服务端边界、worker 打包入口和独立 package 构建本身都是实际的运行边界；将它们压平会增加依赖与打包风险。对跨层业务则用模块文档和明确的导入面建立纵向对应关系。

### 目标模块清单（第一版）

| 模块 | 主要代码面 | 文档必须覆盖的边界 |
| --- | --- | --- |
| 工作台与路由 | `src/app/`、`src/components/workbench/`、`overview/`、`panels/` | 页面只做路由和组装；导航、状态、页面缓存和服务端/客户端组件边界 |
| 行情与图表 | `components/market/`、`lib/chart/`、`lib/market/`、`server/market/`、`server/charts/` | 行情源、周期聚合、图表状态、缓存、缺失行情语义与只读源数据 |
| 选股与 RPS | `components/screening/`、`lib/formula/`、`lib/screening/`、`server/screening/` | 公式语法/安全边界、筛选任务、RPS 分类与结果身份 |
| 策略与信号 | `server/strategies/`、`server/monitoring/`、`components/signals/`、`components/intraday/`、相关 `lib/` 与策略 packages | 规则计算、方法/preset 身份、监控订阅、全市场观察台账和推送的分界 |
| 研究与回测 | `components/research/`、`components/backtest/`、`lib/research/`、`lib/backtest/`、`server/research/`、`server/backtest/` | 输入快照、时点证据、任务生命周期、执行模拟、研究结论与证据等级 |
| 组合与交易账本 | `components/portfolio/`、`server/portfolio/`、`lib/portfolio/` 及交易复盘相关页面 | 手工成交事实、信号关联、现金/红利、除权审计、模拟盘显式动作 |
| 新闻与财联社复盘 | `components/news/`、`server/news/`、`lib/news/`、相关页面 | 原始新闻、聚合/分类、模型解读、来源时间与报告保存 |
| 数据源适配 | `server/data-sources/`、`packages/tstdx/`、数据源契约 | 每个供应商的能力、时效、单位、失败语义；供应商层不依赖策略或回测 |
| 持久化与基础设施 | `server/db/`、`server/infra/`、`server/data/`、`server/vault.ts` | SQLite schema/migrations、隔离目录、事务/缓存/凭证/通知/并发所有权 |
| API 与后台任务 | `server/api/`、`src/trpc/`、`app/api/`、`server/jobs/`、`server/runtime.ts` 与 workers | 传输契约、验证/授权、任务状态/取消、启动顺序、worker 构建及关闭 |
| 桌面与构建交付 | `electron/`、`desktop/`、`runtime/` 生成边界、桌面构建脚本 | Electron 与 bundled Node 的职责、进程树、产物生成/替换和本地启动 |
| 工程工具与验证 | `scripts/`、`tests/`、fixture、顶层配置 | 脚本副作用、测试归属/运行方式、生成文件、受保护数据及维护入口 |

清单按实际消费者可在基线阶段合并或拆分；除 `mcp.ts` 既有保护边界外，模块归属不能仅根据文件名前缀推断。

## 4. 模块文档标准

在 `docs/modules/` 建立一个索引和按模块划分的文档。现有 `architecture.md` 保留系统级依赖图、主数据流及全局接手路径；把重复的业务细节逐批搬到对应模块页，并让模块页反向链接到源文件和测试。避免给每个 TypeScript 文件单独写说明，也避免复制 `invariants.md` 与路线图中的完整规则。

每份模块文档使用同一短模板：

1. **职责与非职责**：该模块服务的业务能力、明确不拥有的工作。
2. **入口与调用者**：页面/API/worker/CLI 入口及真实消费者。
3. **契约**：输入、输出、错误、持久格式和对外导出；标注可变实现与不可静默改变的行为。
4. **依赖方向**：模块依赖及禁止反向依赖；需要跨层协作时标出组装点。
5. **状态与效果**：数据库表/迁移、文件、缓存、子进程、网络、凭证和通知；没有副作用也明确写出。
6. **关键不变量和验证**：链接到全局不变量、代表性测试、模块专用命令与人工验收边界。
7. **维护指南**：新增功能放置规则、模块文档更新条件、可安全删除或迁移的旧入口。

文档由对应模块变更的同一实施批次维护。模块结构或入口变化时，模块页及中央地图必须一起更新；验证记录只写交付说明，不把临时结果写成永久架构事实。

## 5. 分阶段计划

### R0：建立真实基线

- 为目标清单中的每个模块登记：路径、职责、入口、公开导出、静态/动态消费者、状态/外部效果、测试、构建或 worker 接线、现存文档。
- 从 TypeScript 导入、页面/API 调用、字符串路径、workspace/build 配置、runtime entry points、迁移/schema、脚本和测试中核对依赖；区分已证实静态边与待运行时核对边。
- 记录超大文件和跨域/循环依赖，但只有能改变模块边界的证据才升为拆分任务。
- 给模块标记模块内部、跨模块、tRPC/页面调用、持久化及宿主边界；盘点是否有未声明但消费者依赖的可观察契约。

**验收**：每个模块有 owner/职责/路径/消费者/状态/验证映射；受保护路径和生成/只读目录单列；没有把动态加载不明说成“无引用”。

### R1：建立文档骨架与模块地图

- 先整理 `docs/README.md` 的阅读入口和状态日期；保持 `roadmap.md`、`next-plan.md` 为范围/交付源。
- 保留 `docs/architecture.md` 的系统图和主要流向；新增 `docs/modules/README.md` 及模块文档模板。
- 先完成 API/任务、市场数据、研究回测、信号监控、组合账本、策略、新闻、数据源/持久化、桌面/运行时等模块页；每页使用 R0 的真实路径、入口和验证证据。
- 对照旧 architecture 段落迁移，不删失仍有效的不变量、限制与失败事实；过期语义链接到 decisions 或归档。

**验收**：模块清单完整、文档之间无重复真源、所有仓内相对链接有效、路径引用存在；代码零改动。

### R2：拆分 tRPC 聚合入口

- 将 `src/server/api/root.ts` 中按业务域聚集的 procedure 定义迁入域 router 文件；顶层只负责装配。
- 在拆分前逐项导出现有 procedure name、input/output schema、错误语义、授权位置、客户端调用者和后台任务委派路径。
- 保持现有 tRPC procedure 路径/客户端推断类型兼容；若发现需要改 wire path 的更好设计，单列方案，不混入无版本切换。

**验收**：路由目录与旧目录逐项匹配；相关 UI/API 合约测试、typecheck、全量测试和 build 通过；取消、分页、错误传播与权限检查无变化。具体拆分粒度待 R0 import/consumer 图确认。

### R3：收拢 `src/lib` 纯模块

- 以 `src/lib` 根部 182 个 TypeScript 文件为清点起点，按实际责任批次迁入现有 `market`、`chart`、`formula`、`screening`、`research`、`backtest`、`portfolio`、`news`、`contracts`、`strategy-facts` 等模块。
- 对无法归属的文件先标明真正的跨域职责，再决定留在根部、抽入现有 `common` 或转入已存在 package；不创建无主 `utils` 包，不仅因多个消费者就抽取共享模块。
- 只有无 Next、数据库、文件系统、环境变量、数据源或 DLL 副作用的稳定核心才考虑进入 `trading-strategy-core`；不扩大该 package 的职责。
- 同批更新调用、测试、脚本、文档、方法实现路径和运行时路径引用，消除临时转发层。

**验收**：每个根部保留文件有明确理由；领域纯函数无重复实现、无反向依赖；路径迁移前后固定输入输出及缺失语义一致；相关测试、typecheck 和全量测试通过。

### R4：收紧服务端业务模块与组合根

- 在已完成 S0—S5 分域的基础上检查 `runtime.ts`、跨域服务、数据库 store 与 workers；只拆有不同生命周期、所有权或变化原因的混合模块。
- 保持业务 store 随所属域；基础设施只收容确属横切机制的代码；供应商读取仍由 data-sources 拥有，业务模块不直接复制协议解析。
- 明确 API、jobs、runtime 的职责：入口验证/调度、模块用例执行、runtime 生命周期组装；逐域更新模块文档。
- `src/server/mcp.ts` 及其 UI 文案为用户维护，未经明确交接不触碰；其五个直接依赖的既有路径保留或先另行取得迁移裁定。

**验收**：所有 workers 仍可由 runtime 构建并从实际输出路径加载；进程串行所有权、取消、进度、崩溃/重启边界和 DB 隔离不变；worker/runtime 专项、typecheck、全量测试及 build 通过。

### R5：梳理页面与组件边界

- 让 `src/app` route/page 尽量只做路由参数、数据入口和模块装配；业务交互归 `src/components/<domain>`，schema/纯规则归 `src/lib/<domain>`，服务器用例归 `src/server/<domain>`。
- 对跨域面板、通用表单和工作台壳逐一核验消费者；只有稳定 UI 能力才留在 `common`/`ui`，业务组件不放 `src/components/ui/`。
- 将组件状态、URL 参数、缓存、服务端/客户端边界写入对应模块文档；不因整理改视觉、默认值、文案或交互。

**验收**：页面路由与可见功能不变，server/client import 边界有效，受影响交互测试和浏览器检查通过；不改 `src/server/mcp.ts` 的 UI 文案。

### R6：测试结构、边界护栏和退役

- 把 `tests/` 平铺测试按模块逐批归档到 `tests/<module>/` 或既有 package 测试目录；必要的跨模块集成与固定历史路径保留明确标签。
- 更新所有相对 fixture、脚本、文档、覆盖率和根测试运行规则；每批移动前后测试发现数量一致。
- 扩充 `src-organization.test.ts` / `server-layout.test.ts` 一类轻量护栏：只校验已裁定的依赖方向、公共入口和保护路径，不用大而全的自制静态分析器。
- 全部消费者切换后删除临时 re-export、旧目录和未用入口；先逐项证明可达性、无动态/字符串消费者后再删。

**验收**：测试发现数量/跳过数可解释且无丢失；错误依赖反例能被护栏拒绝；旧入口无消费者；文档链接、类型检查、全量测试、build/runtime 均通过。

## 6. 兼容和实施纪律

- **行为保持**：此次目标是结构和理解成本，不调整策略算法、阈值、交易状态、数据来源、复权、计算精度、通知授权、错误值、任务状态或 UI 行为。
- **tRPC**：procedure 名称、输入输出 schema、错误及授权顺序视为客户端契约；变更需单独提出。
- **数据库与产物**：不增删迁移、不重建/清理数据库或 evidence，不改历史迁移、`user_version`、vendor/DLL 与外部 Blocks。结构整理若确需迁移须先另列数据迁移及恢复方案。
- **运行时**：逐项检查静态/动态 import、字符串路径、worker entry points、资源路径、runtime build/prepare、package exports、脚本和文档；仅 tsc 通过不足以宣布完成。
- **隔离**：任何可能打开数据库或启动应用的验证均使用独立 `QUANT_DATA_DIR`；本计划不授权打包、提交、推送、发布、真实通知或交易。
- **推进方式**：每批只改一个或一组高度耦合的模块，保留可审查 diff 和回退点；批末检查通过后再继续。不得以临时 re-export 或更换目录掩盖依赖未理清。

## 7. 最终完成判据

1. 每个目标模块在唯一索引中有责任人/代码路径/文档/入口/消费者/效果/测试链接；明确记录例外，不存在“其他/未分类”永久桶。
2. `src/lib`、API 根 router 与 runtime 组合文件的职责均有边界；大文件的保留须说明它为何仍是单一职责，不以行数阈值机械拆分。
3. 跨模块只能通过有意维护的导出或明确组装点依赖；保护层之外的循环与横向穿透都有处置记录；不残留无主兼容层。
4. 全局 architecture 保持可读，模块文档贴近模块生命周期；关键合同、状态/副作用和测试一眼可查。
5. 目标行为不变的测试/固定输入证据、typecheck、全量测试、Next build、必要的 runtime/worker 和受影响浏览器验收均按批次留存；任何无法验证的动态路径或外部行为显式标记。
6. `roadmap.md` 与 `next-plan.md` 只在获批实施后更新当前范围和验收，不把提案误登记为已授权或已完成。

## 8. 执行阶段记录

用户批准保留现有框架/宿主边界并强化纵向领域模块，范围包括测试归档。R0—R6 已按批准范围执行和验收；任何影响 API/persisted contract、DB schema、外部效果或 protected MCP 的决定不从“激进重构”推定授权。

- **R0—R1 完成**：核对主要页面/API/runtime/worker 入口，建立模块地图与 13 个模块文档；文档相对链接完整。
- **R2 完成**：API procedure 按原名和 query/mutation 类型分布到 10 个域 router，根 router 仅合并；新增完整路由契约快照式断言。
- **R3 完成**：180 个原 `src/lib` 顶层规则/契约文件按实际 owner 入域；根目录只保留跨域 domain contract 与稳定核心入口，无无主 utils 目录。
- **R4 完成**：快照、选股和回测任务分别归属 market/screening/backtest；runtime 聚焦启动恢复、调度和监控周期；worker 构建入口与输出名不变。
- **R5 完成**：`research/data-guide` 与 `ui-gallery` 页面改为轻量 route 组装；业务组件归属 market/signals/workbench/data-sources，基础控件和跨业务 UI 边界有独立文档，未改变页面内容和交互。
- **R6 完成**：487 个 test/spec suites 全部归档至模块目录，测试根保留共享 fixture/helper/setup；修复相对 imports、mock、`import.meta.url` 与固定脚本路径，并加结构护栏。
- 仍保留明确的跨域边界：`src/lib/domain.ts`、根级 `indicators.ts`/`money.ts`/`completed-bars.ts`；个别数据脚本/复核文档的动态路径仍以实际运行入口为准。模块地图标明尚未用静态护栏穷尽的运行时动态引用。
