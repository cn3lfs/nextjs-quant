# 交易策略共享契约

E0 注册驱动入口：`tests/research-contracts.test.ts`。遍历可执行 `researchStrategyIds`，识别不到规则适配器或基础信号时明确失败；不按名称猜测并静默跳过。原家族的正向形态与阈值测试保留。

| 契约         | 可证伪的观察                                                   |
| ------------ | -------------------------------------------------------------- |
| 完整历史前缀 | 每个研究日用从第一根开始的全部历史重算，与完整序列该日前缀一致 |
| 未来不改过去 | 追加极端未来行情，已有逐点输出或事件逐项不变                   |
| 缺日         | 移除观察日后该日不能生成事件；不将自然日间隔一概当停牌         |
| 零量         | 零量观察日不生成入场                                           |
| 非法 OHLC    | high 低于 low 的观察日不生成入场                               |
| 下一可成交   | 注入已确认事件后，当日不成交，阻塞下一开盘则顺延               |
| T+1 分批     | 新增仓当天不可卖，旧仓可卖，超量明确拒绝                       |
| 退出与重试   | 收盘止损已确认，下一日受阻，恢复价格后仍执行原退出             |
| 公司行动证明 | 无证明时真实运行入口不得生成交易模拟成交                       |
| 卖出数量     | 最低量、步长、单笔上限、尾仓清空均精确断言                     |
| 资金守恒     | 初始现金 + 已实现损益 = 清仓现金，持仓日现金加市值等于权益     |
| 排序稳定     | 候选和证券输入逆序，结果仍逐项一致                             |

执行层契约使用明确标注的合成已确认事件，以保证每个预设必有成交、受阻与退出，不用零信号的空数组冒充成交验证。结构止损仅为执行器场景输入，不宣称策略具备真实结构线。`ma-cross` 与 `czsc` 的结构线例外在套件显式登记；CZSC 使用确定性原生适配替身验证完整前缀协议，真实 DLL golden 保留在原测试。

缺日契约只证明被删除日期不造信号；每一家族是否要求连续窗口沿用现有家族规则，不将所有日线间隔改成缺失。未真实回测。

## 分层命令与生命周期

- `pnpm verify:spot tests/research-channels.test.ts`：相关测试加共享契约和注册表/UI 套件。路径必须是显式测试文件；无参数报错，防止误跑全量。
- `pnpm verify:batch`：typecheck、全量 Vitest、build（自带 runtime/worker）、来源冻结审计、方法绑定审计、全仓格式、git diff。失败集合按 known-test-failures 的 file/assertion 精确匹配，运行时未处理错误由独立 reporter 校验。任一门禁失败返回非零，后续门禁仍汇总。
- 每次验证在系统 TEMP/quant-verification 下创建独立时间戳目录并覆盖 QUANT_DATA_DIR；正常退出由命令删除，异常遗留由后续调用清理超过24小时的同格式目录。清理失败也报错。不会清理传入的其他数据目录。全量既有 test globalSetup 继续负责其内部临时目录。

## 声明与方法审计

`research-strategies.ts` 仅拼接家族。基础四预设移入 `research-base-strategies.ts`；技术/量价字典从家族 ID 自动派生，通道从 profiles 的键派生 ID/参数/说明。其余家族已有同文件声明式派生；新规则的具体计算也留在所属家族。表单与方法来源快照读取同一聚合注册表。

method-map 的 `bindings.presets` 指向可执行预设，`bindings.exports` 指向组合组件的实际导出，`bindings.completion` 是对原文完整性的人类语义裁定，不是测试得分。`pnpm exec tsx scripts/audit-trading-methods.ts --write` 从这些声明核对真实注册、导出、依赖与测试，确定性回填三字段；不带 --write 时有待回填差异也失败。绑定不等于真实回测完成。新增预设没有 method-map 绑定时报漏项；声明实现却删除导出或测试的反例亦必须失败。

浏览器补充入口 `node tests/research-registry-browser.mjs` 使用共享 Playwright 与仓库组件固定输入，检查实际菜单、一次选择保存/旧参数清除和注册表全预设390px页面宽度。不启动应用、不连接数据库、网络请求全部拦截，不产生持久截图。

## E0 回填变更来源

