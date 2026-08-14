import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Provider } from "./paths.js";
import { configPath, emailMcpHome } from "./paths.js";
import { EmailMcpError } from "./errors.js";

export interface GmailConfig {
  clientId: string;
  clientSecret?: string;
  scopes: string[];
  callbackPort: number;
  account?: string;
}

export interface OutlookConfig {
  clientId: string;
  tenant: string;
  scopes: string[];
  account?: string;
}

export interface AppConfig {
  version: number;
  gmail?: GmailConfig;
  outlook?: OutlookConfig;
}

export const CONFIG_VERSION = 1;
export const DEFAULT_GMAIL_SCOPES = ["gmail.modify", "gmail.labels", "gmail.compose"];
export const DEFAULT_OUTLOOK_SCOPES = ["Mail.ReadWrite", "Mail.Send", "User.Read", "offline_access"];
export const DEFAULT_CALLBACK_PORT = 8787;

/** Gmail clientId: 数字-xxxx.apps.googleusercontent.com */
export const GMAIL_CLIENT_ID_RE = /^\d+-[\w.]+@?[\w.-]*\.apps\.googleusercontent\.com$/;
/** Outlook clientId: UUID */
export const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function emptyConfig(): AppConfig {
  return { version: CONFIG_VERSION };
}

/** 读取 ~/.email-mcp/config.json（不存在或损坏时返回空配置） */
export function loadConfigFile(): AppConfig {
  const p = configPath();
  if (!existsSync(p)) return emptyConfig();
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as Partial<AppConfig>;
    if (!parsed || typeof parsed !== "object") return emptyConfig();
    return { ...emptyConfig(), ...parsed };
  } catch {
    throw new EmailMcpError(
      `配置文件解析失败: ${p}`,
      "请修复或删除该文件后重试（运行 email-mcp setup <provider> 重建）"
    );
  }
}

/** 合并环境变量覆盖（优先级：环境变量 > 配置文件 > 默认值） */
export function loadConfig(): AppConfig {
  const cfg = loadConfigFile();

  const gId = process.env.EMAIL_MCP_GMAIL_CLIENT_ID?.trim();
  if (gId) {
    cfg.gmail = {
      clientId: gId,
      clientSecret: process.env.EMAIL_MCP_GMAIL_CLIENT_SECRET?.trim() || cfg.gmail?.clientSecret,
      scopes:
        process.env.EMAIL_MCP_GMAIL_SCOPES?.split(/\s+/).filter(Boolean) ||
        cfg.gmail?.scopes ||
        DEFAULT_GMAIL_SCOPES,
      callbackPort:
        Number(process.env.EMAIL_MCP_GMAIL_CALLBACK_PORT) ||
        cfg.gmail?.callbackPort ||
        DEFAULT_CALLBACK_PORT,
    };
  }

  const oId = process.env.EMAIL_MCP_OUTLOOK_CLIENT_ID?.trim();
  if (oId) {
    cfg.outlook = {
      clientId: oId,
      tenant: process.env.EMAIL_MCP_OUTLOOK_TENANT?.trim() || cfg.outlook?.tenant || "common",
      scopes:
        process.env.EMAIL_MCP_OUTLOOK_SCOPES?.split(/\s+/).filter(Boolean) ||
        cfg.outlook?.scopes ||
        DEFAULT_OUTLOOK_SCOPES,
    };
  }

  return cfg;
}

export function getProviderConfig(
  cfg: AppConfig,
  provider: Provider
): GmailConfig | OutlookConfig | undefined {
  return provider === "gmail" ? cfg.gmail : cfg.outlook;
}

/** 校验凭据格式，返回错误列表（空数组 = 通过） */
export function validateProviderConfig(
  provider: Provider,
  c: GmailConfig | OutlookConfig | undefined
): string[] {
  if (!c) return [];
  if (provider === "gmail") {
    const g = c as GmailConfig;
    const errs: string[] = [];
    if (!g.clientId?.trim()) errs.push("clientId 不能为空");
    else if (!GMAIL_CLIENT_ID_RE.test(g.clientId.trim()))
      errs.push("clientId 格式不正确（应为 数字-xxxx.apps.googleusercontent.com）");
    if (g.callbackPort < 1 || g.callbackPort > 65535) errs.push("callbackPort 无效（1-65535）");
    if (!g.scopes?.length) errs.push("scopes 不能为空");
    return errs;
  }
  const o = c as OutlookConfig;
  const errs: string[] = [];
  if (!o.clientId?.trim()) errs.push("clientId 不能为空");
  else if (!UUID_RE.test(o.clientId.trim()))
    errs.push("clientId 格式不正确（应为 UUID，如 11111111-2222-3333-4444-555555555555）");
  if (!o.tenant?.trim()) errs.push("tenant 不能为空");
  if (!o.scopes?.length) errs.push("scopes 不能为空");
  return errs;
}

/** 保存配置（文件权限收紧到 0600） */
export function saveConfig(cfg: AppConfig): void {
  mkdirSync(emailMcpHome(), { recursive: true });
  const p = configPath();
  writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  try {
    chmodSync(p, 0o600);
  } catch {
    /* Windows 上 chmod 无操作，忽略 */
  }
}

export { emailMcpHome };
