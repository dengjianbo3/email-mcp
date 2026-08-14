import { homedir } from "node:os";
import { join } from "node:path";

/** 支持的邮件服务商 */
export type Provider = "gmail" | "outlook";

export const PROVIDERS: Provider[] = ["gmail", "outlook"];

/** 配置根目录（可用 EMAIL_MCP_HOME 覆盖，默认 ~/.email-mcp） */
export function emailMcpHome(): string {
  return process.env.EMAIL_MCP_HOME?.trim() || join(homedir(), ".email-mcp");
}

/** 配置文件路径 */
export function configPath(): string {
  return join(emailMcpHome(), "config.json");
}

/** token 目录 */
export function tokensDir(): string {
  return join(emailMcpHome(), "tokens");
}

/** 某 provider 的 token 文件路径 */
export function tokenPath(provider: Provider): string {
  return join(tokensDir(), `${provider}.json`);
}
