#!/usr/bin/env bash
# chatgpt2api 前端构建脚本
# 流程：next build 静态导出到 web/out，再同步到根目录 web_dist（FastAPI 托管目录）

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
WEB_DIR="${PROJECT_DIR}/web"
OUT_DIR="${WEB_DIR}/out"
DIST_DIR="${PROJECT_DIR}/web_dist"
LOG_DIR="${PROJECT_DIR}/logs"

mkdir -p "${LOG_DIR}"

cd "${WEB_DIR}"

# 静态导出（next.config.ts 配置了 output: 'export'）
npm run build 2>&1 | tee "${LOG_DIR}/web-build.log"

if [ ! -f "${OUT_DIR}/index.html" ]; then
    echo "构建失败：${OUT_DIR}/index.html 不存在" >&2
    exit 1
fi

# 同步产物到 web_dist（--delete 保持与构建产物完全一致）
rsync -a --delete "${OUT_DIR}/" "${DIST_DIR}/"

echo "前端构建完成，产物已同步到 ${DIST_DIR}"
