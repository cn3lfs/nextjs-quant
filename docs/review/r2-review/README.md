# R2 六页迁移核对

本目录是 A 层证据，**不代表 B 层视觉签收或体验评价**。基线为 R1 提交 `4725e40`；按数据与连接 → 信号与通知 → 持仓账本 → 信号台账 → 条件选股 → 行情图表逐页截图、修改和验证。没有启用全应用暗色模式。

## 迁移数量与截图

数量是源码 JSX 开始标签的位置数，不是运行时展开后的控件数；input 包括原生复选框，通知分级的一个 select 工厂会生成多个字段。表中不把保留的 Button 或原生 button 算作已迁移。

| 页面 | input | select | textarea | table → DataTable | 合计 | 对照 |
|---|---:|---:|---:|---:|---:|---|
| 数据与连接（含通知策略字段） | 17 | 3 | 2 | 0 | 22 | [前](connections/before.png) / [后](connections/after.png) |
| 信号与通知 | 4 | 3 | 0 | 0 | 7 | [前](signals/before.png) / [后](signals/after.png) |
| 持仓账本 | 12 | 2 | 0 | 3 | 17 | [前](trade-ledger/before.png) / [后](trade-ledger/after.png) |
| 信号台账 | 0 | 0 | 0 | 1 | 1 | [前](signal-ledger/before.png) / [后](signal-ledger/after.png) |
| 条件选股（含公式、在线结果） | 8 | 3 | 2 | 3 | 16 | [前](screen/before.png) / [后](screen/after.png) |
| 行情图表（含搜索、图表工具栏） | 9 | 2 | 0 | 0 | 11 | [前](market/before.png) / [后](market/after.png) |
| 总计 | 50 | 13 | 4 | 7 | 74 | button 替换 0 |

## 截图条件与数据范围

同一 Chrome、1840×1350 视口、Asia/Shanghai 时区、完整页面截图，只隐藏 Next 开发指示器。每页截图在交互验证写入隔离记录之前捕获。`before.json` / `after.json` 保存控件的原始计算样式与几何；[comparison.json](comparison.json) 保存元素数量、重叠区域逐像素差异数、额外高度与匹配控件的样式差异。页面高度变化会使下方未修改内容整体位移，像素数量不是独立缺陷数量，也不是视觉验收结论。

- 数据与连接：首次隔离默认配置，没有渠道；日历与 MCP 工具查询在总览截图中折叠。后续对这些折叠 textarea 的 `field-sizing-fixed` 修正不影响这张总览；MCP 工具选择器只在已有工具结果时出现，未连接远程服务去制造结果。
- 信号页：无订阅的配对截图；随后的交互只创建并暂停 `channels=[]`、`source=local`、`ai=false` 的隔离订阅。
- 持仓页：同一笔合成 sh600519 本地交易；行情缺失，核对后成本、浮盈留空。新增第二笔合成交易发生在迁移后截图之后。
- 信号台账：一个合成信号、一个已完成任务，三个期限均等待回填。不是历史信号回放或真实策略样本。
- 条件选股：123 条合成候选、53 条合成隔离记录及两条合成在线结果；在线结果是直接放入隔离库的已完成夹具，没有调用在线服务。截图中不存在的通达信路径提示在两版均出现，是配对夹具的加载失败状态，未遮挡或删除。
- 行情页：在 `.test-data/r2/tdx` 写入 420 根纯合成 OHLC 二进制记录，再由现有解析器读取；不是用户行情、不是新解析器。两版同为日线、360/420 根、末根 2025-02-23，收盘 123.46，默认 MA 与成交量。没有写原通达信目录。

## 视觉差异逐处说明

### 共同的预期组件差异

