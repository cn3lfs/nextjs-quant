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
