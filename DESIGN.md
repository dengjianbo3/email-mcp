# 邮件 MCP 服务 —— 总体设计（Gmail + Outlook 自建）

> 版本：v1.0（已按里程碑全部实现）｜ 更新：2025-08-14
> 上一版（v0.1）调研结论保留在第 1 节；本文第 2 节起为可实施设计。
> 设计决策：**自建**；首次启动引导用户**自助申请并填入凭据**（不内置任何 key）。

---

## 1. 调研结论摘要（v0.1）

- Gmail / Outlook 都**没有独立的 "MCP API"**。底层分别是 Gmail REST API 与
  Microsoft Graph API，均基于 OAuth 2.0。
- 官方托管 MCP：Google Workspace MCP（Google 生态）/ Microsoft 365 Work IQ MCP
  （M365 企业租户）。均不适合"自用 + 任意 MCP 客户端"，故走自建。
- 自建 = 编写 MCP server，内部调用 Gmail API / Graph API，凭据由使用者自己申请。

## 2. 总体架构

```
┌─────────────────────────────────────────────────────────────┐
│  MCP 客户端 (Claude Desktop / Cursor / Cherry Studio / 自研)   │
└───────▲──────────────────────────────────▲──────────────────┘
        │ stdio (默认)          streamable HTTP (可选)
┌───────┴──────────────────────┴──────────────────┐
│  email-mcp CLI（Node/TS，单一仓库）                │
│  ├─ gmail    → Gmail MCP server（stdio/http）     │
│  ├─ outlook  → Outlook MCP server（stdio/http）   │
│  ├─ setup    → 首次配置向导（交互式，按 provider）  │
│  ├─ doctor   → 诊断：配置/凭据/连通性              │
│  └─ status   → 查看配置状态（脱敏）                │
└───────┬──────────────────────┬──────────────────┘
        │ Gmail REST API       │ Microsoft Graph API
        ▼                      ▼
   Google Cloud OAuth     Entra ID OAuth (device code)
        │                      │
   ~/.email-mcp/config.json（凭据配置，0600）
   ~/.email-mcp/tokens/*.json（access/refresh token，0600）
```

**核心原则**：项目内**零内置密钥**。所有凭据由使用者通过 `email-mcp setup`
向导（或环境变量）提供，落盘在用户主目录 `~/.email-mcp/`，不入项目、不入 git。

## 3. 项目结构与技术选型

> 实现说明：v0.2 原计划 monorepo（packages/core、mcp-gmail、mcp-outlook）。实际落地时
> 简化为**单包 + 模块化目录**：三个逻辑模块在一个仓库内即可清晰分离，避免 workspace
> 编译链复杂度，且 CLI 聚合（`email-mcp gmail|outlook`）在单包下更自然。若规模增长
> （多账号、企业版）再拆分。

```
repo/
├─ src/
│  ├─ cli.ts                    # CLI 入口（commander）
│  ├─ commands/                 # gmail/outlook（first-run 引导）、setup、status、doctor
│  └─ core/                     # 公共：paths、config、tokens、mask、logger、errors
├─ scripts/                     # 冒烟测试（prompts.inject 驱动 setup、core 层校验）
├─ docs/                        # 用户指导文档（见第 8 节）
├─ .env.example                 # 环境变量方式配置示例（含注释）
├─ .gitignore                   # 忽略 .env、config.json、tokens/
└─ README.md
```

- 语言：**TypeScript**（Node ≥ 20，ESM/NodeNext）
- CLI：`commander` + `prompts`（交互式向导）— 已落地
- MCP：`@modelcontextprotocol/sdk`（M1 引入）
- Gmail：`googleapis` 或轻量 `gaxios` 直接调 REST（M1 引入）
- Outlook：`@azure/msal-node`（device code flow）+ `@microsoft/microsoft-graph-client`（M2 引入）

## 4. 首次启动引导（First-Run Onboarding）设计

这是本设计的核心交互。目标：**用户第一次运行时，不需要读长文档，按提示就能完成
"申请凭据 → 填入 → 授权 → 可用"**。

### 4.1 启动检测流程（server 命令 `email-mcp gmail` / `outlook`）

