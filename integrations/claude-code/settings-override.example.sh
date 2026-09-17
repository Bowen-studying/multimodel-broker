#!/usr/bin/env bash
# Headless Claude Code on the DeepSeek backend, independent of ~/.claude/settings.json
# (whose env points ANTHROPIC_BASE_URL at a local router on 127.0.0.1:3210 that is not running).
#
# Usage:
#   bash claude_deepseek_headless.sh "prompt" [--write] [workdir]
#   --write  => --permission-mode acceptEdits --add-dir <workdir> ; default is read-only text reply
#
# Secrets never touch the command line: a 0600 settings file is generated from the env script and removed after.
set -euo pipefail

PROMPT="${1:?prompt required}"
shift || true
MODE="${CLAUDE_PERMISSION_MODE:-acceptEdits}"   # auto | acceptEdits | bypassPermissions
if [[ "${1:-}" == "--write" ]]; then MODE="acceptEdits"; shift || true; fi
if [[ "${1:-}" == "--auto" ]]; then MODE="auto"; shift || true; fi
WORKDIR="${1:-$PWD}"

# shellcheck disable=SC1090
# Optional convenience: source a file that exports ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN.
# Without it the runner simply uses the environment it inherits.
source "${CLAUDE_ENV_SCRIPT:-$HOME/.config/multimodel-broker/claude-code.env}" 2>/dev/null || true

SETTINGS="$(mktemp "$HOME/.cache/claude-deepseek-XXXXXX.json")"
chmod 600 "$SETTINGS"
python3 - "$SETTINGS" <<'PY'
import json, os, sys
path = sys.argv[1]
env = {
    "ANTHROPIC_BASE_URL": os.environ.get("ANTHROPIC_BASE_URL", "https://api.deepseek.com/anthropic"),
    "ANTHROPIC_AUTH_TOKEN": os.environ.get("ANTHROPIC_AUTH_TOKEN", ""),
    "ANTHROPIC_MODEL": os.environ.get("CLAUDE_MODEL") or os.environ.get("ANTHROPIC_MODEL", "DeepSeek-V4-Pro"),
    "ANTHROPIC_DEFAULT_SONNET_MODEL": os.environ.get("ANTHROPIC_DEFAULT_SONNET_MODEL", "DeepSeek-V4-Pro"),
    "ANTHROPIC_DEFAULT_OPUS_MODEL": os.environ.get("ANTHROPIC_DEFAULT_OPUS_MODEL", "DeepSeek-V4-Pro"),
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": os.environ.get("ANTHROPIC_DEFAULT_HAIKU_MODEL", "DeepSeek-V4-Pro"),
}
for key in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"):
    if os.environ.get(key):
        env[key] = os.environ[key]
json.dump({"env": env}, open(path, "w"))
PY

cleanup() { rm -f "$SETTINGS"; }
trap cleanup EXIT

cd "$WORKDIR"
MODEL="${CLAUDE_MODEL:-}"; MODEL_ARGS=()
[[ -n "$MODEL" ]] && MODEL_ARGS=(--model "$MODEL")
exec claude -p "$PROMPT" --settings "$SETTINGS" --output-format json \
  --permission-mode "$MODE" --add-dir "$WORKDIR" "${MODEL_ARGS[@]}"
