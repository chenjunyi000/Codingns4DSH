#!/usr/bin/env bash
set -euo pipefail

# 只移走 stage0 的旧开发链接；desktop 和当前仓库目录都不会被删除。
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
dsh_home=${DSH_HOME:-"$HOME/.dsh"}
link_path="$dsh_home/profiles/stage0/node_modules/dsh-codingns"

if [[ ! -L "$link_path" ]]; then
  printf 'stage0 旧链接不存在，无需清理: %s\n' "$link_path"
  exit 0
fi

target=$(readlink "$link_path")
if [[ "$target" != "$repo_root" ]]; then
  printf '拒绝移动非当前仓库链接: %s -> %s\n' "$link_path" "$target" >&2
  exit 1
fi

backup="${link_path}.bak-old-$(date +%Y%m%d%H%M%S)"
mv "$link_path" "$backup"
printf '已移走 stage0 旧链接: %s\n' "$backup"