回填前后均为695项：planned 552 / implemented-variant 138 / implemented 5，status 与 implementation 无变更。143项既有实现增加显式绑定（85项关联基础预设，58项关联组件导出），不据此新增完成方法。99项 tests 引用补齐来自独立依赖扫描：85项具名预设自动关联共享契约与UI套件；其中 VP-vp-interval-3 / VP-vp-isolated-filter / VP-vp-stall-exit / VP-vp-high-low-volume-exit 另补实际消费其家族的 research-volume-context.test.ts。其余14项从实际可达导出补充 research-management.test.ts：RK-A-max-distance、RK-D3-distance、RK-D6-partial、RK-V1-rolling-high、RK-D6-close-atr-tail、SW-P-risk2、SW-P-stop5、SW-P-three-positions、SW-P-total60、RK-A3-atr-buffer、RK-A3-distance2atr、RK-A-explicit、RK-A-buffer-auto、RK-A-earliest。原有专用测试引用全部保留；任何字段差异可由审计 changes 逐项报告。

新增预设实测：在 research-channels.ts 的 profiles 增加临时 flag-12-e0-probe，并在 method-map 的 SW05-flag 绑定增加该ID，仅2文件变化；无需改聚合器、表单、快照或测试。5文件2030项通过，审计退出0后，两文件按测试前字节完全恢复，最终基础菜单仍133项。初次探针被“字典插入顺序必须等于菜单顺序”的过强测试拒绝；菜单顺序本来由显式ID序列控制，后改为字典与ID集合一致，实际表单顺序仍独立精确断言，未改生产菜单顺序。


## D0b/D0c 门禁补充

批次来源检查使用 `audit-trading-skills.ts --registered`，消费 [known-source-drift.md](known-source-drift.md) 的 `(path, change, hash)` 精确集合并打印已登记漂移；新增、消失、再次变化或其他来源错误仍失败。原始无参数审计继续要求零漂移。`tests/source-drift.test.ts` 覆盖集合替换、类型/hash变化、登记消失、重复、空登记、新技能/缺技能与正文快照字节；没有新增策略预设或策略契约例外。

方法审计增加 `batches` 与 `deliveryBatches.B1` 的分组计数及待办ID，依据batch归属，不按CA/SE前缀计数。`tests/trading-method-map.test.ts` 以跨前缀方法和非B1的CA项作为反例。

## B6a 统一时点输入

入口为 `src/lib/as-of.ts` 的 `createAsOfAdapter(records, { asOf, capturedBy? }).read(request)`；六类字段口径统一由 `src/lib/as-of-inputs.ts` 的 `readAsOfInput` 提供。未知字段返回 `missing/unsupported-field`，新增因子复用同一适配器并按需要补字段口径，不再新建时点层。

每条输入独立携带 `domain/entity/field/effectiveAt/source/availableAt/capturedAt/versionId/availabilityEvidence/unit/value`。`effectiveAt` 是精确业务生效日期或带时区时间；财务/机构以季度末为报告期，年度字段限年末。日期以上海零时比较，但**绝不**作为披露时间。`availableAt`、`capturedAt` 必须为带时区的完整时间；前者是该确切值版本首次公开可知时间，后者是采集时间。`availabilityEvidence` 必须为 `{ kind: "version-publication", reference: "该版本原始公开证据引用" }`；`versionId` 标识值版本，不能借用文件格式号。证据真实性由提供者负责核验，本接口不把字符串引用视为独立公告认证。

查询必须指定精确 `domain/entity/field/effectiveAt`，不把其他报告期或今日成分延续到请求日。仅在 `effectiveAt <= asOf` 且 `availableAt <= asOf` 的版本中选择最新可知版本；同版本值冲突、同可知时点冲突、跨源未显式选源、最新值无效或单位不匹配均返回missing/null及原因，不填零、不退回旧值。重复采集同一版本保留最早采集证据。允许事后采集已经公开的历史原版本；可选 `capturedBy` 进一步冻结档案采集上界，不与市场可知时间混用。未来修订不进入过去资料及其hash。

