# 测试指南（docs/05）

> 测试分两层：**自动化测试**（无需真实账号，随时可跑）与**真实账号测试**（申请凭据后实测）。

## 1. 自动化测试（无需真实凭据）

```bash
npm test        # 单元测试（node:test，8 项，秒级）
npm run smoke   # 全量冒烟（6 个脚本，约 1-2 分钟，mock API + 真实 MCP 进程）
```

| 套件 | 覆盖内容 |
|---|---|
| unit（8 项） | MIME 构造（中文 RFC2047/附件）、配置校验正反例、confirm 门控、脱敏 |
| smoke-core | token 存取/过期/删除、凭据格式校验 |
| smoke-setup | 配置向导交互、凭据落盘、账号校验回填 |
| smoke-m1 | Gmail 只读：PKCE、token 刷新、搜索/详情/附件解析、MCP 协议 |
| smoke-m2 | Outlook 只读：device code 轮询、KQL 搜索、nextLink 分页、MCP 协议 |
| smoke-m3 | 双侧读写：MIME 发送、回复引用、草稿、标签/文件夹、confirm 门控 |
| smoke-http | HTTP 模式：真实进程 + streamable HTTP 握手与工具调用 |

> 全部使用 mock API，不会触达真实邮箱，可放心在任何环境运行。

## 2. 真实账号测试前置

1. 申请凭据（约各 5 分钟）：
   - Gmail：`docs/01-google-gmail-oauth-setup.md`（Google Cloud Console）
   - Outlook：`docs/02-microsoft-outlook-setup.md`（Entra 管理中心）
2. 配置授权：
   ```bash
   email-mcp setup gmail      # 填 client_id/secret → 浏览器授权 → ✅ 显示账号
   email-mcp setup outlook    # 填 client_id → 终端输码 → ✅ 显示账号
   email-mcp status           # 确认两侧"已授权"
   email-mcp doctor           # 深度体检（含网络连通性 + token 有效性实测）
   ```

## 3. 命令行快速测试（无需 GUI 客户端）

用内置控制台直接调用真实工具：

```bash
# 查看工具清单
node scripts/mcp-console.mjs gmail list
node scripts/mcp-console.mjs outlook list

# 只读测试（安全，随时可跑）
node scripts/mcp-console.mjs gmail gmail_get_profile '{}'
node scripts/mcp-console.mjs gmail gmail_search '{"query":"is:unread","maxResults":5}'
node scripts/mcp-console.mjs outlook outlook_get_profile '{}'
node scripts/mcp-console.mjs outlook outlook_search '{"query":"from:me","top":3}'
```

**推荐测试顺序（由安全到危险）：**

| 步骤 | 命令 | 验证点 |
|---|---|---|
| 1 | `gmail_get_profile` / `outlook_get_profile` | 授权有效、token 可用 |
| 2 | `gmail_search '{"query":"in:inbox"}' ` | 能列出邮件 |
| 3 | 拿 search 返回的 `messageId` 调 `gmail_get` | 能读正文（中文正常） |
| 4 | 有附件邮件 → `gmail_get_attachment` | 附件下载 |
| 5 | `gmail_create_draft`（发给自己的邮箱） | 草稿创建（不发送，零风险） |
| 6 | `gmail_send` 带 `"confirm":true`（发给**自己的备用邮箱**） | 发送链路（先确认收件人） |
| 7 | `gmail_modify '{"messageId":"...","markRead":false}'` | 状态修改 |

> ⚠️ 发送测试建议先发给自己或测试邮箱；`confirm` 缺省时工具会返回
> `confirmation_required`——这本身就是安全门控的正常行为。

## 4. 客户端测试（Claude Desktop 等）

接入配置见 `docs/04-mcp-client-integration.md`。接入后在对话中试：

- "帮我搜最近 5 封来自 GitHub 的邮件"（触发 `gmail_search` + `gmail_get`）
- "看看 Outlook 收件箱有没有未读"（触发 `outlook_search`）
- "给 <你自己的另一个邮箱> 发一封测试邮件，主题是 MCP 测试"
  （观察发送前是否要求确认——confirm 门控生效）

## 5. HTTP 模式测试

```bash
email-mcp gmail --transport http --port 8788 &   # 另开终端
node scripts/mcp-console.mjs gmail list          # 或换成 http 客户端（见 docs/04）
# 浏览器访问 http://127.0.0.1:8788/mcp 应被 MCP 协议处理（非 404 即可确认服务在跑）
```

## 6. 常见测试问题

| 现象 | 处理 |
|---|---|
| `get_profile` 返回 401 | token 失效，重跑 `email-mcp setup <provider>` |
| 搜索返回空 | 换宽松 query（如 `in:anywhere`）；Outlook 的 `$search` 只搜索引字段 |
| `confirmation_required` | 正常安全行为，确认无误后加 `"confirm":true` |
| 403 insufficient scopes | 重跑 setup 时选择更大 scope（如 gmail.modify / Mail.ReadWrite） |
