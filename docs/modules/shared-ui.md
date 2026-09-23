# 共享 UI 与样式原语

## 职责与非职责

`src/components/ui/` 保存基于 Radix/shadcn 的基础控件，`src/components/common/` 保存跨业务复用的视觉/交互组件与 UI Gallery，`src/lib/common/` 保存纯展示辅助。业务流程组件不归 common：任务历史、通知策略字段、选股池链接和数据源查询面板分别归 workbench、signals、market、data-sources。

## 入口与消费者

- 基础控件入口为 `src/components/ui/`，经 `~/components/ui/<control>` 被业务组件组合。
- 共享页面示例为 [UI Gallery](../../src/components/common/ui-gallery.tsx)，route 只在 [ui-gallery/page.tsx](../../src/app/ui-gallery/page.tsx) 装配。
- class merge 辅助为 [classnames.ts](../../src/lib/common/classnames.ts)。
- `disabled-tdx-connections.tsx` 是未挂载的兼容控件，当前无消费者；它与受保护 MCP UI 保持原样，启用或迁移前需先确认 owner。

## 契约与依赖

控件通过 props、可访问性属性、受控/非受控状态与 className 暴露行为。基础控件不得导入 `src/server` 或业务数据 store；业务领域在上层组合控件。共享样式 token 的变更会影响多模块页面，需更新 Gallery 展示和相关视觉验收。

## 状态、副作用与验证

控件只持有短暂交互状态，不拥有业务持久化；UI Gallery 中的表单、对话框和表格为演示数据，不请求 API。代表验证：[UI Gallery route 结构](../../src/app/ui-gallery/page.tsx)、[组件交互](../../tests/engineering-validation/t2-page-density.test.ts)、[组件域边界](../../tests/engineering-validation/src-organization.test.ts)。

## 维护指南

新增基础控件放 `src/components/ui/`；跨业务稳定复用的展示组件放 `common/`；带业务词汇、API 或领域状态的组件必须归入对应 domain。新增组件补 Gallery 样例或在所属模块文档说明，不将 Gallery 样例数据接入真实服务。
