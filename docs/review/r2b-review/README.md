# R2b 按钮实现统一

本目录为 A 层证据，**B 层待用户目视确认，执行者不判定视觉达标**。本次未进入 R3、未改冻结文件、未提交或推送。

## 实现与统计

Button 的尺寸、圆角、排列、背景、边框、阴影、悬停、禁用和焦点改用 Tailwind；颜色仅引用 R1 token 或 token 的 color-mix，不新增 token、不采用 shadcn 默认配色。保留四个既有 variant 和 default/sm 尺寸。字号与焦点的 important 工具类用于跨越既有未分层的元素规则；标题窄屏字号同时提供同优先级工具类。

新增 plain variant 只提供共同的光标、禁用与焦点行为，不添加底色、边框、间距或 .button 标记。40 处原生按钮全部选择 plain/default，保留原本的导航、链接样式、表单动作、表头排序、分段选项与绘图工具外观；没有把它们改成大号主按钮。分段和证券选项的 role、aria-selected、selected、键盘处理器未改，仍渲染 button 元素。

源码 JSX 开始标签统计（src/**/*.tsx，不含测试、不按运行时循环展开）：原生共 41 处 → 1 处；非冻结 40 → **0**。唯一残留为 [backtest-actions.tsx:26](../../../src/components/backtest-actions.tsx#L26)，按 conventions §9.5 明确豁免。Button 实现内部的字符串 "button" 是底层宿主，不是原生 JSX 消费者。

全 src 的 Button variant/size 分布（含未修改的既有调用与画廊）：default/default 51、default/sm 1；outline/default 39、outline/sm 12；ghost/default 12、ghost/sm 5；danger/default 1；plain/default 40；合计 161。

替换位置：chart-workspace 7、formula-screen 4、security-select 1、signal-ledger-controls 1、trade-ledger-panel 14、workbench 4、两个路由 error 各 1、ui/data-table 1、workbench/evidence-analysis 1、market-view 3、reports 1、task-center 1。

## 十条上下文选择器逐项处理

| 选择器                                         | 处理与真实消费者                                                                                                                          |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| .security-options button                       | 保留。SecuritySelect 的 Button plain 仍为 button；原列表行布局、字体、背景继续生效。                                                      |
| .security-options button[aria-selected="true"] | 保留。aria-selected 原值与键盘选择逻辑不变，保留原选中外观。                                                                              |
| .segmented button                              | 保留。MarketView 周期 Button plain 不获得 .button 基础外观。                                                                              |
| .segmented button.selected                     | 保留。原 displayedPeriod 与 selected 类绑定不变。                                                                                         |
| .source-line .button                           | 保留。行情来源行“加入自选”仍有兼容标记，margin-left:auto 不失效。                                                                         |
| .panel-title .button                           | 保留。SignalsView“管理渠道”等现有标题操作仍有兼容标记，继续右对齐。                                                                       |
| .button-row                                    | 保留。Connections 的 MCP 和渠道按钮容器仍消费它；这是容器布局，不是 Button variant。                                                      |
| .toast button                                  | 保留。Workbench“关闭提示”采用 plain，仍受原关闭图标布局影响。                                                                             |
| .page-heading > .button                        | 保留。Workbench“扫描本地数据”仍有标记，650px 浏览器检查 padding=10px、字号=0px；组件增加同优先级的窄屏字号工具类以覆盖全局 font:inherit。 |
| .page-heading > .button svg                    | 保留。650px 检查图标 width=15px。                                                                                                         |

十条均有消费者，不能按死 CSS 删除。没有把分段/列表控件改成普通主按钮，也没有新建相关 globals.css 规则。迁入组件内 Tailwind 的是原 .button 基础外观及 .button-primary、outline、ghost、danger、sm 与 hover 规则；上述旧基础/variant 规则已删除，globals.css **0 行新增 / 43 行删除**。仅保留无独立 CSS 定义的 .button 标记给布局选择器及 R1 的 :not(.button) 共存规则使用。

## 截图条件及差异

Chrome，1840×1350，Asia/Shanghai，fullPage；窄屏附图 650×900。使用 SQLite backup 从既有 R2 **隔离**库复制到 .test-data/r2b/browser；未读取生产库，未写原通达信数据。留存的 R2 隔离库已经包含 R2 截图之后的交互记录，不能声称它与历史 after 是同一数据状态。

每页均与历史 R2 after 做像素对照；另存 same-data-r2.png：在当前同一 DOM/数据上移除 Button 工具类、恢复提交基线 8ee88dabdea64166127ce41cf8dca2fb425baaea 里的原 .button CSS，用于隔离本次样式影响。它不是重新拍到的历史截图。精确渲染指纹测试独立证明 plain 替换未改原属性/子节点/事件/组件逻辑。原始计算样式、逐按钮差异、历史和同数据像素计数见 [comparison.json](comparison.json)。像素差异计数不是 B 层结论。

| 页面       | R2 历史 after                                | 本轮 after                      | 同数据旧按钮                             | 同数据差异像素 / 比例 |
| ---------- | -------------------------------------------- | ------------------------------- | ---------------------------------------- | --------------------- |
| 数据与连接 | [历史](../r2-review/connections/after.png)   | [本轮](connections/after.png)   | [同数据](connections/same-data-r2.png)   | 8243 / 0.1610%        |
| 信号与通知 | [历史](../r2-review/signals/after.png)       | [本轮](signals/after.png)       | [同数据](signals/same-data-r2.png)       | 5257 / 0.1677%        |
| 持仓账本   | [历史](../r2-review/trade-ledger/after.png)  | [本轮](trade-ledger/after.png)  | [同数据](trade-ledger/same-data-r2.png)  | 0 / 0.0000%           |
| 信号台账   | [历史](../r2-review/signal-ledger/after.png) | [本轮](signal-ledger/after.png) | [同数据](signal-ledger/same-data-r2.png) | 0 / 0.0000%           |
| 条件选股   | [历史](../r2-review/screen/after.png)        | [本轮](screen/after.png)        | [同数据](screen/same-data-r2.png)        | 24388 / 0.2518%       |
| 行情图表   | [历史](../r2-review/market/after.png)        | [本轮](market/after.png)        | [同数据](market/same-data-r2.png)        | 2268 / 0.0610%        |

### 本次按钮差异逐处

主按钮仍为青底白字：背景从 RGB(40,127,150) 映射到 primary(38,127,150)，阴影保持 0 2px 4px 和 10% 透明度。outline 白底不变，边框从 (218,228,237) 到 input(220,229,238)，文字用 secondary-foreground/muted/primary 的混色接近旧 (82,107,130)。ghost 透明底不变，文字用 primary/muted 混色接近旧 (71,133,155)。这些是已有 token 与旧零散色值不完全相同造成的剩余色差，未新增硬编码颜色。

- **数据与连接**：“扫描本地数据”、“保存设置”、“导入本机配置”、“检测连接与工具”、“保存渠道”有上述文字/边框/背景或阴影色差。 所有被匹配按钮的坐标、宽高、font、padding、圆角均一致。
- **信号与通知**：“扫描本地数据”、“启用监控”、“启用”、“管理渠道”有上述文字/边框/背景或阴影色差。 所有被匹配按钮的坐标、宽高、font、padding、圆角均一致。
- **持仓账本**：同数据整页零像素差异。 所有被匹配按钮的坐标、宽高、font、padding、圆角均一致。
- **信号台账**：同数据整页零像素差异。 所有被匹配按钮的坐标、宽高、font、padding、圆角均一致。
- **条件选股**：“扫描本地数据”、“在线查询”、“本页 2 只填入本地池”、“导出本页与来源”、“上一页”（2 处）、“下一页”（2 处）、“生成条件草案”、“运行选股”、“导出本次完整结果”、“研究”（50 处）有上述文字/边框/背景或阴影色差。 所有被匹配按钮的坐标、宽高、font、padding、圆角均一致。
- **行情图表**：“扫描本地数据”、“MCP 最新行情”、“核验证券身份”、“加入自选”有上述文字/边框/背景或阴影色差。 所有被匹配按钮的坐标、宽高、font、padding、圆角均一致。

以下悬停配色为源码核对，未另存逐状态配对截图。悬停仍为同类浅底/深青色：primary 用 primary/foreground 混色；outline 用 secondary/muted-surface 混色；ghost 用 7% primary 与 card 混色。danger 保持浅红底红字，使用 10% destructive/card 与 destructive 文字；旧红字 (182,77,92) 与 token (174,83,100)、旧浅红底与混色底略有不同。六页截图未出现 danger 操作，此项在 [交互夹具](interactions.png) 留样，不冒充六页覆盖。

### 历史 R2 截图的额外状态差异

- **数据与连接**：通达信路径由初始配置变为 R2 合成数据目录；自动分析变为关闭；静默起点由 20:00 变为 R2 交互保存的 21:00；任务中心多了两条已完成合成任务，使页高 2719 → 2783。这些内容在本轮同数据旧按钮截图同样存在。
- **信号与通知**：历史无订阅；留存隔离库已有 R2 创建并暂停的订阅，显示“启用”操作；任务中心有合成任务。页高 1654 → 1704。未重新启用订阅或发送通知。
- **持仓账本**：历史一笔 sh600519；当前另有 R2 交互写入的 sz000001，增加持仓/止损与交易日志行；已有合成信号形成三行“没做的信号”统计。合成行情与日历使报价、T+1 显示不同；页高 1586 → 1818。本轮同数据配对仍为零差异，未录入新业务交易。
- **信号台账**：历史与本轮截图均零差异。
- **条件选股**：R2 后续交互留下公式记录/选中状态；合成行情目录现在存在，历史不存在路径的提示内容不同；总高仍 5263。候选与隔离分页语义未改。
- **行情图表**：已有视图为 R2 交互保存的 MA7（历史 MA5），影响图例和对应 MA 曲线；本轮未保存新视图。图表首次 fullPage 截图存在布局取整，稳定后同数据两张均 2021px，历史 2022px；按钮几何未变。

## 交互与验证

持久脚本为 tests/r2b-browser-review.mjs、tests/r2b-browser-fixture.tsx（只注入测试页，不新增应用路由）。验证真实 React Button 的点击、Space、禁用 click 无效、Tab 跳过禁用按钮、2px focus-visible、asChild 单一 anchor/合并事件/Enter 导航、plain 点击和隐式 form submit；六页导航也通过 Button plain 实际点击。未触发通知/模拟交易；浏览器非本机请求记录为空，pageerror 为空。源码对照保持 40 处原有处理器及所有其余组件语句；负控能检出处理器改写。

全部原测试保留，只更新确受标签替换影响的 N3 ReportArchive、MarketView、EvidenceAnalysis、TaskCenter 指纹；冻结回测指纹未改。验收命令结果另存 validation.json。

## 需要用户决定

仅 B 层：请目视六页 after 与同数据/R2 历史对照，确认剩余 token 色差及 plain 保留外观是否符合本次“只换实现”的要求。若希望 token 与原散落色值逐色完全一致，需要另行裁定是否允许扩充/调整 token；本轮不新增 globals.css 或进入 R3。分段与证券选项语义已保留，无需为本轮另作控件设计裁定。

工作期间 conventions.md 新增的 §5.5 为外部改动，本任务未改写；以上材料按本次明确交付要求保留，后续不继续追求像素对齐。
