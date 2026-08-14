#!/usr/bin/env bash
# ============================================================
# email-mcp 本地部署脚本
# 用法: ./scripts/deploy-local.sh [--link]
#   --link  可选：注册全局命令 email-mcp（npm link）
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> [1/4] 安装依赖（npm ci）"
npm ci --no-audit --no-fund

echo "==> [2/4] 构建（npm run build）"
npm run build

if [[ "${1:-}" == "--link" ]]; then
  echo "==> [3/4] 注册全局命令 email-mcp（npm link）"
  npm link
  CMD="email-mcp"
else
  echo "==> [3/4] 跳过全局注册；使用本地命令：node dist/cli.js"
  CMD="node dist/cli.js"
fi

echo "==> [4/4] 检查配置状态"
if [[ ! -f "$HOME/.email-mcp/config.json" ]]; then
  echo "    ⚠ 未检测到配置（${HOME}/.email-mcp/config.json），首次使用请先申请凭据并配置："
  echo
  echo "      申请凭据（约各 5 分钟）:"
  echo "        Gmail   → https://console.cloud.google.com   （docs/01-google-gmail-oauth-setup.md）"
  echo "        Outlook → https://entra.microsoft.com        （docs/02-microsoft-outlook-setup.md）"
  echo
  echo "      运行配置向导:"
  echo "        ${CMD} setup gmail"
  echo "        ${CMD} setup outlook"
  echo
else
  echo "    ✅ 已存在配置，可运行 ${CMD} status 查看 / ${CMD} doctor 体检"
fi

cat <<'EOF'

✅ 部署完成。接入 MCP 客户端（Claude Desktop 示例，macOS 路径）:

  ~/Library/Application Support/Claude/claude_desktop_config.json
  {
    "mcpServers": {
      "gmail":   { "command": "email-mcp", "args": ["gmail"] },
      "outlook": { "command": "email-mcp", "args": ["outlook"] }
    }
  }

  （未 --link 时 command 改为: node，args 改为: ["/绝对路径/dist/cli.js", "gmail"]）
  其他客户端与远程 HTTP 部署见 docs/03、docs/04。
EOF
