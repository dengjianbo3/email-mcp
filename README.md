# email-mcp — Gmail + Outlook 邮件 MCP 服务（自建）

一个自建的邮件 MCP 服务：**不内置任何密钥**，首次启动引导你自行申请凭据并完成 OAuth 授权，
之后即可让任意 MCP 客户端（Claude Desktop、Cursor、自研 Agent）读写你的邮箱。

> 状态：**M0-M4 全部里程碑已完成**，真实账号联调通过（Gmail 全链路验证）。
> 架构与设计见 [DESIGN.md](DESIGN.md)；本 README 是完整使用手册。

---

## 功能

每个服务商暴露 **12 个 MCP 工具**（共 24 个）：

| 类别 | Gmail | Outlook |
|---|---|---|
| 只读 | gmail_search / gmail_get / gmail_get_attachment / gmail_get_profile | outlook_search / outlook_get / outlook_get_attachment / outlook_get_profile |
| 发送/回复 | gmail_send / gmail_reply | outlook_send / outlook_reply |
| 草稿 | gmail_create_draft / gmail_send_draft | outlook_create_draft / outlook_send_draft |
| 整理 | gmail_modify / gmail_list_labels / gmail_create_label / gmail_delete_label | outlook_modify / outlook_move / outlook_list_folders / outlook_delete |

关键特性：

- 🚀 **零内置密钥**：凭据只存在于 ~/.email-mcp/（权限 0600），不入项目、不入 git
- 🧭 **首次启动引导**：未配置时打印申请指引并退出（不会卡住）
- 🪄 **配置向导**：setup 交互式填凭据 + 自动 OAuth 授权（Gmail 浏览器授权 / Outlook 终端输码）
- 🛡️ **安全门控**：发送/删除等敏感操作默认需 confirm:true 显式确认
- 🔑 **token 自动刷新** + 并发刷新锁 + 401 自动重试
- 🌐 **双传输**：stdio（本地客户端默认）+ streamable HTTP（远程 Agent，仅本机监听）
- 🌍 **代理支持**：自动走 HTTP_PROXY / HTTPS_PROXY 环境变量（大陆/代理环境可用）

---

## 目录结构

```
src/            # TypeScript 源码
  cli.ts          # CLI 入口（gmail/outlook/setup/status/doctor）
  commands/       # 各子命令实现
  core/           # 公共：配置/token/日志/脱敏/confirm 门控/网络代理/HTTP server
  gmail/          # Gmail：OAuth + API 客户端 + 工具 + MCP server
  outlook/        # Outlook：OAuth + Graph 客户端 + 工具 + MCP server
scripts/        # 冒烟测试 + mcp-console 命令行测试工具 + 部署脚本
docs/           # 详细文档（见文末索引）
test/           # node:test 单元测试
```

---

## 完整使用流程

### 第 0 步：环境要求

- **Node.js ≥ 20**（推荐 22+）
- 一个 **Google 账号**（Gmail）和/或一个 **微软账号**（Outlook）
- 中国大陆网络环境：需要本地代理（Clash 等），并确保 HTTP_PROXY / HTTPS_PROXY
  环境变量已设置（见「代理环境」一节）

### 第 1 步：安装与构建

```bash
git clone git@github.com:dengjianbo3/email-mcp.git
cd email-mcp
npm install
npm run build

# （可选）全局注册命令，方便任意目录使用
npm link
```

构建后可用 email-mcp --help 查看命令；未 npm link 则用 node dist/cli.js 代替 email-mcp。

### 第 2 步：Google Console 注册（申请 Gmail 凭据）

> ⚠️ 这是绕不开的一步，约 5-10 分钟。目标：拿到 client_id 和 client_secret。

#### 2.1 创建项目

1. 打开 https://console.cloud.google.com ，用你的 Gmail 账号登录
2. 顶部项目选择器 → **新建项目** → 名称随意（如 email-mcp）→ 创建
3. 确认右上角已选中该新项目

#### 2.2 启用 Gmail API

1. 左侧菜单 → **API 和服务（APIs & Services）** → **库（Library）**
2. 搜索 **Gmail API** → 进入 → 点 **启用（Enable）**

#### 2.3 配置 OAuth 同意屏幕（关键，最容易卡在这里）

新版界面叫 **Google Auth Platform**，分三个页签，**每个都要配且最后要点保存**：

**① Branding（品牌）** — https://console.cloud.google.com/auth/branding
- App name：email-mcp
- User support email：你的邮箱
- 同意政策勾选 → 创建

**② Audience（受众群体）** — https://console.cloud.google.com/auth/audience
- 用户类型：个人账号只能选 **External**（企业 Workspace 可选 Internal）
- **测试用户（Test users）→ 添加用户 → 输入你自己的 Gmail 邮箱 → 保存**
  （Testing 状态只有测试用户能授权，漏了会报 access_denied）

