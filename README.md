# email-mcp — Gmail + Outlook 邮件 MCP 服务（自建）

一个自建的邮件 MCP 服务：**不内置任何密钥**，首次启动引导你自行申请并填入凭据
（Google / Microsoft），之后即可让任意 MCP 客户端（Claude Desktop、Cursor、自研 Agent…）
读写你的邮箱。

> 当前状态：**全部里程碑（M0-M4）已完成** ✅ —— 双侧完整邮件能力 + stdio/HTTP 双传输。

## 特性

- 🚀 **零内置密钥**：凭据只存在于你本机 `~/.email-mcp/`（0600 权限）
- 🧭 **首次启动引导**：未配置时打印申请指引并退出，不会让你卡住
- 🪄 **交互式配置向导**：`email-mcp setup gmail|outlook`，自动校验、落盘 + **浏览器 OAuth 授权**（PKCE）
- 🔎 **诊断工具**：`status`（脱敏状态）、`doctor`（体检 + 修复建议）
- 📧 **Gmail + Outlook 完整邮件能力**（M1-M3 已交付）：搜索 / 读详情 / 下载附件 / 账号信息 / **发送 / 回复 / 草稿 / 标签 / 文件夹**；token 自动刷新
  - Gmail：PKCE 浏览器授权；Outlook：device code 授权（终端输码，手机可完成）
  - 🛡️ 发送/删除等敏感操作默认需 `confirm: true` 显式确认
- 🌐 双传输：stdio（默认，本地客户端）+ streamable HTTP（`--transport http --port`，仅本机监听）

## 快速开始

```bash
npm install
npm run build

# 首次使用：申请凭据后运行配置向导（Gmail 会引导浏览器授权）
email-mcp setup gmail     # 需要 Google client_id/client_secret
email-mcp setup outlook   # 需要 Microsoft Application (client) ID

# 查看状态 / 体检
email-mcp status
email-mcp doctor

# 启动 server（由 MCP 客户端拉起，见 docs/04）
email-mcp gmail                          # stdio（默认）
email-mcp outlook --transport http --port 8788   # HTTP 模式（远程/自研 Agent）
```

## 申请凭据（约各 5 分钟）

| 服务 | 申请入口 | 指南 |
|---|---|---|
| Gmail | https://console.cloud.google.com | [docs/01-google-gmail-oauth-setup.md](docs/01-google-gmail-oauth-setup.md) |
| Outlook | https://entra.microsoft.com | [docs/02-microsoft-outlook-setup.md](docs/02-microsoft-outlook-setup.md) |

## 文档

| 文档 | 内容 |
|---|---|
| [DESIGN.md](DESIGN.md) | 总体设计（架构 / first-run 流程 / 工具 API / 安全 / 里程碑 / 实现进度） |
| [docs/01-google-gmail-oauth-setup.md](docs/01-google-gmail-oauth-setup.md) | Google 凭据申请步骤 |
| [docs/02-microsoft-outlook-setup.md](docs/02-microsoft-outlook-setup.md) | Microsoft 凭据申请步骤 |
| [docs/03-first-run-guide.md](docs/03-first-run-guide.md) | 首次启动走查（含环境变量方式） |
| [docs/04-mcp-client-integration.md](docs/04-mcp-client-integration.md) | 接入 Claude Desktop / Cursor 等 |

## 命令参考

```
email-mcp gmail               启动 Gmail MCP server（stdio）
email-mcp outlook             启动 Outlook MCP server（stdio）
email-mcp setup <provider>    首次配置向导（gmail | outlook）
email-mcp status              查看配置状态（脱敏）
email-mcp doctor              配置体检并给出修复建议
```

## 测试

```bash
npm test      # 单元测试（node:test，8 项）
npm run smoke # 全量冒烟（6 个脚本：core/setup/Gmail/Outlook/读写/HTTP，mock API + 真实 MCP 进程）
```

## 配置位置

- 配置：`~/.email-mcp/config.json`
- token：`~/.email-mcp/tokens/{gmail,outlook}.json`
- 可用 `EMAIL_MCP_HOME` 覆盖目录；可用 `EMAIL_MCP_*` 环境变量覆盖配置
  （完整示例见 `.env.example`）

## 安全

- 项目内零密钥；config/token 文件权限 0600；`.gitignore` 兜底
- 日志脱敏；MCP server 模式下日志走 stderr，不污染 stdio 协议通道
- 发送类工具（M3）带 `confirm` 参数二次确认
- 如泄露凭据：Google Cloud Console / Entra 中吊销重建即可

## 路线图（全部完成 ✅）

- [x] **M0** 骨架：CLI、first-run 引导、配置向导、status/doctor
- [x] **M1** Gmail 只读：OAuth（PKCE + 本地回调）+ search/get/get_attachment/get_profile
- [x] **M2** Outlook 只读：OAuth（device code）+ search/get/get_attachment/get_profile
- [x] **M3** 读写：send/reply/draft/modify/labels/folders（带 confirm 门控）
- [x] **M4** 收尾：HTTP 传输、doctor 增强（网络/token 实测）、node:test 单测、发布检查
