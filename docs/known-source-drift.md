# 已登记来源漂移

仅登记已裁定的漂移，不表示语义对齐。批次门禁按 `(path, change, hash)` 精确比较；未登记变化、已登记变化消失、hash 再变、缺失技能或新未分类技能均失败。空数组要求零漂移。原始来源审计仍严格退出 1。

5 改 1 增，影响 NW01–NW04；逐文件语义依据见 decisions.md 的 D0 条目。解除条件是 B6 完成语义对齐，更新锁定并清空登记。

```json
[
  {
    "path": "news-industry-analyst/CHANGELOG.md",
    "change": "changed",
    "hash": "c2b11c0a3e4cb040c88ed761f999e8728cd9c72ba1ea3d1d24bfa866e909bf55",
    "methods": ["NW01", "NW02", "NW03", "NW04"],
    "reason": "D0 已裁定规则输入变化；受影响方法全部 planned，保留锁定 hash，漂移不阻塞 B1。",
    "reviewWhen": "B6 完成分类、资金流与可用时点语义对齐后更新锁定 hash 并清空登记。"
  },
  {
    "path": "news-industry-analyst/SKILL.md",
    "change": "changed",
    "hash": "d3bc8183fa7adf07075393986efa8a57253115d4f11840334c67d2bf07d441da",
    "methods": ["NW01", "NW02", "NW03", "NW04"],
    "reason": "D0 已裁定规则输入变化；受影响方法全部 planned，保留锁定 hash，漂移不阻塞 B1。",
    "reviewWhen": "B6 完成分类、资金流与可用时点语义对齐后更新锁定 hash 并清空登记。"
  },
  {
    "path": "news-industry-classifier/references/classify-cache.md",
    "change": "changed",
    "hash": "7339187e4e7302c3baa52d36380d20d2a04746d826d2753229bfc0b6346e28d6",
    "methods": ["NW01", "NW02", "NW03", "NW04"],
    "reason": "D0 已裁定规则输入变化；受影响方法全部 planned，保留锁定 hash，漂移不阻塞 B1。",
    "reviewWhen": "B6 完成分类、资金流与可用时点语义对齐后更新锁定 hash 并清空登记。"
  },
  {
    "path": "news-sector-analyzer/SKILL.md",
    "change": "changed",
    "hash": "d70c8a438baeb209e5db9645f64a6ccf36081c1946616578d0c97700139508c8",
    "methods": ["NW01", "NW02", "NW03", "NW04"],
    "reason": "D0 已裁定规则输入变化；受影响方法全部 planned，保留锁定 hash，漂移不阻塞 B1。",
    "reviewWhen": "B6 完成分类、资金流与可用时点语义对齐后更新锁定 hash 并清空登记。"
  },
  {
    "path": "news-sector-analyzer/scripts/analyze.py",
    "change": "changed",
    "hash": "83e9a88fda17141614a9723f63ffd2f2758e1d6bd26edfea4c50948316706b89",
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