| domain | 已定义字段 | entity / effectiveAt |
| --- | --- | --- |
| finance | quarterlyEps、quarterlyEpsGrowth、quarterlyRevenueGrowth、quarterlyProfitGrowth、annualEps、annualCashPerShare、annualRoe、annualWeightedRoe | 证券 / 报告期 |
| capital | totalShares、floatShares、floatMarketCap | 证券 / 观察日期 |
| institutions | count、shares、floatRatio | 证券 / 报告期 |
| catalysts | events（具名事件清单；有证据的空清单与缺失不同） | 证券 / 观察日期 |
| rs | members、industry（含分类版本） | 证券池ID或证券 / 观察日期 |
| benchmarkCalendar | calendar（start/end/openDays/closedDays，逐日完整且覆盖请求日） | 基准ID / 观察日期 |

CANSLIM入口由 `src/server/canslim-dossier.ts` 导出 `buildCanslimAsOfDossier(request, observations)` 和 `gatherCanslimAsOfDossier(request, load, signal?)`。request显式提供 `symbol/asOf/observationDate/financialPeriods/annualPeriods/institutionPeriods/universeId/benchmarkId`，可选capturedBy。返回六类inputs、逐字段dataGaps和确定性ID；每个available值保留四类来源时点及版本证据。load只返回版本化输入，不自动调用当前行情/财务或回退来源；加载器不能移动截止时间。原当前资料入口的历史保护保留；本批不改当前报告API，不产生因子评分，B6b消费本路径。

固定输入入口：`tests/as-of.test.ts`、`tests/canslim-as-of-dossier.test.ts`；含修订不回填、availableAt缺失拒绝、时区边界、事后采集/档案截止、来源及版本冲突、六类缺覆盖、日历反例及取消。真实gpcw的22个数值字段没有已验证披露/修订可知证据，不能因数字完整而进入历史因子；无需重扫数据包。

B6b在同一字段表增加4项（总计22项输入口径，与gpcw的22数值字段无对应关系）：finance.quarterlyNetMargin（季度净利率，%）；capital.plans（观察日已知解禁日期和有效回购计划）；institutions.holders（报告期机构身份、分类版本及rule/human来源）；catalysts.growthEvents（观察日冻结事件、分类版本/证据、生效/到期/撤销及各类型原始结构字段）。这些字段和其他B6a输入采用同一版本公开证据契约，不新增适配层。LLM来源不接受，不能绕过K11模型冻结重放要求。

B6b待数据研究入口为 `runGrowthFactorResearch(request, observations, methodIds?)`，方法表及截面排序见 `research-growth-factors.ts`。返回每方法requiredInputs、逐字段缺口、分数/准入/证据与规则或人工参与类型；缺失为null，不计入已计算规则/人工数量。排序只比较相同时点/报告期/证券池及同参与类型，缺失不排名。真实回测始终明确不可用及覆盖未知，不进入交易撮合；固定输入测试见 `tests/research-growth-factors.test.ts`，未增加研究预设或改变共享交易契约。

B6b第二轮在同一字段表增加7项（现29项）：rs.priceHistory为同日股价/沪深300 OHLCV、完整冻结交易日序列、送转后复权及可比证据；rs.crossSection为冻结证券池全员同窗端点、上市日和明确停牌排除；rs.sectors为分类版本、同窗板块及完整成员价格；capital.securityState为当日历史身份/上市时长/涨停价/总市值/换手率；capital.entryPlan为当时冻结枢纽、拟价、止损、账户风险及仓位/止损后间隔；catalysts.earningsWindow为当时预约、上次真实披露、事前一致预期及覆盖日历；catalysts.entryEvents为近期三类事件、规则/人工来源与撤销状态。字段仍各自要求版本公开证据；收盘面板availableAt不得早于观察日15:00，含未来行情或日期/身份不一致拒绝。行情字段仅离线输入，未增加provider或执行通道。组合消费多个价格面板时，目标证券的起止价格和交易日序列必须对齐；不一致拒绝并在部分评分中列L1/L2缺口。

31个新组合在同一runGrowthFactorResearch按ID调用；完整CA组合从17个真实计算分项与既有形态算法生成候选，SE01从SE02、既有趋势/VCP和同日全池RS合成严格/弹性结果。requiredInputs预登记主依赖、财务/机构期次，缺失逐项返回；CA-S-missing只显示部分总分和容量，不给完整评级或排名。固定输入覆盖、各阈值正反例及IPO独立窗口见tests/research-growth-combinations.test.ts；原因子共享夹具移至tests/helpers/growth-factor-fixture.ts。真实披露、价格可比、全池/板块历史归属、交易日历/身份/预约/事前预期的核验覆盖仍未知，realBacktest.available=false。