1. **Input**：由约 39.797px 高变为 36px；字号从 12px / 19.8px 行高变为 14px / 20px，内边距由 9px 11px 变为 4px 12px。背景从 `#fbfcfe` 变为透明，显示所在白色面板；增加 shadcn 阴影和聚焦 ring。圆角在本轮匹配输入框中仍为 6px，不能笼统称为“圆角全变了”。禁用框采用组件的淡化样式。
2. **Select**：原系统下拉箭头换为 16px chevron，弹出选项使用 Radix 浮层和选中标记；触发器的字体、内边距、阴影随组件变化。真实空值仍为 `""`，显示“新公式 / 最新 / 手动交易，不关联 / 选择工具”，没有改成业务哨兵值。空值显示沿用组件 placeholder 色，较原生选中值更浅；这是待用户确认的视觉变化。
3. **Checkbox**：从浏览器原生复选框变为 16px、4px 圆角、青色选中底和白色勾；未选中为浅边框。对应行的基线与邻接文字距离因此变化。仍使用原来的布尔状态，不引入三态业务值。
4. **DataTable**：表头由 10px 浅灰字、浅灰底、10px 12px padding 改为组件 14px 字、透明底、40px 表头高度及 8px 水平 padding；单元格由 12px 等宽字体和 13px 12px padding 改为 14px 正文字体与 8px padding。新增圆角外框、行分隔与悬停底色；证券小字仍保留已有 small 样式。列宽会随字体与内边距重新分配。原来的空提示留在原位置，不插入重复空行或额外分页栏。

### 各页位置及影响

- **数据与连接**：通达信目录、出站代理、通知阈值/限额/去重/时间框、渠道名称/凭证/目标/thread 使用上述输入样式；平台与通知分级下拉、静默和渠道复选采用组件样式。禁用静默时间比原生版本更浅。累计高度由 2749px 变为 2719px，研究模型、MCP、渠道和任务中心随上方控件高度上移；没有减少说明文字。研究技能、新闻配置及模型配置保持旧样式，所以页面有明确的新旧控件并存。折叠日历/MCP 参数框固定按 rows 显示；MCP 查询分支没有远程交互截图。
- **信号与通知**：首行名称、证券池、策略、周期，第二处数据源与 AI/渠道复选变化。首面板缩短，后续订阅/信号/投递/任务区域整体上移，全文高度 1660px → 1654px；原有空提示、通知说明和按钮内容未变。双均线参数仍是共享旧控件。
- **持仓账本**：成交字段、止损和送转依据输入框变化；“买卖”“关联台账信号”增加 chevron，空关联文字呈 placeholder 色，窄列中的截断仍可通过展开下拉阅读。当前持仓表、做过与没做的信号表、折叠的模拟盘契约表采用新表头/单元格/外框；前两张见总览，第三张展开交互已验证。总高 1592px → 1586px，后续面板位移来自表单及表格尺寸。持仓数量、T+1 可卖、参考成本、留空破折号和日志文字保持原值。
- **信号台账**：唯一变化区域为聚合统计表：新增外框，表头颜色/字号和数字字体变化，三条行更紧凑，各列横向位置重新分配；下方每日任务、决策、明细面板上移。页高仍为视口最低 1350px。T+5/T+10/T+20 顺序、样本/有效/留空数字、等待回填原因保持相同。
- **条件选股**：公式名称/参数、两个 textarea、草案/日期/证券池/候选搜索及下拉改变样式；公式源码仍是 10 行，最终实测 218px，原为 235.938px，差值来自字体行高和 padding。在线、候选与隔离三表采用统一表样式，50 行候选累计高度缩短，使底部折叠区和任务中心上移；总高 5520px → 5263px。排序触发器明确为 160px，页码保持不折行，搜索占余下空间。这是避免迁移后的挤压所作的局部布局决定，排序/翻页仍为原 API 与处理器。可看 [表单前](screen/before-forms.png) / [表单后](screen/after-forms.png)、[结果区前](screen/before-table.png) / [结果区后](screen/after-table.png)，这些裁剪使用固定坐标，上方高度改变会导致裁剪起点内容不同。
- **行情图表**：品种搜索从约 176.797×34px 变为 191.438×36px，12px 等宽字变为 14px 正文字体；相邻顶部操作随搜索宽度移动。对数/图表暗色、双突破/BOLL/缠论复选改为组件外观；观察日及副图触发器根据当前文本收窄，周围状态说明横向位置变化。参数框约 82px 宽变为 80px，39.797px 高变为 36px。图表总页高保持 2022px，K 线、结构、图例数值、TradingView 标识及已有容器未改；没有以截图宣称全状态绘图像素恒等。

### 发现并修正的非预期差异

