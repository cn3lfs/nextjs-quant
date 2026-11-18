# 开发规范

`invariants.md` 管**正确性**（违反会算错），本文管**一致性**（违反会让代码越来越难改）。
两者都不写"怎么用某个库"，那查官方文档。

规范按现状归纳，不是凭空设计。有分歧时以仓库里**已存在的多数写法**为准，
不要引入第二种风格；确实需要改的，先改规范再改代码。

---

## 1. 工具链

- **Prettier 是唯一格式化权威**。当前已安装 ESLint，`pnpm lint` 检查 src 和六包源码；类型感知规则用于 src，固定动态路径规则也覆盖包内源码。提交前 `pnpm format:check` 必须通过。
  2026-09-12 起该命令**确实通过**；在此之前它长期为红，原因不是风格漂移：

  `core.autocrlf=true` 设在用户全局 `.gitconfig` 里，仓库又没有 `.gitattributes`
  覆盖，所以 git 每次 checkout 都把工作区文件转成 CRLF，而 prettier 默认
  `endOfLine: "lf"`，于是**凡是被 git 重写过的文件一律判红**。
  2026-09-10 那次 `prettier --write`（53 个文件）修的是内容，
  git 下次 checkout 又把 CR 加回去——用这个办法永远修不好，
  红文件数还会随「git 刚好动过哪些文件」在 37–44 之间漂。

  实际修法：新增 `.prettierrc.json` 设 `endOfLine: "auto"`，
  让 prettier 接受工作区的行尾（git 仓库内存的始终是 LF，不受影响）。
  同时新增 `.prettierignore` 排除 `tests/fixtures/`——
  fixture 是数据不是代码，重排会改掉测试断言的内容
  （`ths-statement.html` 供 `fingerprintSource` 断言，
  重排 JSON 会让 R2/R2c 记录的文件 hash 失效）。
  排除后仅剩 5 个文件是真实风格差异，已格式化。

  **教训**：这就是 `§9.6` 表格第 2 条本身。当时判定为「定规则前没验证现状」，
  但诊断只对了一半——真正的问题是**连根因都认错了**，
  于是开的药（`prettier --write`）注定无效，规则也就红了两天。
  定规则前不仅要跑一遍，还要确认失败的**根因**，别对着症状反复用同一副药。

- 复用已安装的 ESLint 与 Prettier，不另建并行工具链。风格争议由 Prettier 裁决，Prettier 管不到的看本文。
- `pnpm lint` 对 `src` 启用项目类型信息：Hooks 调用规则、未处理的 Promise、TypeScript 未使用变量均为错误。未使用的回调参数/捕获错误可明确命名为 `_...`；对象 rest 排除字段允许省略。显式 `void` 表达后台调用意图，但不处理拒绝；Query 刷新由查询状态展示失败，其他后台任务应等待或接入已有错误记录，不能为过 lint 批量补 `void`。
- 导入边界：components/lib 不执行 server 模块，server 不执行 components/app 模块；跨层类型必须使用 `import type` / `export type`。ESLint 保留快速静态检查，并要求 import()/require()/module.require() 使用固定字符串或无插值模板；变量路径应改为显式加载器映射。
- `pnpm check:dependencies` 使用 dependency-cruiser 扫描 src 与各工作区包的源码，解析别名、公开导出、重导出、固定动态导入和 CommonJS；不递归第三方 node_modules，不用 dist 代替源码。未解析路径、包对宿主的依赖和运行时模块循环均失败；显式类型引用不当作运行时边。包级图按归属聚合实际依赖，并纳入 dependencies/devDependencies/optionalDependencies 的内部构建依赖，用 graphlib 检查不同文件/子目录形成的循环；包级类型依赖也必须单向。两项工具只作为锁定版本的开发依赖，不进入应用运行链。静态检查不执行代码，也不推断自定义加载器或运行时拼接字符串；新增间接加载方式必须补规则及正反例。
- **优先复用已有依赖**。确需新增先说明用途与影响，依据当前授权和环境处理；安装受阻报告实际原因，不手写替代品绕过。

