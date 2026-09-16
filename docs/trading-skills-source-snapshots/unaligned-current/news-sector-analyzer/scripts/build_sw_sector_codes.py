"""构建「申万一级/二级行业 → 腾讯板块代码」映射表。

背景：资金流（`westock-data fund flow pt01<申万指数码>`）在申万**一级和二级**
都有数据，三级（pt0185xxxx）腾讯源返回全 0（只有收盘价，没有资金流字段），
因此本表只收一级 + 二级，三级不入表（避免下游拿 0 当「零流入」误读）。

做法：申万指数码集中在 801010~801999 区间，但哪些码有效没有公开规律，
所以直接批量探测——`fund flow` 批量查询对无效码静默丢弃，返回的即为有效板块，
再用 references/sw-industry-tree.json 的一级/二级中文名做归属匹配
（腾讯名带「Ⅱ/Ⅲ」后缀，匹配前归一化）。

用法：
    python build_sw_sector_codes.py          # 重建 references/sw-sector-codes.json
底表（sw-industry-tree.json）更新或申万调整行业后重跑即可。
"""
import json
import os
import re
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding='utf-8')

HERE = os.path.dirname(os.path.abspath(__file__))
TREE_PATH = os.path.join(HERE, '..', 'references', 'sw-industry-tree.json')
OUT_PATH = os.path.join(HERE, '..', 'references', 'sw-sector-codes.json')
WESTOCK_JS = os.environ.get(
    'WESTOCK_DATA_JS',
    os.path.expanduser('~/.agent-skills/skills/westock-data/scripts/index.js'),
)
SCAN_RANGE = range(801010, 802000)
BATCH = 50


def norm(name):
    """去掉申万名里的罗马数字层级后缀（白酒Ⅱ/白酒Ⅲ → 白酒）。"""
    return re.sub(r'[ⅠⅡⅢⅣ]+$', '', (name or '').strip())


def probe(codes):
    cmd = ['node', WESTOCK_JS, 'fund', 'flow', ','.join(codes), '--raw']
    try:
        p = subprocess.run(cmd, capture_output=True, timeout=90)
        if p.returncode != 0:
            return []
        data = json.loads(p.stdout.decode('utf-8'))
    except Exception as e:
        print(f'  批次失败：{type(e).__name__}: {e}')
        return []
    if not isinstance(data, list):
        return []
    return [(r.get('code'), r.get('name')) for r in data if r.get('code') and r.get('name')]


def main():
    tree = json.load(open(TREE_PATH, encoding='utf-8'))['tree']
    l1_names = {norm(k) for k in tree}
    l2_parent = {}
    for l1, node in tree.items():
        for l2 in (node.get('l2') or {}):
            l2_parent[norm(l2)] = l1

    found = {}
    codes = ['pt01%d' % c for c in SCAN_RANGE]
    for i in range(0, len(codes), BATCH):
        batch = codes[i:i + BATCH]
        for code, name in probe(batch):
            found[code] = name
        print(f'  扫描 {batch[0]}~{batch[-1]}：累计 {len(found)} 个有效板块')
        time.sleep(0.2)

    l1_out, l2_out, orphan = {}, {}, {}
    for code, name in sorted(found.items()):
        n = norm(name)
        if n in l1_names:
            l1_out[n] = {'code': code, '腾讯名': name}
        elif n in l2_parent:
            l2_out[n] = {'code': code, '腾讯名': name, '一级': l2_parent[n]}
        else:
            orphan[code] = name

    out = {
        'meta': {
            'source': 'westock-data fund flow 探测 + sw-industry-tree.json 名称归属',
            'asof': time.strftime('%Y-%m-%d'),
            'scan': f'{SCAN_RANGE.start}~{SCAN_RANGE.stop - 1}',
            'count': {'一级': len(l1_out), '二级': len(l2_out), '未归属': len(orphan)},
            'note': '腾讯板块代码 = pt01 + 申万指数码；三级（pt0185xxxx）资金流字段恒为 0，故不收录',
        },
        '一级': l1_out,
        '二级': l2_out,
        '未归属': orphan,
    }
    with open(OUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(f'一级 {len(l1_out)} ｜ 二级 {len(l2_out)} ｜ 未归属 {len(orphan)} → {OUT_PATH}')
    if orphan:
        print('未归属（腾讯有、申万树里没匹配上）：', list(orphan.values())[:20])
    missing = sorted(l1_names - set(l1_out))
    if missing:
        print('一级缺失：', missing)


if __name__ == '__main__':
    main()
