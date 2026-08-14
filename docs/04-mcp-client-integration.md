# 指南 04：接入 MCP 客户端

> 完成指南 03（setup 成功）后，把 server 注册到你的 MCP 客户端即可使用。
> 以下配置示例假设 `email-mcp` 已安装到 PATH（`npm link` 或全局安装）。

## 1. Claude Desktop

编辑配置文件（macOS：`~/Library/Application Support/Claude/claude_desktop_config.json`；
Windows：`%APPDATA%\\Claude\\claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "gmail": {
      "command": "email-mcp",
      "args": ["gmail"]
    },
    "outlook": {
      "command": "email-mcp",
      "args": ["outlook"]
    }
  }
}
```

保存后**完全退出并重启 Claude Desktop**，右侧工具列表应出现 `gmail_*` / `outlook_*` 工具。

## 2. Cursor

编辑项目内 `.cursor/mcp.json`（或全局 `~/.cursor/mcp.json`）：

```json
{
  "mcpServers": {
    "gmail": {
      "command": "email-mcp",
      "args": ["gmail"]
    },
    "outlook": {
      "command": "email-mcp",
      "args": ["outlook"]
    }
  }
}
```

Cursor 设置页 → MCP → 刷新，看到绿色状态即成功。

## 3. 其他支持 stdio 的客户端（通用）

只要支持 "command + args" 形式的 stdio MCP server，照搬上面的 `command` / `args`
结构即可（Cherry Studio、Windsurf、VS Code Copilot 等）。

## 4. 远程模式（可选，streamable HTTP）

如果 server 跑在服务器上，供远程 Agent 调用：

```bash
# 服务器上：仅本机监听，前面建议挂 HTTPS 反向代理（如 nginx/caddy）
email-mcp outlook --transport http --port 8788
```

客户端配置（示例）：

```json
{
  "mcpServers": {
    "outlook-remote": {
      "type": "http",
      "url": "https://your-host:8788/mcp"
    }
  }
}
```

> ⚠ 安全提示：HTTP 模式暴露的是完整邮件读写能力，**不要**直接公网裸跑。
> 必须放在 127.0.0.1 或反向代理 + TLS + 访问鉴权之后。

## 5. 验证是否可用

在客户端对话里试一句：

- "帮我搜一下最近 5 封来自 GitHub 的邮件"（gmail_* 生效）
- "看看我的收件箱有没有未读邮件"（outlook_* 生效）

若工具未出现，运行 `email-mcp doctor` 排查，或查看客户端日志。

## 6. 常见问题

| 现象 | 处理 |
|---|---|
| 客户端报 "spawn email-mcp ENOENT" | `email-mcp` 不在 PATH；改用绝对路径，如 `"/usr/local/bin/email-mcp"` |
| 工具出现但调用报 401 | token 失效；重跑 `email-mcp setup <provider>` |
| 两个 server 同时用 | 工具前缀已隔离（gmail_* / outlook_*），无冲突 |
| 想限制权限 | 重跑 setup 时选择更小 scope（如 gmail.readonly / Mail.Read） |
