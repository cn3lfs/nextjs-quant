# Design

preset: custom (existing Nocturne workbench)
mode: dark
density: compact
token-source: src/styles/tokens.css
fonts: Inter, Segoe UI, Microsoft YaHei, system-ui

## Existing style lock

This records the existing application theme; it does not introduce another theme.
The original handoff is [the workbench design](docs/design_handoff_quant_workbench/README.md).
All colors, fonts and shape values come from `src/styles/tokens.css`, mapped by
`src/styles/globals.css`. Use existing `nc-*` utilities and shadcn primitives.

## Palette for design tools

| Role           | Existing token  | Reference value |
| -------------- | --------------- | --------------- |
| Canvas         | nc-bg           | #161826         |
| Chrome         | nc-chrome       | #1b1d2c         |
| Panel          | nc-card         | #1f2130         |
| Inset          | nc-inset        | #232532         |
| Border         | nc-border       | #3f424d         |
| Text           | nc-text         | #e9e9ed         |
| Secondary text | nc-text-2       | #cfd3e5         |
| Muted text     | nc-text-3       | #9397ab         |
| Accent         | nc-accent       | #9184d9         |
| Active text    | nc-accent-light | #d2cefd         |
| Success        | nc-ok           | #7fc2a0         |
| Warning        | nc-warn         | #e0b07c         |
| Error          | nc-bad          | #e0897c         |

Reference hex values are for design tools only. Components use semantic tokens.
A-share market gains use `nc-up` (red); losses use `nc-down` (green).
Success/error colors describe task state independently of investment returns.

## Components and layout

- Existing React + Tailwind + shadcn/Radix; Lucide icons for new surfaces.
- Panel radius uses the existing 8px scale; 14px workbench gutters, standard
  Tailwind spacing inside panels. Do not add global CSS or another token file.
- Body 13–14px, section headings 14–16px, page title 20–24px. Numbers use
  tabular figures; hashes wrap and are confined to evidence details.
- Page hierarchy: short title and scope, primary work area, supporting history.
  Desktop configuration rail and flexible report; below desktop use stacked
  panels. At 320px no page-level horizontal overflow; wide tables scroll inside.
- Report values require real results. Empty/loading/error/cancelled and zero-fill
  states contain explanatory text, never fabricated charts or placeholder returns.
- Use existing DataTable with server pagination, existing Tabs, Button, Input,
  Badge and Dialog. Destructive actions require a named target and confirmation.
- Visible focus, associated labels, keyboard-operable tabs/dialogs, status live
  region; text contrast at least 4.5:1, controls at least 24px and primary touch
  actions 40px. Avoid decorative glow, new fonts and broad animations.

## Backtest workbench

One enabled SMA5/20 strategy. Configuration, selected archived report and task
history are visibly distinct. Show actual/requested dates, costs and initial
capital from the selected report. Use tabs for overview, orders/fills and
reproducibility; keep the rule-check-only qualifier visible. The existing global
navigation is retained. No new trading, optimization or strategy marketplace UI.