- Select 替换后，触发器不再具有原生 select 的隐式标签匹配：已在每个迁移触发器上明确 aria-label，浏览器按标签选择验证。
- Textarea 的默认 `field-sizing-content` 忽略原 rows 的尺寸效果，把公式 10 行压成 64px。第一种任意属性覆盖未生效；改为可被 class 合并正确处理的 `field-sizing-fixed`，浏览器确认 computed fieldSizing=fixed、rows=10、高218px后重拍。没有将这个收缩解释为预期变化。
- 候选排序触发器初始的全宽样式挤压页码成为竖向多行。最终限定触发器宽度并禁止页码折行，重新验证排序/翻页与截图。原状态回调未变。

## 交互、投递与保留项

[interactions.json](interactions.json) 是逐页检查与最终隔离库审计；[server-queries.json](screen/server-queries.json) 保存实际候选请求参数。验证覆盖配置保存、静默禁用联动、平台字段切换、订阅保存/暂停、原生 required/FormData、空值选项、合成成交保存、明细开关、候选服务端排序与翻页、公式拒绝/保存、图表参数/副图/复选/保存、搜索 Escape。

最终渠道记录 0、delivery 记录 0、尝试数 0，**实际网络投递 0**。未点击测试通知、手动重发、模拟盘远程账户/委托；浏览器还阻止非本机请求。没有把未运行的外部操作列为通过。六页原本未使用 dialog；details 的展开/收起按适用页面检查。原布尔控件是 checkbox，没有为此引入 Switch 或新对话框。

保留的内容：

- `button.tsx` 及其既有调用全部不改。原生 button 同样保留：持仓页14处、公式页4处、行情相关11处，以及未改的台账取消/任务中心/导航等共享入口。添加既有 Button 的 `.button` 基类会改变尺寸、底色和按钮组布局，无法同时承诺原视觉不变，因此本轮不作这项替换。是否另行统一这些按钮，记为待议，不自动扩展 R2。
- `StrategyFields` 在信号/选股中显示的5个双均线参数位置与冻结回测共用，保持原组件不改。Connections 内研究/新闻的8个 input 和1个模型提供方 select 保留。冻结研究面板没有修改。
- `details`、form/fieldset、导航/绘图按钮与图表容器保留语义。没有重建图表、迁移状态管理或调整业务计算。
- DataTable 增加 `showPagination=false` 和 `emptyMessage=null` 的呈现选项，以保留已有外部分页与空提示。所有迁移列 `enableSorting=false`；已有排序下拉继续通知服务端。信号聚合仍在服务端计算，仅其显示表成为客户端组件。

## 复现与验收

脚本为持久验证用例，不在 output 下创建材料：`tests/r2-browser-review.mjs`、`tests/r2-seed-review.ts`、`tests/r2-review-report.mjs`。它们校验浏览器数据目录必须为仓库 `.test-data/r2/browser`。原版 before 须在迁移前源码下采集；不能在当前源码上调用 before 并冒充原版。按本节顺序使用独立干净夹具复现，截图后交互会写入这个隔离库。

```powershell
$env:QUANT_DATA_DIR = Join-Path $PWD '.test-data/r2/browser'
pnpm dev --port 3215
# 另一个终端设置同样变量；按逐页 before / 迁移 / after 执行：
node tests/r2-browser-review.mjs connections after
node tests/r2-browser-review.mjs signals after
node tests/r2-browser-review.mjs trade-ledger after
pnpm exec tsx tests/r2-seed-review.ts
node tests/r2-browser-review.mjs signal-ledger after
pnpm exec tsx tests/r2-seed-review.ts screen
node tests/r2-browser-review.mjs screen after
pnpm exec tsx tests/r2-seed-review.ts market
node tests/r2-browser-review.mjs market after
node tests/r2-review-report.mjs
```

首次持仓 before 脚本先通过原表单录入一笔合成交易再重载截图；直接在空库跳到 after 无法复现已存在持仓的断言。单元测试运行前移除外层 `QUANT_DATA_DIR`，让既有 setup 为测试创建自己的临时目录；不要继承浏览器库。构建前停止本次 dev 服务、等待测试退出，避免重建正在使用的 koffi runtime。

最终命令与结果另见 [validation.json](validation.json)。不运行 desktop:smoke / desktop:pack，不 commit/push。B 层仍需用户看六组截图，确认控件字体/密度、表格字体和空值触发器颜色；本报告没有自行裁定视觉达标。