```
email-mcp gmail
  │
  ├─ 加载配置 ~/.email-mcp/config.json（或环境变量）
  ├─ 未配置 clientId ──▶ 打印引导信息（见下）并 exit 1：
  │      ⚠ 未检测到 Gmail 配置
  │      1) 到 Google Cloud Console 申请凭据（约 5 分钟）：
  │         https://console.cloud.google.com → 启用 Gmail API → 创建 OAuth Client ID(Desktop)
  │      2) 运行:  email-mcp setup gmail    ← 交互式填写 + 自动授权
  │      3) 详情:  docs/01-google-gmail-oauth-setup.md
  ├─ 已配置 clientId 但无 token ──▶ 提示运行 email-mcp setup gmail 完成授权，exit 1
  ├─ 已配置且 token 有效 ──▶ 正常启动 MCP server（stdio）
  └─ token 过期 ──▶ 自动刷新；刷新失败 → 提示重新授权，exit 1
```

> 设计要点：MCP server 是"被客户端拉起"的长驻进程，不能在初始化握手期间阻塞等用户
> 输入，所以**未配置时立即打印指引并退出**，配置动作收敛到 `setup` 子命令。

### 4.2 `email-mcp setup gmail`（交互式向导）

1. 欢迎语 + 打开官方申请指南（打印链接，不自动开浏览器）。
2. 询问 `client_id`（粘贴）→ 校验格式（`\d+-[\w]+\.apps\.googleusercontent\.com`）。
3. 询问 `client_secret`（粘贴，不回显）→ 可选；留空则用 PKCE（public client）。
4. 询问 scope（回车用推荐默认：`gmail.modify gmail.labels gmail.compose`）。
5. 询问回调端口（默认 8787），随后自动打开浏览器进行 Google 授权
   （authorization code + PKCE，本地回调 `http://localhost:8787/callback`）。
6. 授权成功后：调用 `users.getProfile` 校验，显示授权账号邮箱 ✅。
7. 写入 `~/.email-mcp/config.json`（含 `account`），token 存 `tokens/gmail.json`。
8. 输出"下一步"：在 Claude Desktop / Cursor 中如何注册该 server（附配置片段）。

### 4.3 `email-mcp setup outlook`（交互式向导）

1. 欢迎语 + 打印 Entra ID 申请指南链接。
2. 询问 `client_id`（应用注册页 Application (client) ID）。
3. 询问租户（默认 `common`，个人账号无需改）。
4. 询问 scopes（默认 `Mail.ReadWrite Mail.Send User.Read offline_access`）。
5. **Device code flow** 授权：终端显示 `https://microsoft.com/devicelogin` + 一次性 code，
   用户在任何浏览器（含手机）输入 → 同意 → 终端自动继续。**无需回调端口、无需 client secret**。
6. 授权成功后：调用 `GET /me` 校验，显示授权账号 ✅。
7. 写配置 + token，输出客户端接入片段。

### 4.4 `email-mcp doctor` / `status`

- `status`：显示各 provider 配置状态（clientId 后 4 位、授权账号、token 剩余有效期），**脱敏**。
- `doctor`：逐项检查并输出 ✅/❌ —— 配置文件、clientId 格式、token 存在性、
  token 有效性（静默调一次只读 API）、网络连通性；给出修复命令建议。

### 4.5 环境变量方式（非交互 / 部署场景）

以 `EMAIL_MCP_*` 前缀覆盖配置：`EMAIL_MCP_GMAIL_CLIENT_ID`、
`EMAIL_MCP_GMAIL_CLIENT_SECRET`、`EMAIL_MCP_GMAIL_SCOPES`、`EMAIL_MCP_OUTLOOK_CLIENT_ID` 等。
优先于 config.json（环境变量 > 配置文件 > 默认值）。`.env.example` 提供完整示例。

## 5. 配置与数据 schema

### 5.1 `~/.email-mcp/config.json`（0600）

```json
{
  "version": 1,
  "gmail": {
    "clientId": "1234567890-abc.apps.googleusercontent.com",
    "clientSecret": "GOCSPX-...",          // 可选：留空走 PKCE
    "scopes": ["gmail.modify", "gmail.labels", "gmail.compose"],
    "callbackPort": 8787,
    "account": "me@gmail.com"
  },
  "outlook": {
    "clientId": "11111111-2222-...-9999",
    "tenant": "common",
    "scopes": ["Mail.ReadWrite", "Mail.Send", "User.Read", "offline_access"],
    "account": "me@outlook.com"
  }
}
```

