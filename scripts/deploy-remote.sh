#!/usr/bin/env bash
# ============================================================
# email-mcp 远程部署脚本（Linux 服务器 + systemd + HTTP 模式）
# 用法: ./scripts/deploy-remote.sh [gmail|outlook] [port]
#   默认: gmail 8788
# 前置: 已在本机（或该服务器）完成 npm ci && npm run build，
#       且 ~/.email-mcp/config.json 与 tokens 已就绪
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

PROVIDER="${1:-gmail}"
PORT="${2:-8788}"
SERVICE="email-mcp-${PROVIDER}"
CMD_ABS="$(pwd)/dist/cli.js"

if [[ "${PROVIDER}" != "gmail" && "${PROVIDER}" != "outlook" ]]; then
  echo "❌ provider 必须是 gmail 或 outlook"; exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "❌ 未检测到 node（要求 >= 20）"; exit 1
fi
if [[ ! -f "${CMD_ABS}" ]]; then
  echo "❌ 未找到 dist/cli.js，请先运行 npm ci && npm run build（或 deploy-local.sh）"; exit 1
fi
if [[ ! -f "$HOME/.email-mcp/config.json" ]]; then
  echo "❌ 未检测到配置 ~/.email-mcp/config.json，请先在本机运行 email-mcp setup ${PROVIDER} 并同步配置目录"; exit 1
fi

echo "==> 生成 systemd 单元: ${SERVICE}.service (端口 ${PORT})"
UNIT="$(mktemp)"
cat > "$UNIT" <<EOF
[Unit]
Description=email-mcp ${PROVIDER} MCP server (HTTP)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=EMAIL_MCP_HOME=${HOME}/.email-mcp
Environment=EMAIL_MCP_LOG=info
ExecStart=/usr/bin/env node ${CMD_ABS} ${PROVIDER} --transport http --port ${PORT}
Restart=on-failure
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

echo "==> 安装并启动服务（需要 sudo）"
sudo cp "$UNIT" "/etc/systemd/system/${SERVICE}.service"
sudo systemctl daemon-reload
sudo systemctl enable --now "${SERVICE}"
rm -f "$UNIT"

echo
echo "✅ 服务已启动: ${SERVICE}"
sudo systemctl status "${SERVICE}" --no-pager | head -8 || true
echo
cat <<EOF

🌐 服务监听: http://127.0.0.1:${PORT}/mcp（仅本机）

   公网暴露前请配置反向代理 + TLS（nginx 示例）:
     location /mcp {
       proxy_pass http://127.0.0.1:${PORT};
       proxy_http_version 1.1;
       proxy_set_header Host \$host;
       proxy_set_header Connection "";
       proxy_read_timeout 3600s;   # SSE 长连接
     }

   客户端配置:
     { "mcpServers": { "${PROVIDER}-remote": { "type": "http", "url": "https://你的域名:443/mcp" } } }

   常用运维:
     sudo systemctl status/restart/stop ${SERVICE}
     sudo journalctl -u ${SERVICE} -f
EOF
