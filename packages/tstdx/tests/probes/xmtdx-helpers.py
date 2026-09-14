"""Explicit public connection/factory checks, separate from data availability."""
import asyncio
import json
import sys

sys.path.insert(0, sys.argv[1])
from xmtdx import TdxClient, AsyncTdxClient, Market, ping_all

hosts = ['180.153.18.170', '124.71.187.122', '115.238.56.198']
print(json.dumps({'name':'module.ping_all','result':ping_all(hosts,timeout=3)}))
print(json.dumps({'name':'TdxClient.ping_all','result':TdxClient.ping_all(hosts,timeout=3)}))
with TdxClient.from_best_host(hosts,timeout=3,ping_timeout=3,max_attempts=1) as c:
    print(json.dumps({'name':'TdxClient.from_best_host/connect/context/close','count':c.get_security_count(Market.SH)}))

async def main():
    print(json.dumps({'name':'AsyncTdxClient.ping_all','result':await AsyncTdxClient.ping_all(hosts,timeout=3)}))
    c=await AsyncTdxClient.from_best_host(hosts,timeout=3,ping_timeout=3,max_attempts=1,heartbeat_interval=0.2)
    async with c:
        await asyncio.sleep(0.6)
        counts=await asyncio.gather(c.get_security_count(Market.SH),c.get_security_count(Market.SZ))
        print(json.dumps({'name':'AsyncTdxClient.from_best_host/connect/context/close','counts':counts,'heartbeat_task_alive':c._heartbeat_task is not None and not c._heartbeat_task.done()}))

asyncio.run(main())