### 5.2 token 文件 `~/.email-mcp/tokens/{gmail,outlook}.json`（0600）

```json
{ "accessToken": "...", "refreshToken": "...", "expiresAt": 1720000000000, "account": "..." }
```

### 5.3 目录约定

| 项 | 默认路径 | 覆盖方式 |
|---|---|---|
| 配置目录 | `~/.email-mcp/` | 环境变量 `EMAIL_MCP_HOME` |
| 配置 | `${EMAIL_MCP_HOME}/config.json` | 环境变量逐项覆盖 |
| token | `${EMAIL_MCP_HOME}/tokens/{provider}.json` | — |

## 6. MCP 工具 API（完整清单）

> 工具名带 provider 前缀，避免多 server 共存时冲突。返回统一包装：
> `{ ok: boolean, data?: ..., error?: { code, message, hint } }`。
> 发送/回复/删除类工具支持 `confirm: true` 显式确认参数（客户端可借此二次确认）。

### 6.1 Gmail（`gmail_*`）

| 工具 | 参数 | 说明 |
|---|---|---|
| `gmail_search` | `query`（Gmail 语法）, `maxResults?=20`, `pageToken?` | 列表元数据（id/主题/发件人/时间/标签） |
| `gmail_get` | `messageId`, `format?="full"` | 正文（HTML→text 转换）+ 附件元数据 |
| `gmail_get_attachment` | `messageId`, `attachmentId` | 返回 base64url 内容 |
| `gmail_send` | `to`, `subject`, `body`, `cc?`, `bcc?`, `attachments?`, `confirm?` | 发送 |
| `gmail_reply` | `messageId`, `body`, `attachments?`, `confirm?` | 回复（引用原文 thread） |
| `gmail_create_draft` | `to`, `subject`, `body`, `cc?`, `bcc?` | 草稿 |
| `gmail_send_draft` | `draftId`, `confirm?` | 发送草稿 |
| `gmail_modify` | `messageId`, `markRead?`, `archive?`, `trash?`, `addLabels?`, `removeLabels?` | 状态修改 |
| `gmail_list_labels` | — | 标签列表 |
| `gmail_create_label` / `gmail_delete_label` | `name` / `labelId` | 标签管理 |
| `gmail_get_profile` | — | 账号邮箱 + 配额 |

### 6.2 Outlook（`outlook_*`）

| 工具 | 参数 | Graph 端点 |
|---|---|---|
| `outlook_search` | `query`（KQL）, `top?=20`, `skip?` | `GET /me/messages?\$search=` |
| `outlook_get` | `messageId` | `GET /me/messages/{id}` |
| `outlook_get_attachment` | `messageId`, `attachmentId` | `GET .../attachments/{id}/\$value` |
| `outlook_send` | `to`, `subject`, `body`, `cc?`, `bcc?`, `attachments?`, `confirm?` | `POST /me/sendMail` |
| `outlook_reply` | `messageId`, `body`, `confirm?` | `POST /me/messages/{id}/reply` |
| `outlook_create_draft` | `to`, `subject`, `body`, `cc?`, `bcc?` | `POST /me/messages`（isDraft） |
| `outlook_send_draft` | `messageId`, `confirm?` | `POST /me/messages/{id}/send` |
| `outlook_modify` | `messageId`, `markRead?`, `categories?` | `PATCH /me/messages/{id}` |
| `outlook_move` | `messageId`, `folderId` | `POST /me/messages/{id}/move` |
| `outlook_list_folders` | — | `GET /me/mailFolders` |
| `outlook_delete` | `messageId`, `confirm?` | `DELETE /me/messages/{id}` |
| `outlook_get_profile` | — | `GET /me` |

## 7. 横切设计

### 7.1 认证层
- **Gmail**：authorization code + **PKCE**（S256）；`client_secret` 有则用 confidential
  模式，无则 public 模式。刷新：`oauth2.googleapis.com/token`；401 → 刷新一次 → 重试。
- **Outlook**：**device code flow**（PublicClientApplication，无需 secret、无需回调）。
  刷新由 MSAL 自动处理（refresh token 默认 90 天滚动）。
