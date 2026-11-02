#!/usr/bin/env python3
"""把 node-minecraft-protocol PR #1538 (entityDelta) 以 hunk 为单位应用到 node_modules。
每个 hunk: 上下文行 + 被删行 + 新增行。按顺序在文件里定位（上下文+被删行），整块替换为（上下文+新增行）。
用法: apply_nmp_patch.py <diff文件> <minecraft-protocol目录>
"""
import pathlib, sys

diff_path, root = sys.argv[1], pathlib.Path(sys.argv[2])
raw = pathlib.Path(diff_path).read_text()

files, cur_file, cur_hunk = {}, None, None
for line in raw.splitlines():
    if line.startswith('diff --git'):
        cur_file = line.split(' b/')[-1].strip()
        files[cur_file] = []
    elif line.startswith('@@'):
        cur_hunk = []
        files[cur_file].append(cur_hunk)
    elif cur_hunk is not None and (line[:1] in (' ', '+', '-')):
        cur_hunk.append(line)

def apply_hunk(lines, hunk):
    """在 lines 里找 hunk 的旧内容（ctx+del 行），替换为 ctx+add 行。返回新列表或 None。"""
    old = [l[1:] for l in hunk if l[0] in (' ', '-')]
    new = [l[1:] for l in hunk if l[0] in (' ', '+')]
    for i in range(len(lines) - len(old) + 1):
        if lines[i:i + len(old)] == old:
            return lines[:i] + new + lines[i + len(old):], i
    return None, -1

for fname, hunks in files.items():
    path = root / fname
    lines = path.read_text().splitlines()
    offset = 0
    ok = 0
    for hunk in hunks:
        if not any(l.startswith('+') for l in hunk):
            continue
        result, at = apply_hunk(lines, hunk)
        if result is None:
            print(f'WARN {fname}: hunk 匹配失败，跳过: {" ".join(l[:40] for l in hunk[:3])}')
            continue
        lines = result
        ok += 1
    path.write_text('\n'.join(lines) + '\n')
    print(f'{fname}: 应用 {ok}/{len(hunks)} hunk')
print('done')
