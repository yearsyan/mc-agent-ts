#!/bin/bash
# 停止 mc-agent API (按端口找, 避免模式自匹配)
H=$(ss -tlnp 2>/dev/null | grep ':8767' | grep -oP 'pid=\K[0-9]+' | head -1)
if [ -n "$H" ]; then kill "$H" 2>/dev/null; sleep 1.5; kill -9 "$H" 2>/dev/null; echo "killed $H"; else echo "not running"; fi
