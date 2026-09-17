#!/usr/bin/env bash
# 1) 禁用部分内置工具后 token 变化  2) DeepSeek 余额前后差（真实计费口径）
set -u
cd /tmp/track2-scratch
source ~/.hermes/scripts/claude_deepseek_env.sh 2>/dev/null
bal() { curl -s -m 20 https://api.deepseek.com/user/balance -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN"; }
echo "余额前: $(bal)"
SET=$(mktemp ~/.cache/t2n-XXXX.json); chmod 600 "$SET"
python3 - "$SET" <<'PY'
import json, os, sys
e = {k: os.environ[k] for k in ("ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN") if os.environ.get(k)}
for slot in ("ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL"):
    e[slot] = "deepseek-flash"
json.dump({"env": e}, open(sys.argv[1], "w"))
PY
timeout 240 claude -p "reply with exactly OK" --settings "$SET" --output-format json --permission-mode auto \
  --model deepseek-flash --add-dir /tmp/track2-scratch --exclude-dynamic-system-prompt-sections \
  --disallowedTools "Task,WebSearch,WebFetch,NotebookEdit,SlashCommand,TodoWrite,KillShell" > /tmp/m-notools.json 2>/dev/null
python3 - <<'PY'
import json
d = json.load(open("/tmp/m-notools.json")); u = d.get("usage") or {}
print(f"[禁部分工具] input={u.get('input_tokens')} cache_read={u.get('cache_read_input_tokens')} output={u.get('output_tokens')} Claude自算=${d.get('total_cost_usd'):.5f}")
PY
rm -f "$SET"
sleep 3
echo "余额后: $(bal)"
