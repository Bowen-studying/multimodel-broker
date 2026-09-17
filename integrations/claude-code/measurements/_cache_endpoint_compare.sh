#!/usr/bin/env bash
# 判定：DeepSeek 的 Anthropic 端点是否真的不缓存（对比 OpenAI 格式）
set -u
source "${CLAUDE_ENV_SCRIPT:-$HOME/.config/multimodel-broker/claude-code.env}" 2>/dev/null

python3 - <<'PY' > /tmp/anth-payload.json
import json
prefix = "稳定的前缀文本。" * 400   # 与 A2 同量级
json.dump({
  "model": "deepseek-flash",
  "max_tokens": 16,
  "system": "You are a terse assistant.",
  "messages": [{"role": "user", "content": [{"type": "text", "text": prefix + "\n只回复 OK"}]}],
}, open("/tmp/anth-payload.json", "w"))
PY

echo "=== Anthropic 格式（/anthropic/v1/messages）同一 payload 连发 3 次 ==="
for i in 1 2 3; do
  curl -s -m 120 https://api.deepseek.com/anthropic/v1/messages \
    -H "x-api-key: $ANTHROPIC_AUTH_TOKEN" -H "anthropic-version: 2023-06-01" \
    -H 'content-type: application/json' --data-binary @/tmp/anth-payload.json \
  | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin); u=d.get('usage') or {}
    print(f'  第 $i 次: input={u.get(\"input_tokens\")} cache_read={u.get(\"cache_read_input_tokens\")} cache_write={u.get(\"cache_creation_input_tokens\")} output={u.get(\"output_tokens\")}')
except Exception as e:
    print('  解析失败:', e)
"
  sleep 3
done

echo
echo "=== OpenAI 格式对照组（同一 payload 连发 3 次）==="
python3 - <<'PY' > /tmp/oai-payload.json
import json
prefix = "稳定的前缀文本。" * 400
json.dump({
  "model": "deepseek-flash", "max_tokens": 16,
  "messages": [{"role": "system", "content": "You are a terse assistant."},
               {"role": "user", "content": prefix + "\n只回复 OK"}],
}, open("/tmp/oai-payload.json", "w"))
PY
for i in 1 2 3; do
  curl -s -m 120 https://api.deepseek.com/chat/completions \
    -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" -H 'content-type: application/json' \
    --data-binary @/tmp/oai-payload.json | python3 -c "
import json,sys
u=(json.load(sys.stdin).get('usage') or {})
print(f'  第 $i 次: hit={u.get(\"prompt_cache_hit_tokens\")} miss={u.get(\"prompt_cache_miss_tokens\")}')
"
  sleep 3
done