- 六个内部包通过根 `packages:build` 按 pnpm workspace 依赖顺序构建，各包共用 `scripts/build-package.mjs`。源码、配置、工具链、依赖包产物和输出内容均匹配缓存凭据时跳过编译；缺失/改变的产物会重建，删除源码不会遗留旧输出。策略身份生成器及额外源码输入在 `quantBuild` 声明。`runtime:build` 先构建包再生成 worker；`build` / `dev` 经由它，不额外重复调用包构建。`typecheck` / `test` 共用此入口，测试仍执行原生构建与各包测试；runtime/native 不因包缓存而跳过。
- `pnpm check` 顺序执行全仓 `format:check`、依赖检查、runtime 构建、类型检查、lint 和完整测试，`pnpm check --build` 再执行生产构建；首个失败立即返回非零退出码。每次在 `.test-data/checks/check-*` 新建数据和临时目录，覆盖调用者的数据库/TEMP 设置；`QUANT_CHECK_ROOT` 只能指定本仓库 `.test-data` 下无目录链接的路径。结果写入该目录的 `check-result.json`，数据由用户审阅后手动清理。门禁拒绝递归启动，不自动打包或推送。可选 pre-push 已提供于 `.githooks/pre-push`，需要时执行 `git config --local core.hooksPath .githooks` 安装；仓库不会替用户修改 hooks 配置。2026-11-13 已收敛 140 个内容格式差异，沿用既有行尾设置和 fixture 排除，不扩大忽略范围；格式检查现为门禁首步。
- 后台错误通过 `recordRuntimeError` 在拥有恢复/用户反馈责任的边界记录，不在每层重复复制异常。事件摘要使用固定目录，错误码使用白名单；禁止传入原始请求、响应、认证信息或把 `error.message/stack/cause` 写入诊断文件。日志为当前 `QUANT_DATA_DIR/logs/runtime-errors.sqlite` 的独立文件，复用已有 SQLite 依赖，不打开或迁移业务库；滚动保留 128 组、文件上限 512 KiB，任务中心只读最近 30 组。同一分钟同事件/错误码/任务合并次数，跨进程事务更新最早/最近时间；取消和正常关闭不记录。25 毫秒内无法取得写锁、空间/权限不足等写入失败返回 false，不抛出或递归记录；任务原有失败语义保留，本进程漏记数量在查询中明确提示。

- `pnpm e2e:p0` 在当前生产构建上运行固定 fixture 的完整应用验收，先执行 `pnpm build`、`pnpm desktop:prepare`。专用配置启动新服务，每次创建独立 SQLite 与 TDX fixture，不复用已有端口。默认产物集中在 `.test-data/p0-acceptance`；`E2E_DATA_DIR` 可指定 `.test-data` 下的任务子目录，路径和链接在写入/清理测试输出前校验。覆盖现行回测失败恢复/导出、公式保存/执行/候选跳转/双突破、退役页面与暂停提示；其他大数据性能场景仍使用原 `pnpm e2e` 配置，各自独立运行。此命令不代表全路由或桌面交互验收。任务结束后核实服务退出，再清理本次生成的 fixture 和临时截图。
- `pnpm test:browser [name-filter]` 运行 tests/browser 中匹配名称的实际 .mjs 文件；只接收一个可选筛选词。无匹配、空目录、多余参数与子进程失败都返回非零退出码；零用例不能当作验收通过。
- `pnpm e2e:p1` 复用上述隔离启动器与同样的构建/准备要求，追加 41 个合成证券名和一个图表日线文件，验证证券池→第三页选股→图表→返回/刷新，检查筛选/分页、快照来源及请求次数，并输出 1440/1024 参考截图。执行时将 `E2E_DATA_DIR` 设为当前任务的独立子目录；清理遵循用户手动脚本要求，不写正式包或用户数据库。
  同一套场景覆盖 RPS 前置条件等待与恢复入口，以及非行情页面冷启动不请求默认快照、行情证券参数变化/历史返回和会话选择保留。浏览器 hook 检查 `pnpm test:browser market-state` 覆盖候选快照首次交接、来源/周期保留及迟到响应；`snapshot-load` 检查缓存/错误恢复。真实公式候选的先前错误恢复仍由 `e2e:p0` 验证。
  财务子视图场景覆盖首次按需挂载、图表设置保留、F10 切换、证券切换不读取隐藏图表、财务 URL 刷新及 1024 布局；`pnpm test:browser local-financial` 使用真实财务组件和解析 fixture，验证隐藏后缓存失效不发请求、恢复时保留筛选草稿并恢复查询，以及字段单位、阈值和导出。
  窄屏检查自选/候选列表默认收起、可展开/收起及行情区域首屏位置，宽屏侧栏保持可见；缺财务目录显示数据准备提示和连接设置入口，不能出现 ENOENT 原始错误。财务服务测试另覆盖补齐目录后恢复与其他 IO 错误不被误判。

## 2. TypeScript

- **`type` 优先于 `interface`。** 仓库现有类型定义几乎全是 `type`，不要混入 `interface`。
- **具名导出，不用 default export。** 例外只有 Next.js 约定要求的
  `page.tsx` / `layout.tsx` / `loading.tsx` / `error.tsx`。
