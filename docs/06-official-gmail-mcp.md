# 指南 06：Google 官方 Gmail 远程 MCP server 接入（备选方案）

> 官方端点：`https://gmailmcp.googleapis.com/mcp/v1`（**Developer Preview**，需加入
> [Google Workspace Developer Preview Program](https://developers.google.com/workspace/preview)）
> 官方文档：https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server
>
> 适用：以 Google 生态为主（Antigravity / Claude 订阅用户）、不想自建 server 的场景。
> 本项目自建方案（email-mcp）仍保留为完整能力备选，两者可并存。

## 0. 与自建方案对比速查

| 维度 | 官方远程 MCP（gmailmcp.googleapis.com） | 本项目自建 email-mcp |
|---|---|---|
| 状态 | Developer Preview（可能变化） | 稳定 |
| 工具 | 9 个：search_threads/get_thread/list_drafts/create_draft/label/unlabel/list_labels | Gmail+Outlook 各 12 个 |
| 发送/回复 | ❌ 无（只能建草稿） | ✅ 有（confirm 门控） |
| 附件下载 | ❌ 无 | ✅ 有 |
| Outlook | ❌ 无 | ✅ 有 |
| 客户端 | Antigravity 原生；Claude 需 Enterprise/Pro/Max/Team；其他需支持 OAuth 的远程 host | 任意 MCP 客户端（stdio/HTTP） |
| 运维 | 零（Google 托管） | 自管（本地很轻） |
| OAuth 申请 | **同样需要**：项目 + consent screen + OAuth 客户端 | 同样需要 |

## 1. 前置：Google Cloud 项目

已有项目（如 "gmail api test"）直接用；没有则 https://console.cloud.google.com 新建。

## 2. 启用 API（两个都要）

- Gmail API：https://console.cloud.google.com/flows/enableapi?apiid=gmail.googleapis.com
- **Gmail MCP API**：https://console.cloud.google.com/flows/enableapi?apiid=gmailmcp.googleapis.com

（命令行：`gcloud services enable gmail.googleapis.com gmailmcp.googleapis.com --project=PROJECT_ID`）

## 3. 配置 OAuth consent screen（**必做，本项目自建同样需要**）

1. **Branding**：https://console.cloud.google.com/auth/branding
   - App name：`Gmail MCP Server`；User support email：你的邮箱；同意政策勾选后 Create
2. **Audience**：https://console.cloud.google.com/auth/audience
   - 选 **External**（个人账号无法选 Internal）→ **添加测试用户**（你的邮箱）→ Save
   - 应用保持 **Testing** 状态即可（自用足够）
3. **Data Access**：https://console.cloud.google.com/auth/scopes
   - **添加或移除范围** → 手动添加：
     - `https://www.googleapis.com/auth/gmail.readonly`
     - `https://www.googleapis.com/auth/gmail.compose`
   - 点 **添加到表格 → 更新 → 保存**（⚠️ 最后一定要点保存，否则授权报 invalid_scope）

## 4. 创建 OAuth 客户端（Web application）

1. https://console.cloud.google.com/auth/clients/create
2. 应用类型 **Web application**；名称随意
3. **Authorized redirect URIs** 按目标客户端填：
   - Antigravity：`https://antigravity.google/oauth-callback`
   - Claude：`https://claude.ai/api/mcp/auth_callback`
4. 创建后复制 **Client ID** 与 **Client Secret**

## 5. 配置 MCP 客户端

### Antigravity（原生支持）

`~/.gemini/antigravity/mcp_config.json`:

```json
{
  "mcpServers": {
    "gmail": {
      "serverUrl": "https://gmailmcp.googleapis.com/mcp/v1",
      "oauth": { "clientId": "OAUTH_CLIENT_ID", "clientSecret": "OAUTH_CLIENT_SECRET" }
    }
  }
}
```

Settings → Customizations → 刷新 → 找到 gmail → **Authenticate** → 浏览器登录 → 粘贴授权码。

### Claude（需 Enterprise/Pro/Max/Team 订阅）

Settings → Connectors → **Add custom connector**：
- Server name: `Gmail`；Remote MCP server URL: `https://gmailmcp.googleapis.com/mcp/v1`
- Advanced settings 填 OAuth client ID / Secret

### 其他客户端（支持远程 MCP + OAuth 的）

- Server URL：`https://gmailmcp.googleapis.com/mcp/v1`
- Transport：HTTP；认证：OAuth 2.0

## 6. 验证

在客户端里提问：
- "Ariel 最后一封关于 marketing plan 的邮件说了什么？"（触发 search_threads + get_thread）
- "给 ariel@example.com 起草一封邮件说我批准营销计划"（触发 create_draft）

## 7. 已知限制（Developer Preview）

- 工具固定 9 个，**无发送/回复/附件下载**；
- 需要加入 Developer Preview Program，接口可能变动；
- 间接提示注入风险：官方建议接入 Model Armor 或自行过滤，见
  https://developers.google.com/workspace/guides/configure-mcp-security
