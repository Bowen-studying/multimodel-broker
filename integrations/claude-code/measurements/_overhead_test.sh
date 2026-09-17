#!/usr/bin/env bash
# 量 Claude Code 的固定开销：不同开关组合下的 input tokens 与缓存命中
set -u
cd /tmp/track2-scratch
source ~/.hermes/scripts/claude_deepseek_env.sh 2>/dev/null
SET=$(mktemp ~/.cache/t2m-XXXX.json); chmod 600 "$SET"
python3 - "$SET" <<'PY'
import json, os, sys
e = {k: os.environ[k] for k in ("ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN") if os.environ.get(k)}
for slot in ("ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL"):
    e[slot] = "deepseek-flash"
json.dump({"env": e}, open(sys.argv[1], "w"))
PY

run() {
  local tag="$1"; shift
  timeout 240 claude -p "reply with exactly OK" --settings "$SET" --output-format json \
    --permission-mode auto --model deepseek-flash --add-dir /tmp/track2-scratch "$@" > "/tmp/m-$tag.json" 2>/dev/null
  python3 - "$tag" <<'PY'
import json, sys
tag = sys.argv[1]
d = json.load(open(f"/tmp/m-{tag}.json"))
u = d.get("usage") or {}
print(f"[{tag}] input={u.get('input_tokens')} cache_read={u.get('cache_read_input_tokens')} "
      f"cache_write={u.get('cache_creation_input_tokens')} output={u.get('output_tokens')}")
PY
}

run baseline
run nodyn --exclude-dynamic-system-prompt-sections
run lean --exclude-dynamic-system-prompt-sections --strict-mcp-config --mcp-config '{"mcpServers":{}}'
run repeat --exclude-dynamic-system-prompt-sections --strict-mcp-config --mcp-config '{"mcpServers":{}}'
rm -f "$SET"
