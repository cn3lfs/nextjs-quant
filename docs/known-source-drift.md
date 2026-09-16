# 已登记来源漂移

仅登记已裁定的漂移，不表示语义对齐。批次门禁按 `(path, change)` 比较，**并按依赖判定严重性**：

- 未登记的变化、已登记项不再漂移、缺失技能、新未分类技能 → 失败。
- 漂移文件被任何**非 planned** 方法引用 → 失败，因为已实现的规则可能被改动。
- 登记项的 `methods` 与方法清单反查结果不一致 → 失败，防止登记与事实脱节。
- 仅被 planned 方法引用的文件再次被编辑 → 输出 notice，不失败。

`hash` 字段是**最近一次语义复核时的内容**，不参与匹配。早先按 `(path, change, hash)` 精确匹配，结果作者持续迭代这些新闻技能，B1a 批末验收时 5 个文件相对 D0 登记全部又变了一次，门禁因"没有任何实现读取的文件被再编辑"而红灯——这不是它该拦的东西。改为依赖判定后，真正要拦的（已实现规则被改）反而更严格。取舍见 decisions.md。

空数组要求零漂移。原始来源审计（不带 `--registered`）仍对任何漂移严格退出 1。

5 改 1 增，影响 NW01–NW04（全部仍 planned）。逐文件语义依据见 decisions.md 的 D0 条目；`hash` 与快照已于 2026-09-16 B1a 批末刷新到当时内容。解除条件是 B6 完成语义对齐，更新锁定并清空登记。

```json
[
  {
    "path": "news-industry-analyst/CHANGELOG.md",
    "change": "changed",
    "hash": "eb3b1a0722880186c0e894f807af23953bdef1d0922f8197456d7da27ecd50a9",
    "methods": ["NW01", "NW02", "NW03", "NW04"],
    "reason": "D0 已裁定规则输入变化；受影响方法全部 planned，保留锁定 hash，漂移不阻塞 B1。",
    "reviewWhen": "B6 完成分类、资金流与可用时点语义对齐后更新锁定 hash 并清空登记。"
  },
  {
    "path": "news-industry-analyst/SKILL.md",
    "change": "changed",
    "hash": "c9c79d2d5f7e3fe9d8e59f0fe842f0e3d9b790c60e13f33d3987ad1b5099292a",
    "methods": ["NW01", "NW02", "NW03", "NW04"],
    "reason": "D0 已裁定规则输入变化；受影响方法全部 planned，保留锁定 hash，漂移不阻塞 B1。",
    "reviewWhen": "B6 完成分类、资金流与可用时点语义对齐后更新锁定 hash 并清空登记。"
  },
  {
    "path": "news-industry-classifier/references/classify-cache.md",
    "change": "changed",
    "hash": "0fab022b61d46fe64903823e659249ac52112a1bc368ea8f4524e9d906a88943",
    "methods": ["NW01", "NW02", "NW03", "NW04"],
    "reason": "D0 已裁定规则输入变化；受影响方法全部 planned，保留锁定 hash，漂移不阻塞 B1。",
    "reviewWhen": "B6 完成分类、资金流与可用时点语义对齐后更新锁定 hash 并清空登记。"
  },
  {
    "path": "news-sector-analyzer/SKILL.md",
    "change": "changed",
    "hash": "9cf086d56c6d490750134be221405c6c5c7b535d5392b1126f705b3d4da9fb4e",
    "methods": ["NW01", "NW02", "NW03", "NW04"],
    "reason": "D0 已裁定规则输入变化；受影响方法全部 planned，保留锁定 hash，漂移不阻塞 B1。",
    "reviewWhen": "B6 完成分类、资金流与可用时点语义对齐后更新锁定 hash 并清空登记。"
  },
  {
    "path": "news-sector-analyzer/scripts/analyze.py",
    "change": "changed",
    "hash": "a0257349c07fe14e2784d26b1a5ed4d893a3531ccdcd1d21c1a7829b31c33b8b",
    "methods": ["NW01", "NW02", "NW03", "NW04"],
    "reason": "D0 已裁定规则输入变化；受影响方法全部 planned，保留锁定 hash，漂移不阻塞 B1。",
    "reviewWhen": "B6 完成分类、资金流与可用时点语义对齐后更新锁定 hash 并清空登记。"
  },
  {
    "path": "news-sector-analyzer/scripts/build_sw_sector_codes.py",
    "change": "added",
    "hash": "98e675e69660fab03d6d61ee75c40ce5aa936bb8595ce45eb838e93e941d6440",
    "methods": ["NW01", "NW02", "NW03", "NW04"],
    "reason": "D0 已裁定规则输入变化；受影响方法全部 planned，保留锁定 hash，漂移不阻塞 B1。",
    "reviewWhen": "B6 完成分类、资金流与可用时点语义对齐后更新锁定 hash 并清空登记。"
  }
]
```
