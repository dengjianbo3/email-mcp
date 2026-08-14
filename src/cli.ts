#!/usr/bin/env node
import { Command } from "commander";
import { PROVIDERS } from "./core/paths.js";
import type { Provider } from "./core/paths.js";
import { startServer } from "./commands/start.js";
import { setupProvider } from "./commands/setup.js";
import { statusCmd } from "./commands/status.js";
import { doctorCmd } from "./commands/doctor.js";

function normalizeProvider(p: string): Provider {
  const v = p.toLowerCase();
  if (!PROVIDERS.includes(v as Provider)) {
    console.error(`❌ 未知 provider: ${p}（可用: ${PROVIDERS.join(" | ")}）`);
    process.exit(1);
  }
  return v as Provider;
}

const program = new Command();
program
  .name("email-mcp")
  .description("Gmail + Outlook 邮件 MCP 服务（自建，首次启动引导用户自行填入凭据）")
  .version("0.1.0");

program
  .command("gmail")
  .description("启动 Gmail MCP server")
  .option("--transport <type>", "传输方式: stdio（默认）| http")
  .option("--port <port>", "HTTP 模式端口（默认 8788）", "8788")
  .action((opts: { transport?: string; port?: string }) => startServer("gmail", opts));

program
  .command("outlook")
  .description("启动 Outlook MCP server")
  .option("--transport <type>", "传输方式: stdio（默认）| http")
  .option("--port <port>", "HTTP 模式端口（默认 8788）", "8788")
  .action((opts: { transport?: string; port?: string }) => startServer("outlook", opts));

program
  .command("setup")
  .description("首次配置向导（交互式填写凭据）")
  .argument("<provider>", "gmail | outlook")
  .action((p: string) => setupProvider(normalizeProvider(p)));

program
  .command("status")
  .description("查看各服务配置状态（脱敏）")
  .action(statusCmd);

program
  .command("doctor")
  .description("配置体检并给出修复建议（含网络连通性与 token 有效性）")
  .action(() => doctorCmd());

program.parseAsync().catch((err: Error) => {
  console.error(`[email-mcp] 执行失败: ${err?.message ?? err}`);
  process.exitCode = 1;
});
