#!/usr/bin/env python3
"""从 minecraft-data PR diff 中提取新增的数据文件。
用法: extract_mcd_pr.py <diff文件> <输出根目录> <版本过滤前缀如 pc/26.3>
"""
import sys, os, pathlib

diff_path, out_root, prefix = sys.argv[1], sys.argv[2], sys.argv[3]
lines = pathlib.Path(diff_path).read_text(errors="replace").splitlines()

i, extracted = 0, []
while i < len(lines):
    if lines[i].startswith("diff --git "):
        # 解析这个 file diff 块
        head = lines[i]
        filepath = head.split(" b/")[-1].strip()  # data/pc/26.3/xxx.json
        j = i + 1
        is_new = False
        while j < len(lines) and not lines[j].startswith("diff --git "):
            if lines[j].startswith("new file mode"):
                is_new = True
            j += 1
        if is_new and prefix in filepath:
            # 在块内找 +++ 行，收集后续以 + 开头的行
            body, k = [], i + 1
            in_hunk = False
            while k < j:
                if lines[k].startswith("+++"):
                    in_hunk = True
                elif in_hunk and lines[k].startswith("+"):
                    body.append(lines[k][1:])
                elif in_hunk and (lines[k].startswith("@@") or lines[k].startswith("---")):
                    pass
                elif in_hunk and not lines[k].startswith("+"):
                    in_hunk = False  # 结束连续新增段（遇到 @@/diff 等非 + 行）
                k += 1
            dest = os.path.join(out_root, filepath)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            pathlib.Path(dest).write_text("\n".join(body) + "\n")
            extracted.append(filepath)
        i = j
    else:
        i += 1

print(f"extracted {len(extracted)} files")
for f in extracted:
    print(" ", f)
