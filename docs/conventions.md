# 开发规范

`invariants.md` 管**正确性**（违反会算错），本文管**一致性**（违反会让代码越来越难改）。
两者都不写"怎么用某个库"，那查官方文档。

规范按现状归纳，不是凭空设计。有分歧时以仓库里**已存在的多数写法**为准，
不要引入第二种风格；确实需要改的，先改规范再改代码。

---

## 1. 工具链

- **Prettier 是唯一格式化权威**，无 ESLint。提交前 `pnpm format:check` 必须通过。
  2026-09-10 已对全仓库执行一次 `prettier --write`（53 个文件），此前该命令是不通过的。
- 不引入新的 lint / 格式化工具。风格争议由 Prettier 裁决，Prettier 管不到的看本文。
- **依赖由管理者预置**。执行者缺依赖就停下汇报，不得 `pnpm add`，
  也不得因为装不上而手写替代实现。

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

| 对象 | 规则 | 例 |
|---|---|---|
| 文件名 | kebab-case | `signal-ledger-store.ts` |
| 组件文件 | kebab-case，导出 PascalCase | `data-table.tsx` → `DataTable` |
| 类型 / 组件 | PascalCase | `LedgerSignal` |
| 函数 / 变量 | camelCase | `weeklyBars` |
| 常量集合 | camelCase + `as const` | `horizons` |
| 测试 | `<主题>.test.ts`，阶段性用例可带阶段前缀 | `q2a-formula.test.ts` |

**目录职责**

- `src/lib/` — 纯函数、类型、无 IO。可被服务端与客户端同时引用。
- `src/server/` — 有 IO：文件、数据库、网络、worker、FFI。
- `src/components/` — React 组件。
- `src/components/ui/` — **只放 shadcn 组件与其薄封装**，不放业务组件。
- `src/app/` — 路由与页面。
- `tests/` — 全部测试与其 fixture；`tests/fixtures/` 放固定数据。

## 4. UI

这一节是本次统一的重点。

- **不写原生表单元素。** `<input>` `<select>` `<textarea>` `<button>` `<table>`
  一律用 `src/components/ui/` 下的对应组件。
  确有组件覆盖不到的场景，先在 `decisions.md` 说明理由再破例。
- **表格一律用 `DataTable`。** 它只接收**服务端已排序、已分页**的数据。
  **禁止**改成客户端全量加载或客户端重排——那会吃掉服务端分页的成果。
- **颜色只用 token**（`--primary` / `--muted` / `--border` / `--ring` / `--card` …），
  **不写死十六进制色值**。写死的颜色让全应用暗色模式永远做不成。
  例外：`chart.tsx` 传给 lightweight-charts 的颜色不属于 CSS token 体系，
  按图表库自身约定处理。
- **间距、圆角、字号用 Tailwind 工具类**，不新增 `globals.css` 规则。
  `globals.css` 里 1098 行手写 CSS 是历史包袱，**只减不增**。
- 图标统一用 `lucide-react`，不混入其他图标库或内联 SVG。
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

## 6. 测试

- **测试与实现同一次提交。** 不接受"先实现后补测试"。
- 测试文件默认已隔离数据目录（`tests/setup-data-dir.ts`），
  **不要在测试里连生产数据目录**。
- 断言要能证伪。`expect(x).toBeTruthy()` 基本没有价值，
  写明期望的具体值。
- 手算可验证的用例，在注释里写出算式，让人能用计算器复核。
- **不删除、不跳过既有测试来让新代码通过。** 结构指纹类护栏
  （`tests/workbench-refactor.test.ts`）失败时，**更新指纹并对新增部分补精确校验**，
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
- **重大改动前先提交上一段工作**（`AGENTS.md` 有同条）。
- body 写**为什么**和**边界**，不写"改了哪些文件"——那 `git show` 能看。
- **执行者不 commit、不 push**；管理者验收后提交。

## 9.5 冻结模块豁免本规范

`roadmap.md` §2 的冻结模块**不适用**本文的风格与 UI 规范。
它们「零新增功能、零重构、零优化」，风格迁移同样属于投入。

- 冻结文件里残留的原生元素、旧 CSS 类、老写法**保持原样**，不要顺手改。
- 例外只有仓库级机械操作（如全仓库 Prettier 格式化），因为它不改变行为。
- 因此「全仓库不得有原生 `<button>`」这类要求，统计时应排除冻结模块并注明。

理由：冻结清单是这个项目十几个里程碑里少数真正管住范围的机制。
「就这一次、改动很小」正是冻结清单失效的方式。

## 10. 禁止清单

- 不新增第二套指标实现（`invariants.md` §1）
- 不新增第二个组件库
- 不在 `src/components/ui/` 放业务组件
- 不写死颜色值
- 不新增 `globals.css` 规则
- 不做性能优化（已达标并冻结）
- 不碰冻结模块（`roadmap.md` §2）
- 不建 `output/` 目录
- 不执行技能目录里的脚本
- 不把模型输出直接路由到交易接口
