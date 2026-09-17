#!/usr/bin/env bash
# 并发 + 长任务可行性实测（两个目录互不干扰，各自包含一次 sleep 以拉长任务）
set -u
RUNNER=${RUNNER:-$(cd "$(dirname "$0")/.." && pwd)/runner.mjs}
A=/tmp/track2-parallel-a
B=/tmp/track2-parallel-b
rm -rf "$A" "$B"; mkdir -p "$A" "$B"

start=$(date +%s)
node "$RUNNER" --prompt "create a.txt with A, then run: sleep 20; echo done >> a.txt" --cwd "$A" --model deepseek-flash --permission-mode auto --timeout-ms 300000 > /tmp/par-a.json 2>/dev/null &
PA=$!
node "$RUNNER" --prompt "create b.txt with B, then run: sleep 20; echo done >> b.txt" --cwd "$B" --model deepseek-flash --permission-mode auto --timeout-ms 300000 > /tmp/par-b.json 2>/dev/null &
PB=$!
wait $PA $PB
end=$(date +%s)
echo "并发两个任务，墙钟耗时: $((end-start)) 秒（串行预计 >40 秒）"

python3 - <<'PY'
import json
for tag, p in (("A", "/tmp/par-a.json"), ("B", "/tmp/par-b.json")):
    try:
        d = json.load(open(p))
        print(f"[{tag}] status={d['status']} models={d['models']} cost=${d['cost_usd']:.4f} "
              f"turns={d['num_turns']} wall={d['duration_ms']}ms files={[f['path'] for f in d['files_touched']]}")
    except Exception as e:
        print(f"[{tag}] 解析失败: {e}")
PY
echo "--- 两个目录的产物（隔离验证）---"
for d in "$A" "$B"; do echo "$d:"; ls -l "$d"; cat "$d"/*.txt 2>/dev/null | tr '\n' ' '; echo; done
