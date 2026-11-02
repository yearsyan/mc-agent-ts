#!/usr/bin/env python3
"""MCP HTTP 调用小工具: mcp_call.py <token名> <方法> [参数JSON]"""
import json, os, sys, urllib.request

MC_HOME = os.environ.get('MC_AGENT_HOME', os.path.expanduser('~/.mc-agent'))
tokens = json.load(open(os.path.join(MC_HOME, 'tokens.json')))
tok = tokens['admin'] if sys.argv[1] == 'admin' else tokens['agents'][sys.argv[1]]
method = sys.argv[2]
params = json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}

req = urllib.request.Request(
    'http://127.0.0.1:8767/mcp',
    data=json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}).encode(),
    headers={
        'x-token': tok,
        'content-type': 'application/json',
        'Accept': 'application/json, text/event-stream',
    })

with urllib.request.urlopen(req, timeout=180) as r:
    raw = r.read().decode()

# 剥 SSE 帧
for line in raw.splitlines():
    if line.startswith('data: '):
        d = json.loads(line[6:])
        if 'error' in d:
            print('ERROR:', d['error'])
        else:
            print(json.dumps(d['result'], ensure_ascii=False, indent=1)[:3000])
        break
else:
    print(raw[:500])