**③ Data Access（数据访问）** — https://console.cloud.google.com/auth/scopes
- 点 **添加或移除范围（Add or Remove Scopes）**
- 在 **手动添加范围（Manually add scopes）** 粘贴以下**完整 URL**（共 4 个）：
  ```
  https://www.googleapis.com/auth/gmail.readonly
  https://www.googleapis.com/auth/gmail.compose
  https://www.googleapis.com/auth/gmail.modify
  https://www.googleapis.com/auth/gmail.labels
  ```
- 逐个点 **添加到表格（Add to Table）** → 全部加完后点 **更新（Update）**
- 回到 Data Access 页面，**点保存（Save）** ← 漏点保存会报 invalid_scope

> 说明：scope 配置的变更可能需要 **5 分钟到几小时**才生效（Google 侧缓存）。

#### 2.4 创建 OAuth 客户端（Desktop app）

1. https://console.cloud.google.com/apis/credentials → **创建凭据 → OAuth 客户端 ID**
2. 应用类型：**桌面应用（Desktop app）** ⚠️ 不要选 Web 应用
3. 名称随意 → 创建
4. 点 **下载 JSON**，得到 client_secret_*.json

#### 2.5 取出凭据

打开下载的 JSON：

```json
{ "installed": {
    "client_id": "528633886473-xxxx.apps.googleusercontent.com",
    "client_secret": "GOCSPX-xxxxxxxx"
} }
```

- client_id：形如 数字-xxxx.apps.googleusercontent.com
- client_secret：形如 GOCSPX-...

这两个值就是 setup gmail 要填的内容。**切勿提交到 git**（本项目的 .gitignore 已拦截 test_keys/ 等目录）。

### 第 3 步：（可选）Microsoft 注册（申请 Outlook 凭据）

Outlook 走 **device code** 授权，**只需 client_id，不需要 secret、不需要回调地址**。

1. 打开 https://entra.microsoft.com ，用 Outlook 邮箱登录
2. **App registrations（应用注册）** → **New registration**
3. Name：email-mcp；Supported account types：个人账号选 **Personal Microsoft accounts only**（或选最通用的含个人账号项）
4. Redirect URI：选 **Mobile and desktop applications** → http://localhost
5. Register → 记下 **Application (client) ID**（UUID 形式）

详细步骤见 [docs/02-microsoft-outlook-setup.md](docs/02-microsoft-outlook-setup.md)。

### 第 4 步：配置与授权

```bash
# Gmail：粘贴 client_id / client_secret → 浏览器自动打开完成授权
email-mcp setup gmail

# Outlook：粘贴 client_id → 终端显示链接和一次性代码 → 任意浏览器输入完成授权
email-mcp setup outlook
```

成功标志：终端显示「✅ Gmail 授权成功: 你的邮箱」。

### 第 5 步：验证

```bash
email-mcp status     # 查看两侧配置状态（脱敏显示）
email-mcp doctor     # 深度体检：配置/凭据格式/token 有效性/网络连通性
```

### 第 6 步：接入 MCP 客户端

**Claude Desktop**（macOS：~/Library/Application Support/Claude/claude_desktop_config.json）：

```json
{
  "mcpServers": {
    "gmail":   { "command": "email-mcp", "args": ["gmail"] },
    "outlook": { "command": "email-mcp", "args": ["outlook"] }
  }
}
```

保存后**完全退出并重启**客户端，右侧工具列表出现 gmail_* / outlook_* 即成功。

**Cursor**（.cursor/mcp.json）配置同上。其他客户端与 HTTP 远程模式见
[docs/04-mcp-client-integration.md](docs/04-mcp-client-integration.md)。

### 第 7 步：命令行测试（无需 GUI 客户端）

```bash
# 查看工具清单
node scripts/mcp-console.mjs gmail list

# 只读测试
node scripts/mcp-console.mjs gmail gmail_get_profile '{}'
node scripts/mcp-console.mjs gmail gmail_search '{"query":"is:unread","maxResults":5}'
node scripts/mcp-console.mjs gmail gmail_get '{"messageId":"<上一步返回的 id>"}'

# 零风险写测试（创建草稿，不发送）
node scripts/mcp-console.mjs gmail gmail_create_draft '{"to":"你的邮箱","subject":"测试","body":"你好"}'

# 发送测试（发给自己的另一个邮箱，注意 confirm:true）
node scripts/mcp-console.mjs gmail gmail_send '{"to":"你的备用邮箱","subject":"测试","body":"内容","confirm":true}'
```

完整测试清单见 [docs/05-testing-guide.md](docs/05-testing-guide.md)。

---

## 部署

### 本地部署（桌面客户端场景）

```bash
./scripts/deploy-local.sh           # npm ci + build + 引导 setup
./scripts/deploy-local.sh --link    # 额外全局注册 email-mcp 命令
```

### 远程部署（Linux 服务器 + systemd + HTTP 模式）

```bash
# 前置：服务器上已 npm ci && npm run build，且 ~/.email-mcp 配置已就绪
./scripts/deploy-remote.sh gmail 8788     # 生成 systemd 服务并启动（仅监听 127.0.0.1）
```