- 并发锁：多请求同时 401 时仅触发一次刷新。
- token 文件写入用原子写（临时文件 + rename），权限 0600。

### 7.2 错误与限速
- 错误映射表：401（重新授权）、403/insufficient（scope 不足，提示 setup 重配）、
  429（Retry-After 退避）、400（参数问题）→ 统一 `error.code + hint`。
- Gmail 每日配额：读取类合并请求；Outlook：遵守 `Retry-After`。

### 7.3 安全
- 零内置密钥；config/token 文件 0600；`.gitignore` 兜底；
- 日志脱敏（不打印 token/secret/正文全文）；
- 发送类工具带 `confirm` 参数；HTTP 传输模式默认只监听 127.0.0.1，
  远程访问需自行加反向代理 + TLS（文档提示）。

### 7.4 传输
- `--transport stdio`（默认）：Claude Desktop / Cursor 等本地客户端；
- `--transport http --port 8788`：streamable HTTP，供远程/自研 Agent（仅 localhost 或代理后）。

## 8. 文档体系（docs/）

| 文档 | 内容 |
|---|---|
| `docs/01-google-gmail-oauth-setup.md` | Google 申请凭据逐步指导（含截图位置、常见报错） |
| `docs/02-microsoft-outlook-setup.md` | Entra ID 注册应用逐步指导 |
| `docs/03-first-run-guide.md` | 首次启动走查：setup / doctor / status / 环境变量 |
| `docs/04-mcp-client-integration.md` | 接入 Claude Desktop / Cursor / HTTP 模式 |

## 9. 里程碑与任务拆分

| 里程碑 | 内容 | 验收标准 |
|---|---|---|
| **M0 骨架** | monorepo、CLI（commander）、配置加载/校验、`status`、first-run 引导框架、docs 初版 | `email-mcp gmail` 未配置时打印指引退出 |
| **M1 Gmail 只读** | setup gmail 向导、PKCE 授权、token 存储/刷新、search/get/get_attachment/get_profile | 授权后在 Claude Desktop 搜到邮件 |
| **M2 Outlook 只读** | setup outlook（device code）、MSAL、search/get/get_attachment/get_profile | 授权后搜到 Outlook 邮件 |
| **M3 读写** | send/reply/draft/modify/labels/folders + confirm 确认 | 收发/回复/打标全链路可用 |
| **M4 收尾** | doctor、HTTP 传输、错误映射完善、单测、README 定稿 | 文档与实现一致，doctor 全绿 |

## 10. 已确认决策（本次会话）

- [x] 自建，不依赖官方托管 MCP
- [x] 零内置密钥；首次启动引导用户自助申请并填入
- [x] Gmail + Outlook 并行，一个仓库两个 server（`email-mcp gmail|outlook`）
- [x] TypeScript / Node ≥ 20
- [ ] 待定：使用场景（个人/多账号/企业）→ 影响是否引入 service account / 多账号 token
- [ ] 待定：是否同时支持 HTTP 远程模式（M4 再定）

---

## 11. 实现进度

| 里程碑 | 状态 | 说明 |
|---|---|---|
| **M0 骨架** | ✅ 完成 | CLI 四命令；first-run 引导（未配置 → 指引退出）；setup 向导（交互收集凭据、校验、落盘，权限 0600）；status（脱敏）；doctor（体检）；core 层（config/tokens/mask/logger）；smoke 脚本（`scripts/smoke-setup.mjs`、`smoke-core.mjs` 全绿） |
| **M1 Gmail 只读** | ✅ 完成 | OAuth（authorization code + PKCE，本地回调服务器，浏览器打开）+ 原生 fetch REST 客户端（401 自动刷新、并发刷新锁、错误映射）+ 4 个工具（gmail_search/get/get_attachment/get_profile，纯函数可测）+ setup 接入授权与账号校验 + start 启动真实 MCP server（stdio，日志走 stderr） |
| **M2 Outlook 只读** | ⏳ 待做 | MSAL device code flow + Graph 只读工具 |
| **M2 Outlook 只读** | ✅ 完成 | 手写 device code flow（无重依赖，轮询处理 authorization_pending/slow_down/expired/denied）+ Graph 客户端（KQL \$search、\$top/\$skip/nextLink 分页、401 自动刷新、Retry-After 提示）+ 4 个工具（outlook_search/get/get_attachment/get_profile）+ setup 接入授权与账号校验 + start 启动 server |
| **M3 读写** | ✅ 完成 | Gmail：send/reply（自动引用原文+thread）/create_draft/send_draft/modify（已读/归档/回收站/标签）/list_labels/create_label/delete_label，RFC822 MIME 构造（RFC2047 中文头）；Outlook：send/reply/create_draft/send_draft/modify/move/list_folders/delete；敏感操作 confirm 门控（默认拒绝，confirm:true 放行）；工具注册脚手架抽为 core/toolkit 双侧复用 |
| **M4 收尾** | ✅ 完成 | streamable HTTP 传输（`--transport http --port`，仅 127.0.0.1，DNS rebinding 防护，多会话）；doctor 增强（网络连通性 + token 有效性实测）；node:test 单测（8 项）+ npm scripts（test/smoke）；npm pack 发布检查（44.8 kB） |

