"""Opt-in real-network API audit. Run with --source, --report; no installation.

Every child has a 45-second wall budget. Results are observations, not a green
availability gate. No production database or credentials are used.
"""
import argparse
import asyncio
import concurrent.futures
import dataclasses
import hashlib
import inspect
import json
import os
from pathlib import Path
import subprocess
import sys
import time


def compact(value):
    if dataclasses.is_dataclass(value):
        return {f.name: compact(getattr(value, f.name)) for f in dataclasses.fields(value) if f.name != '_raw'}
    if isinstance(value, bytes):
        return {'bytes': len(value), 'sha256': hashlib.sha256(value).hexdigest(), 'prefix': value[:16].hex()}
    if isinstance(value, (list, tuple)):
        return [compact(v) for v in value]
    if isinstance(value, dict):
        return {str(k): compact(v) for k, v in value.items()}
    return value


async def child(case):
    from xmtdx import TdxClient, AsyncTdxClient, Market, KlineCategory
    cls = AsyncTdxClient if case['mode'] == 'async' else TdxClient
    c = cls(host=case['host'], timeout=3, auto_reconnect=False, max_attempts=1)
    async def call(name, *args, **kwargs):
        value = getattr(c, name)(*args, **kwargs)
        return await value if inspect.isawaitable(value) else value
    name = case['name']
    market = Market(case.get('market', 1))
    code = case.get('code', '600000')
    try:
        await call('connect')
        if name == 'get_security_count': args = [market]
        elif name == 'get_security_list': args = [market, 0]
        elif name in ['get_security_list_all', 'get_market_stat']: args = []
        elif name == 'get_security_quotes': args = [[(market, code), (Market.SZ, '300750')]]
        elif name == 'get_price_limits': args = [market, code, '浦发银行', 9.26]
        elif name in ['get_security_bars', 'get_index_bars', 'get_bars']:
            args = [market, '000001' if name == 'get_index_bars' else code, KlineCategory(case.get('category', 4)), 0, 3]
        elif name == 'get_bars_range': args = [market, code, 20260910, 20260914]
        elif name == 'get_history_minute_time_data': args = [market, code, 20260914]
        elif name == 'get_transaction_data': args = [market, code, 0, 3]
        elif name == 'get_history_transaction_data': args = [market, code, 20260914, 0, 3]
        elif name == 'get_history_fund_flow': args = [market, code, 0, 3]
        elif name == 'get_block_info': args = [case.get('filename', 'block_gn.dat')]
        elif name == 'get_report_file': args = [case.get('filename', 'gpcw.txt')]
        elif name == 'get_company_info_content':
            categories = await call('get_company_info_category', market, code)
            if not categories: return {'status': 'dependency-empty', 'dependency': 'get_company_info_category'}
            item = categories[0]
            args = [market, code, item.filename, item.start, item.length]
        elif name == 'ping_all': args = [[case['host']]]
        else: args = [market, code]
        data = await call(name, *args)
        clean = compact(data)
        count = len(data) if isinstance(data, (list, tuple, bytes, str)) else 1
        result = {'status': 'data' if count and data is not None else 'empty', 'count': count,
                  'sha256': hashlib.sha256(json.dumps(clean, sort_keys=True, ensure_ascii=False).encode()).hexdigest()}
        if isinstance(clean, list): result.update(first=clean[:1], last=clean[-1:])
        elif isinstance(clean, str): result.update(characters=len(clean), prefix=clean[:100])
        else: result['value'] = clean
        if name in ['get_minute_time_data', 'get_history_minute_time_data', 'get_history_transaction_data']:
            result['points'] = clean
        if name == 'get_company_info_content': result['request_file'] = args[2:]
        return result
    except Exception as error:
        return {'status': 'error', 'error_type': type(error).__name__, 'error': str(error)}
    finally:
        await call('close')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--report')
    parser.add_argument('--case')
    a = parser.parse_args()
    sys.path.insert(0, a.source)
    if a.case:
        print(json.dumps(asyncio.run(child(json.loads(a.case))), ensure_ascii=False))
        return
    from xmtdx import TdxClient
    methods = sorted(name for name in dir(TdxClient) if name.startswith('get_'))
    hosts = ['180.153.18.170', '124.71.187.122', '115.238.56.198']
    cases = [dict(name=name, mode=mode, host=host) for host in hosts for mode in ['sync', 'async'] for name in methods]
    for market in [0, 2]:
        for name in ['get_security_count', 'get_security_list']:
            cases.append(dict(name=name, mode='sync', host=hosts[0], market=market))
    for filename in ['block_zs.dat', 'block_fg.dat']:
        cases.append(dict(name='get_block_info', mode='sync', host=hosts[0], filename=filename))
    for filename in ['base_info.zip', 'tdxhy.cfg']:
        cases.append(dict(name='get_report_file', mode='sync', host=hosts[0], filename=filename))
    for category in range(12):
        cases.append(dict(name='get_security_bars', mode='sync', host=hosts[0], category=category))
    def run(case):
        start = time.time()
        try:
            p = subprocess.run([sys.executable, __file__, '--source', a.source, '--case', json.dumps(case)], capture_output=True, text=True, encoding='utf-8', timeout=45, env={**os.environ, 'PYTHONUTF8': '1'})
            result = json.loads(p.stdout.strip().splitlines()[-1]) if p.returncode == 0 else dict(status='process-error', error=p.stderr[-1000:])
        except subprocess.TimeoutExpired: result = dict(status='budget-timeout', error='45 second process budget')
        return {**case, 'startedAt': start, 'elapsed': time.time()-start, **result}
    with open(a.report, 'w', encoding='utf-8') as output, concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        for row in pool.map(run, cases):
            output.write(json.dumps(row, ensure_ascii=False)+'\n'); output.flush()
            print(row['mode'], row['host'], row['name'], row['status'], row.get('count', ''), flush=True)
    print('documented/public get APIs:', len(methods), 'cases:', len(cases))


if __name__ == '__main__': main()
