#!/usr/bin/env bash
set -euo pipefail

# Web 使用已发布的 DSH 0.1.7 运行时；插件包请安装到同一个 DSH_HOME。
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
dsh_bin=${DSH_WEB_LAUNCHER:-"$HOME/.local/share/codingns/deepseek-harness/0.1.7-rc.2/node_modules/@deepseek-ai/dsh/lib/bin.js"}
dsh_home=${DSH_WEB_HOME:-"$HOME/.dsh-web-017"}
state_dir=${CODINGNS4DSH_WEB_STATE_DIR:-"$HOME/.config/codingns4dsh/web-017"}
port=${DSH_WEB_PORT:-17890}

if [[ ! -f "$dsh_bin" ]]; then
  printf '找不到 DSH 0.1.7-rc.2 启动器: %s\n' "$dsh_bin" >&2
  exit 1
fi

cd "$repo_root"
runtime_env=(
  "DSH_HOME=$dsh_home"
  "CODINGNS4DSH_STATE_DIR=$state_dir"
  "CODINGNS4DSH_PROFILE_NAME=web"
  "CODINGNS4DSH_LOGIN_COOKIE_NAME=dsh_codingns_web017"
)

if [[ "${1-}" == "--dump-config" ||
  "${1-}" == "--dump-config-schema" ||
  "${1-}" == "--dump-default-config" ]]; then
  exec env "${runtime_env[@]}" node "$dsh_bin" --profile web "$@"
fi

exec env "${runtime_env[@]}" node "$dsh_bin" --profile web --port "$port" "$@"