**M4 验证结果**：
- HTTP 模式端到端（`scripts/smoke-http.mjs`）：真实 spawn `email-mcp gmail --transport http --port 18788` + SDK HTTP Client 握手/12 工具/callTool 全过 ✅
- node:test 单测 8/8（MIME 构造、配置校验、confirm 门控、脱敏）✅
- 全量回归（单测 + 6 个 smoke 脚本）全部 PASS ✅
- `npm pack --dry-run`：44.8 kB / 52 文件（dist + docs）✅

**M3 验证结果**（`scripts/smoke-m3.mjs`，mock 双侧 API + 真实 spawn CLI）：
- Gmail 读写 19 项：MIME 构造（To/Cc/中文 RFC2047/正文/附件）、reply 引用原文与 Re 前缀、modify 标签映射、标签 CRUD ✅
- Outlook 读写 14 项：sendMail 收件人/附件/存档、draft isDraft、modify/move/folders/delete ✅
- MCP 协议端到端 8 项：双侧各 12 个工具、**confirm 门控**（无 confirm → confirmation_required；confirm:true → 执行）✅
- 全量回归（core/setup/m1/m2/m3 共 5 个脚本）全部 PASS ✅

**M2 验证结果**（`scripts/smoke-m2.mjs`，mock Graph + 真实 spawn CLI）：
- device code 授权 5 项：user_code/verification_uri、pending 轮询成功、slow_down 间隔 +5s（实测 6.0s 间隔）✅
- Graph 客户端与工具 16 项：过期 token 自动刷新、\$search 透传、nextLink 分页、中文字段解析、referenceAttachment 过滤、inline 标记、base64 附件解码 ✅
- MCP 协议端到端 5 项：4 个 outlook_* 工具、callTool search/profile/错误结构 ✅
- 全量回归（smoke-core/setup/m1/m2 共 4 个脚本）全部 PASS ✅

**M1 验证结果**（`scripts/smoke-m1.mjs`，mock Gmail API + 真实 spawn CLI）：
- OAuth 组件 6 项：PKCE S256 正确性、授权 URL 参数（code_challenge/offline/redirect_uri）、本地回调收 code ✅
- API 客户端与工具 19 项：过期 token 自动刷新（refresh_token 传递、旋转落盘）、中文 base64url 正文解码、multipart 解析、附件清单与 inline 标记、错误结构 ✅
- MCP 协议端到端 7 项：listTools 4 个 gmail_* 工具、callTool search/profile、错误调用返回 `{ok:false,error}` ✅
- 全部 32 项通过 ✅

**M0 验证结果**（`EMAIL_MCP_HOME=/tmp/email-mcp-test`）：
- `email-mcp gmail` 未配置 → 打印申请指引并 exit 1 ✅
- `email-mcp setup gmail`（自定义 scopes）→ config.json 正确落盘 ✅
- `email-mcp setup outlook`（默认 scopes）→ 正确落盘 ✅
- 已配置未授权启动 → 提示运行 setup ✅
- `status` / `doctor` 输出与脱敏正确 ✅
- core 层 11 项断言全绿（token 存取/过期/删除、凭据格式正反用例）✅
