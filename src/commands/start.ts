import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getProviderConfig, loadConfig, type GmailConfig, type OutlookConfig } from "../core/config.js";
import { hasToken } from "../core/tokens.js";
import type { Provider } from "../core/paths.js";
import { logger, useStderrMode } from "../core/logger.js";
import { startHttpServer } from "../core/http-server.js";
import { GmailApiClient } from "../gmail/client.js";
import { createGmailServer } from "../gmail/server.js";
import { GraphApiClient } from "../outlook/client.js";
import { createOutlookServer } from "../outlook/server.js";

export interface StartOptions {
  transport?: string;
  port?: string;
}

/**
 * 启动指定 provider 的 MCP server。
 * First-run 引导：未配置凭据 → 打印申请指引并退出（MCP 进程不能在握手期间阻塞等输入）。
 */
export async function startServer(provider: Provider, opts: StartOptions = {}): Promise<void> {
  const cfg = loadConfig();
  const pc = getProviderConfig(cfg, provider);

  if (!pc?.clientId) {
    printFirstRunGuide(provider);
    process.exit(1);
  }

  if (!hasToken(provider)) {
    logger.warn(`${provider} 凭据已配置，但尚未完成 OAuth 授权。`);
    console.log(`  · 运行: email-mcp setup ${provider}    完成授权`);
    console.log("  · 详情: docs/03-first-run-guide.md");
    process.exit(1);
  }

  const transport = opts.transport === "http" ? "http" : "stdio";
  const port = Number(opts.port) || 8788;

  if (transport === "http") {
    await startHttpServer(port, () =>
      provider === "gmail" ? createGmailServer(new GmailApiClient(pc as GmailConfig)) : createOutlookServer(new GraphApiClient(pc as OutlookConfig))
    );
    logger.info(`${provider} HTTP server 运行中，按 Ctrl+C 退出。`);
    await new Promise<void>(() => {});
    return;
  }

  if (provider === "gmail") {
    await startGmailServer(pc as GmailConfig);
  } else {
    await startOutlookServer(pc as OutlookConfig);
  }
}

async function startOutlookServer(o: OutlookConfig): Promise<void> {
  useStderrMode();
  const client = new GraphApiClient(o);
  const server = createOutlookServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("Outlook MCP server 已启动（stdio）。按 Ctrl+C 退出。");

  const shutdown = async (signal: string) => {
    logger.info(`收到 ${signal}，正在关闭...`);
    try {
      await server.close();
    } catch {
      /* 忽略关闭异常 */
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await new Promise<void>(() => {});
}

async function startGmailServer(g: GmailConfig): Promise<void> {
  useStderrMode(); // stdout 只留给 MCP 协议
  const client = new GmailApiClient(g);
  const server = createGmailServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("Gmail MCP server 已启动（stdio）。按 Ctrl+C 退出。");

  const shutdown = async (signal: string) => {
    logger.info(`收到 ${signal}，正在关闭...`);
    try {
      await server.close();
    } catch {
      /* 忽略关闭异常 */
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await new Promise<void>(() => {}); // 保持进程存活（由 stdio 连接驱动）
}

function printFirstRunGuide(provider: Provider): void {
  if (provider === "gmail") {
    console.log(`
⚠ 未检测到 Gmail 配置（首次使用需要你自行申请凭据，本项目不内置任何 key）

  1) 申请 Google OAuth 凭据（约 5 分钟）：
     https://console.cloud.google.com
     → 新建项目 → 启用 Gmail API → 创建 OAuth Client ID（应用类型选 "Desktop app"）
     → 下载 JSON，取出 client_id / client_secret
     详细图文步骤见: docs/01-google-gmail-oauth-setup.md

  2) 运行交互式配置向导（粘贴凭据 + 浏览器授权）：
     email-mcp setup gmail

  3) 完成后重新运行：
     email-mcp gmail
`);
    return;
  }
  console.log(`
⚠ 未检测到 Outlook 配置（首次使用需要你自行申请凭据，本项目不内置任何 key）

  1) 申请 Microsoft 凭据（约 5 分钟）：
     https://entra.microsoft.com
     → App registrations → New registration → 记录 Application (client) ID
     详细图文步骤见: docs/02-microsoft-outlook-setup.md

  2) 运行交互式配置向导（粘贴 client_id + 自动 device code 授权）：
     email-mcp setup outlook

  3) 完成后重新运行：
     email-mcp outlook
`);
}
