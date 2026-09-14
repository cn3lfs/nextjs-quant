"""Run the isolated Rust probe once per API; JSONL retains failures and timeouts."""
import argparse
import concurrent.futures
import json
import subprocess
import time

p=argparse.ArgumentParser()
p.add_argument('--exe',required=True)
p.add_argument('--report',required=True)
a=p.parse_args()
hosts=['180.153.18.170','124.71.187.122','115.238.56.198']
names=['quotes','bars','index_bars','bars_range','index_bars_range','k','k_adjusted','minute','history_minute','transaction','history_transaction','finance','xdxr','block','stock_count','stocks','f10_categories','f10','minute_raw','security_list_page','company_content','block_meta','block_chunk','heartbeat','reconnect','retry']
cases=[dict(host=h,name=n,market=1,code='600000',category=4) for h in hosts for n in names]
for n in ['k_batch','bars_batch','k_adjusted_hfq','block_zs','block_fg','check_alive','check_alive_protocol','check_alive_by_rtt','tcp_connect_ok','price_limits']:
    cases.append(dict(host=hosts[0],name=n,market=1,code='600000',category=4))
for m in [0,2]:
    for n in ['stock_count','stocks','security_list_page']:
        cases.append(dict(host=hosts[0],name=n,market=m,code='600000',category=4))
for category in range(12):
    cases.append(dict(host=hosts[0],name='bars',market=1,code='600000',category=category))
for n in ['minute_raw','minute','history_minute']:
    cases.append(dict(host=hosts[0],name=n,market=0,code='300750',category=4))
def run(case):
    start=time.time()
    try:
        r=subprocess.run([a.exe,case['host'],case['name'],str(case['market']),case['code'],str(case['category'])],capture_output=True,text=True,encoding='utf-8',timeout=45)
        data=json.loads(r.stdout.strip().splitlines()[-1]) if r.returncode==0 else dict(status='process-error',error=r.stderr[-1000:])
    except subprocess.TimeoutExpired: data=dict(status='budget-timeout',error='45 second process budget')
    return {**case,'startedAt':start,'elapsed':time.time()-start,**data}
with open(a.report,'w',encoding='utf-8') as out,concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
    for row in pool.map(run,cases):
        out.write(json.dumps(row,ensure_ascii=False)+'\n');out.flush()
        print(row['host'],row['name'],row['status'],row.get('count',''),flush=True)
print('cases',len(cases))
