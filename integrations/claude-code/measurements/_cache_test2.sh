#!/usr/bin/env bash
# A) 直连 OpenAI 格式缓存的干净实验（同payload连发 / 共享前缀不同尾巴）
# C) Claude Code 走诊断代理：看前缀指纹是否稳定
set -u
source ~/.hermes/scripts/claude_deepseek_env.sh 2>/dev/null

echo "=== A1) 同一 payload 连发两次（应命中"请求边界"缓存单元）==="
python3 - <<'PY' > /tmp/payload.json
import json
prefix = "稳定的前缀文本。" * 400
json.dump({
  "model": "deepseek-flash",
  "messages": [
    {"role": "system", "content": "You are a terse assistant."},
    {"role": "user", "content": prefix + "\n只回复 OK"},
  ],
  "max_tokens": 8,
}, open("/tmp/payload.json", "w"))
PY
for i in 1 2; do
  curl -s -m 120 https://api.deepseek.com/chat/completions \
    -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" -H 'content-type: application/json' \
    --data-binary @/tmp/payload.json | python3 -c "
import json,sys
u=(json.load(sys.stdin).get('usage') or {})
print(f'  第 $i 次: hit={u.get(\"prompt_cache_hit_tokens\")} miss={u.get(\"prompt_cache_miss_tokens\")}')
"
done

echo
echo "=== A2) 共享前缀 + 不同尾巴，连发三次（第 3 次应命中"共同前缀"单元）==="
for i in 1 2 3; do
  python3 - "$i" > /tmp/payload2.json <<'PY'
import json, sys
i = sys.argv[1]
prefix = "共享前缀段落。" * 400
json.dump({
  "model": "deepseek-flash",
  "messages": [
    {"role": "system", "content": "You are a terse assistant."},
    {"role": "user", "content": prefix + f"\n问题{i}：只回复 OK"},
  ],
  "max_tokens": 8,
}, open("/tmp/payload2.json", "w"))
PY
  curl -s -m 120 https://api.deepseek.com/chat/completions \
    -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" -H 'content-type: application/json' \
    --data-binary @/tmp/payload2.json | python3 -c "
import json,sys
u=(json.load(sys.stdin).get('usage') or {})
print(f'  第 $i 次: hit={u.get(\"prompt_cache_hit_tokens\")} miss={u.get(\"prompt_cache_miss_tokens\")}')
"
  sleep 3
done

echo
echo "=== C) Claude Code 走诊断代理，连跑 3 次（看 system/tools 指纹是否稳定）==="
rm -f /tmp/anthropic-proxy.jsonl
cd /tmp/track2-scratch
SET=$(mktemp ~/.cache/t2p-XXXX.json); chmod 600 "$SET"
python3 - "$SET" <<'PY'
import json, os, sys
e = {k: os.environ[k] for k in ("ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN") if os.environ.get(k)}
e["ANTHROPIC_BASE_URL"] = "http://127.0.0.1:8796"
for slot in ("ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL"):
    e[slot] = "deepseek-flash"
json.dump({"env": e}, open(sys.argv[1], "w"))
PY
for i in 1 2 3; do
  timeout 240 claude -p "reply with exactly OK" --settings "$SET" --output-format json \
    --permission-mode auto --model deepseek-flash --add-dir /tmp/track2-scratch > "/tmp/cc-proxy-$i.json" 2>/dev/null
done
rm -f "$SET"
python3 - <<'PY'
import json
print("  —— 请求指纹 ——")
for line in open("/tmp/anthropic-proxy.jsonl"):
    d = json.loads(line)
    if "system_hash" in d:
        print(f"  sys={d['system_hash']} tools={d['tools_hash']}({d['tools_count']}) msgs={d['messages_count']} "
              f"bytes={d['body_bytes']} cache_control={d['cache_control_seen']}")
    else:
        u = d.get("usage") or {}
        print(f"    -> 响应 status={d.get('response_status')} usage={json.dumps(u, ensure_ascii=False)[:200]}")
PY