公网暴露前必须加 HTTPS 反向代理（nginx 示例见脚本输出或 docs/04）。

### Docker 部署

```bash
# 把 ~/.email-mcp（config.json + tokens）准备好
docker compose up -d    # 起 gmail + outlook 两个容器，仅绑定 127.0.0.1
```

---

## 配置与数据位置

| 内容 | 路径 | 说明 |
|---|---|---|
| 配置 | ~/.email-mcp/config.json | clientId/secret/scopes（0600） |
| token | ~/.email-mcp/tokens/{gmail,outlook}.json | access/refresh token（0600） |
| 覆盖目录 | 环境变量 EMAIL_MCP_HOME | 换目录或做多账号隔离 |

所有配置均可用环境变量覆盖（优先级：环境变量 > config.json > 默认值），完整示例见 .env.example。

### 代理环境（中国大陆等）

本项目网络层自动读取 HTTP_PROXY / HTTPS_PROXY 环境变量，外部 API 走代理、本地回环直连。请确保：

```bash
export HTTP_PROXY=http://127.0.0.1:7890
export HTTPS_PROXY=http://127.0.0.1:7890
```

注意：Claude Desktop 等 **GUI 客户端**启动的进程通常不继承 shell 代理变量，
若出现「无法连接 Gmail API」，需在客户端所在环境（launchctl / GUI 启动方式）注入代理变量，
或改用 HTTP 模式部署到有代理的服务器上。

---

## 安全

- 项目内**零内置密钥**；凭据/token 文件权限 0600；.gitignore 拦截 test_keys/、config.json、tokens/、*.tmp
- 日志脱敏（不打印 token/secret/正文全文）；MCP server 模式日志走 stderr，不污染协议通道
- 发送/删除等敏感操作**默认拒绝**，需 confirm:true 显式确认
- HTTP 模式仅绑定 127.0.0.1 + DNS rebinding 防护；公网必须加 TLS 反代 + 鉴权
- 凭据泄露应急：Google Cloud Console → Credentials 删除重建；Entra → 吊销

---

## 测试

```bash
npm test        # 单元测试（node:test，8 项）
npm run smoke   # 全量冒烟（6 个脚本，mock API + 真实 MCP 进程，不碰真实邮箱）
```

---

## 排障（真实联调踩坑）

| 现象 | 处理 |
|---|---|
| 授权报 invalid_scope | Data Access 未声明该 scope 或未保存；scope 用完整 URL 形式；变更后等 5 分钟-几小时 |
| 授权报 access_denied（403） | Testing 应用的测试用户名单未包含该账号 → Audience 添加测试用户 |
| 授权报 Parameter not allowed: client_secret | 旧版 bug，已修复 |
| 授权报 redirect_uri_mismatch | 客户端类型选错（选了 Web），应为 Desktop app |
| token 交换超时（ConnectTimeout） | 代理环境：确认 HTTP_PROXY / HTTPS_PROXY 已设置且端口可达 |
| 搜索有结果但 From/Subject 为空 | 旧版 format/metadataHeaders bug，已修复 |
| get_profile 返回 401 | token 失效，重跑 email-mcp setup <provider> |
| confirmation_required | 正常安全门控，确认后加 "confirm":true |
| 客户端报 spawn email-mcp ENOENT | 未全局注册，改用绝对路径或 npm link |

---

## 文档索引

| 文档 | 内容 |
|---|---|
| [DESIGN.md](DESIGN.md) | 总体架构 / first-run 流程 / 工具 API / 安全 / 里程碑 |
| [docs/01-google-gmail-oauth-setup.md](docs/01-google-gmail-oauth-setup.md) | Google 凭据申请图文步骤 |
| [docs/02-microsoft-outlook-setup.md](docs/02-microsoft-outlook-setup.md) | Microsoft 凭据申请图文步骤 |
| [docs/03-first-run-guide.md](docs/03-first-run-guide.md) | 首次启动走查（含环境变量方式） |
| [docs/04-mcp-client-integration.md](docs/04-mcp-client-integration.md) | 接入 Claude Desktop / Cursor / HTTP 远程 |
| [docs/05-testing-guide.md](docs/05-testing-guide.md) | 测试指南与排障 |
| [docs/06-official-gmail-mcp.md](docs/06-official-gmail-mcp.md) | 【备选】Google 官方远程 Gmail MCP 接入 |

---

## 路线图

- [x] **M0** 骨架：CLI、first-run 引导、配置向导、status/doctor
- [x] **M1** Gmail 只读：OAuth（PKCE）+ search/get/get_attachment/get_profile
- [x] **M2** Outlook 只读：OAuth（device code）+ 对应只读工具
- [x] **M3** 读写：send/reply/draft/modify/labels/folders（confirm 门控）
- [x] **M4** 收尾：HTTP 传输、doctor 增强、单测、代理支持、真实账号联调
