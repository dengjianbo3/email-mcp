# 指南 03：首次启动与配置走查

> 前置：已按指南 01 / 02 申请好凭据。本文走查 `email-mcp` 的完整使用流程。

## 1. 安装

```bash
# 本地开发安装（推荐）
git clone <your-repo> && cd email-mcp
npm install
npm run build

# 全局安装 CLI（可选，方便任何目录使用）
npm link
```

## 2. 首次运行（引导）

直接尝试启动 Gmail server：

```bash
email-mcp gmail
```

未配置时会打印类似如下的指引并退出（这是**预期行为**，MCP server 不能阻塞等输入）：

```
⚠ 未检测到 Gmail 配置
  1) 到 Google Cloud Console 申请凭据（约 5 分钟）：见 docs/01-google-gmail-oauth-setup.md
  2) 运行: email-mcp setup gmail
  3) 完成后重新运行: email-mcp gmail
```

## 3. 配置向导：Gmail

```bash
email-mcp setup gmail
```

交互过程：

1. 粘贴 `client_id`（指南 01 步骤 5）；
2. 粘贴 `client_secret`（不回显；可留空走 PKCE）；
3. 权限范围：直接回车使用推荐默认；
4. 自动打开浏览器完成 Google 授权 → 授权页点同意；
5. 成功显示授权账号邮箱（如 `me@gmail.com ✅`）；
6. 自动写入配置与 token。

## 4. 配置向导：Outlook

```bash
email-mcp setup outlook
```

交互过程：

1. 粘贴 `client_id`（指南 02 步骤 3）；
2. 租户：个人账号直接回车（`common`）；
3. 权限范围：直接回车使用推荐默认；
4. 终端显示 https://microsoft.com/devicelogin 与一次性 code → 任意设备浏览器输入并同意；
5. 成功显示授权账号（`me@outlook.com ✅`）。

## 5. 查看与诊断

```bash
email-mcp status     # 各 provider 配置状态（脱敏：clientId 只显示后 4 位）
email-mcp doctor     # 逐项体检：配置 / token 有效性 / 网络连通性，输出修复建议
```

## 6. 启动 server

```bash
email-mcp gmail                    # stdio（默认，本地 MCP 客户端用）
email-mcp outlook --transport http --port 8788   # streamable HTTP（可选）
```

## 7. 非交互 / 部署：环境变量方式

所有配置均可由环境变量提供（优先级：环境变量 > config.json > 默认值），
适合 CI、容器、不希望交互填写的场景。完整示例见 `.env.example`：

```bash
export EMAIL_MCP_GMAIL_CLIENT_ID="1234567890-abc.apps.googleusercontent.com"
export EMAIL_MCP_GMAIL_CLIENT_SECRET="GOCSPX-..."
export EMAIL_MCP_GMAIL_SCOPES="gmail.modify gmail.labels gmail.compose"
# Outlook（device code 只需 client_id）
export EMAIL_MCP_OUTLOOK_CLIENT_ID="11111111-...-555555555555"
export EMAIL_MCP_OUTLOOK_TENANT="common"
export EMAIL_MCP_OUTLOOK_SCOPES="Mail.ReadWrite Mail.Send User.Read offline_access"
```

授权环节无法完全跳过：首次仍需跑一次 `email-mcp setup gmail|outlook` 完成 OAuth 同意；
之后 token 自动刷新，无需再交互。

## 8. 配置与数据存放位置

| 内容 | 路径 | 说明 |
|---|---|---|
| 配置 | `~/.email-mcp/config.json` | clientId/secret/scopes（0600） |
| token | `~/.email-mcp/tokens/gmail.json`、`tokens/outlook.json` | access/refresh token（0600） |
| 覆盖目录 | 环境变量 `EMAIL_MCP_HOME` | 换目录或做多账号隔离 |

## 9. 重新授权 / 换账号

- 换账号：删除 `~/.email-mcp/tokens/{provider}.json` 后重跑 `email-mcp setup <provider>`；
- 重选权限：直接重跑 setup（覆盖配置 + 重新授权）。