- 字面量联合用 `as const` 派生，不要手写两遍：

  ```ts
  export const horizons = [5, 10, 20] as const;
  export type Horizon = (typeof horizons)[number];
  ```

- **不要 `any`。** 外部输入用 Zod 校验后再进入类型系统；
  实在无法建模的用 `unknown` 加显式收窄。
- 类型成员之间不留空行，保持现有紧凑风格。
- 可空语义统一用 `null` 表示"算不出来"，`undefined` 表示"没提供"。
  **禁止用 `0` 或首值填充缺失**（见 `invariants.md` §2）。

## 3. 文件与命名

| 对象        | 规则                                     | 例                             |
| ----------- | ---------------------------------------- | ------------------------------ |
| 文件名      | kebab-case                               | `signal-ledger-store.ts`       |
| 组件文件    | kebab-case，导出 PascalCase              | `data-table.tsx` → `DataTable` |
| 类型 / 组件 | PascalCase                               | `LedgerSignal`                 |
| 函数 / 变量 | camelCase                                | `weeklyBars`                   |
| 常量集合    | camelCase + `as const`                   | `horizons`                     |
| 测试        | `<主题>.test.ts`，阶段性用例可带阶段前缀 | `q2a-formula.test.ts`          |

**目录职责**

- `src/lib/` — 纯函数、类型、无 IO。可被服务端与客户端同时引用。
- `src/server/` — 有 IO：文件、数据库、网络、worker、FFI。按策略、数据源、回测、研究等职责分域，目录归属见 [architecture](architecture.md#服务端职责目录)；专用 worker/store 跟随业务域，根目录只保留组合入口与明确受保护文件。
- `src/components/` — React 组件。
- `src/components/ui/` — **只放 shadcn 组件与其薄封装**，不放业务组件。
- `src/app/` — 路由与页面。
- `tests/` — 根目录只保留全局测试设置与说明；业务回归留在对应目录。`tests/perf/` 放性能测量，`tests/fixtures/seed/` 放隔离造数脚本，`tests/manual/` 放人工审计与专用维护工具，`tests/helpers/` 放共享输入生成器/断言，`tests/browser/fixtures/` 放组件页面入口。固定数据仍在 `tests/fixtures/`，只有 seed 子目录作为代码参与格式检查。命令和运行前置见 [测试入口](../tests/README.md)。移动路径不代表人工脚本已自动验收，不整目录执行造数、网络或清理工具。

`src/components/` 的业务组件按 `workbench`、`market`、`screening`、`research`、`backtest`、`portfolio`、`news`、`signals`、`intraday`、`overview`、`common` 分域；`ui/`、`panels/`（设计交接的八种面板与 12 列网格）与 workbench 壳层是基础层。页面样式取自 `src/styles/tokens.css` 的 `--nc-*` 变量或对应 Tailwind `nc-*` 工具类，不直接写 hex；图表画布颜色取自 `src/lib/chart/chart-theme.ts`。纯函数按同一领域归档，通用样式合并入口为 `src/lib/common/classnames.ts`，不再新增无归属的 `utils.ts`。

跨 package 的纯行情、指标和资金能力以 `packages/trading-strategy-core` 为实现源；`src/lib` 只保留应用侧契约、编排和展示计算，不复制 core 实现。

纯回测核心与交易执行/费用能力以 `packages/quant-backtest` 为实现源。该包不得反向依赖应用 `src/`、Next.js、React、数据库、文件或网络；本地数据适配与任务生命周期仍归 `src/server/backtest`。按当前优化决定删除旧执行与兼容导入，不复制实现。

API 统一通过 `capabilityProcedure(capability, operation)` 创建，能力取自 `src/lib/common/capabilities.ts`，没有默认能力或无声明的公共 builder。每个 query/mutation 都显式声明：`read` 读取/投影现有数据，`configure` 保存设置或管理本地记录，`compute` 启动分析/采集/导入等工作，`schedule` 控制自动执行。操作按业务含义选择，不从 HTTP 或 query/mutation 类型推断；例如原生缠论 query 是 compute，证券池导出 mutation 是 read。

能力仅表达产品开放策略，不代替数据就绪、凭证、订阅及交易约束。暂停能力可保留 read/configure，compute/schedule 在处理器之前拒绝；通知和模拟账户仍使用自身已授权边界。`api-capability-contract.test.ts` 遍历实际注册的全部接口，新增未声明 query/mutation 会失败；`capability-policy.test.ts` 覆盖缺失/非法声明、同名独立能力及暂停保护。新增能力需同时检查页面/导航和实际 worker、CLI、调度入口，不能只依赖导航隐藏。

绩效评价独立于回测引擎：日收益指标、回撤及年季月报告归`packages/quant-performance`，公开入口为包根；应用冻结结果适配归`src/server/performance`，展示归`src/components/performance`。新功能先明确业务职责、事实来源及写入事务归属，再划分模块；只读派生不混进撮合/记账事务。按当前职责复用已有包或建立独立模块，不为形式拆包，也不预建通用插件框架。

RPS 的收益、排名、资格和板块等权聚合以 `packages/quant-rps` 为唯一实现源，公开入口为包根；应用负责 IO、后复权准备、成分快照校验、证据哈希、任务和发布存储。计算模块不反向依赖应用、宿主或 UI。

## 4. UI

这一节是本次统一的重点。

- **不写原生表单元素。** `<input>` `<select>` `<textarea>` `<button>` `<table>`
  一律用 `src/components/ui/` 下的对应组件。
  确有组件覆盖不到的场景，先在 `decisions.md` 说明理由再破例。
- **表格一律用 `DataTable`。** 它只接收**服务端已排序、已分页**的数据。
  **禁止**改成客户端全量加载或客户端重排——那会吃掉服务端分页的成果。
- **颜色只用 token**（`--primary` / `--muted` / `--border` / `--ring` / `--card` …），
  **不写死十六进制色值**。共享token保证当前浅色界面与画布一致。
  例外：`chart.tsx` 传给 lightweight-charts 的颜色不属于 CSS token 体系，
  按图表库自身约定处理。
- **间距、圆角、字号用 Tailwind 工具类**，不新增 `globals.css` 规则。
  `globals.css` 里 1098 行手写 CSS 是历史包袱，**只减不增**。
- 图标统一使用 `@phosphor-icons/react/ssr`，类型来自同一库；不再依赖lucide。
- 展示数字统一使用 `trading-strategy-core/format-number`。资金计算/任意精度序列化不使用展示舍入；既有固定测试与历史样例保留原格式。
- 布局仅三档：base≤1024、lg1025–1279、xl≥1280；不引入其他响应式断点。渲染仅浅色，已保存旧主题字段在读取时丢弃。
- 组件内不做数据获取。数据由页面或容器组件取好后以 props 传入，
  便于测试直接渲染。

## 5. 服务端

- 所有外部输入用 **Zod** 校验，包括 tRPC 入参、HTTP 响应、文件解析结果。
- 外部服务写 **TypeScript 适配器**，**不执行技能目录里的脚本**
  （问财、模拟盘都是这么做的）。
- 适配器必须**保留脱敏后的原始响应**用于诊断。契约会漂移，
  拿不到原始响应就没有诊断能力——模拟盘的 `gdzh`/`gddm` 就是这么查出来的。
- 长任务放 worker，支持**取消与进度上报**，不阻塞 UI。
- 数据库变更走 `src/server/db/migrations.ts` **增量迁移**，
  不用 `db:push`，不改既有迁移条目。
  **每加一条迁移，打包的 exe 即过期**，必须重新打包。

## 5.5 视觉验收：模糊正确即可

这是自用项目，**UI 改动不追求像素级一致**。

- 视觉验收的标准是「**功能没坏、观感没明显退步**」，不是逐像素比对。
- 截图留作参考即可，**不要求逐处解释差异**，不要为了对齐几个像素反复折腾。
- JSX 换行、空格重排、间距的细微变化**直接接受**，不需要证明等价。
- 优先级：**代码简洁干净 > 视觉完全一致**。
  如果为了保持旧外观要写一堆特例，那就接受新外观。

**这条只放宽视觉，不放宽数据。** 以下仍然一步不让：

- 指标口径（`invariants.md` §2）
- 未来函数门禁（§3）
- 台账「宁可留空，不可给假数」（§5）
- 服务端排序分页语义
- 通知需显式订阅、测试中实际投递数为 0

理由：按钮差两像素你一眼就看出来，也不会造成损失；
而口径错了、留空变成假数字，**看不出来，且会让你据此做决策**。

## 6. 测试

- 验证范围、证据复用与停止条件以根 [AGENTS.md](../AGENTS.md#实现与验证) 为准；本文件的完整命令说明不代表每次改动都要执行。开发期定向检查，集成交付点集中运行必要完整门禁；已覆盖的测试或构建不因交接再次执行。
- **需要新增或修订的回归用例与实现同次交付，提交时一并纳入。** 按实际风险选用行为、契约或关键交互证据，不要求每次低风险可逆改动都新增测试，也不为每个变体复制共享契约。
- 测试文件默认已隔离数据目录（`tests/setup-data-dir.ts`），
  **不要在测试里连生产数据目录**。
- 断言要能证伪。`expect(x).toBeTruthy()` 基本没有价值，
  写明期望的具体值。
- 手算可验证的用例，在注释里写出算式，让人能用计算器复核。
- **不删除、不跳过既有测试来让新代码通过。** 结构指纹类护栏
  （`tests/workbench/workbench-refactor.test.ts`）失败时，**更新指纹并对新增部分补精确校验**，
  不是删掉它。
- 涉及外部投递的测试，**断言实际网络请求数为 0**。
- 偶发失败必须定位根因，**不接受"重跑就好"**——
  偶发红灯会训练所有人忽略红灯，比稳定失败更危险。

## 7. 注释

- **解释为什么，不解释做什么。** 代码已经说了做什么。

  ```ts
  // GBBQ is the market-wide event library; its latest event bounds coverage.
  coverageEnd?: string | null;
  ```

- 口径类决策在代码处标注依据出处（`docs/invariants.md §N` 或技能文件与章节）。
- 不写变更历史类注释（`// 2026-09-10 改为…`），那是 git 的职责。
- 注释语言跟随所在文件的既有语言，不在同一文件里中英混排。

## 8. 文档

- `invariants.md` — 正确性约束。每条写**是什么 / 为什么 / 哪个测试保护 / 违反会怎样**，
  **指不出测试的必须标注「无测试保护」**。
- `conventions.md`（本文） — 一致性规范。
- `decisions.md` — 只记**决策、放弃了什么与为什么、与预期不符的事实**。
  **禁止记录**「N 项测试通过 / 类型检查通过 / 构建通过」，那是 CI 的职责。
- `roadmap.md` / `next-plan.md` — 范围与计划。已完成的压成一行，不留待执行式清单。
- 写不准的事**标注「未核实」**，不要编造。

## 9. 提交

- Conventional Commits，英文，单行主题；需要说明才写 body。
  `feat(scope): ...` / `fix(scope): ...` / `refactor(ui): ...` / `chore(docs): ...` / `test: ...`
- **重大改动前先验证上一段工作并保留可审查差异**；提交按用户授权。
- body 写**为什么**和**边界**，不写"改了哪些文件"——那 `git show` 能看。
- **commit、push 各按用户授权**；未经授权不提交，也不因此停止可隔离的后续开发。

## 9.5 历史模块按需维护

用户已授权修改原冻结模块。当前需求涉及的代码按本规范维护，未触及的旧风格不顺手批量迁移；不要把风格一致性变成全仓库重写任务。

## 9.6 建立机制时必须同时定义它的生命周期

同一类错误在本项目出现过三次，都是「修一半」：机制建对了，收尾没管。

| 次  | 表现                                                     | 缺的那一半                                                                         |
| --- | -------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1   | 测试污染生产数据库                                       | 靠文档约束自觉 → 应改成机制                                                        |
| 2   | 规范定了 `format:check` 必须通过，而仓库 53 个文件不通过 | 定规则前没验证现状，**且误判了根因**——真因是 CRLF×prettier，见 §1；2026-09-12 已修 |
| 3   | 测试隔离了临时目录但从不清理，堆积 15,592 个 / 12 GB     | 建了目录，**没定义谁在什么时候删**                                                 |

因此，**新增任何会产生持久物的机制时，同一次提交内必须回答**：

- **谁创建**、**谁删除**、**什么时候删**
- 创建方**异常退出**时谁兜底
- 删除**失败**时的行为（尽力而为还是致命错误）
- 有没有**上限**：会无限增长吗？

适用对象：临时目录与文件、缓存、数据库表与行、日志、
后台任务与 worker、外部账户与远程状态、打包产物。

写规则前先核实仓库现状，优先使用已有证据和静态检查；只有无法回答具体风险时才增加运行验证。**不要写一条自己就在违反的规则，也不要为新增规则默认启动全套验证。**

## 10. 禁止清单

- 不新增第二套指标实现（`invariants.md` §1）
- 不新增第二个组件库
- 不在 `src/components/ui/` 放业务组件
- 不写死颜色值
- 不新增 `globals.css` 规则
- 不做无证据、与当前验收无关的性能优化
- 不顺手修改当前需求之外的模块（`roadmap.md` §2）
- 不建 `output/` 目录
- 不执行技能目录里的脚本
- 不把模型输出直接路由到交易接口
