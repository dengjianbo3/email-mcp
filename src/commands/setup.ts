import prompts from "prompts";
import {
  DEFAULT_CALLBACK_PORT,
  DEFAULT_GMAIL_SCOPES,
  DEFAULT_OUTLOOK_SCOPES,
  GMAIL_CLIENT_ID_RE,
  UUID_RE,
  getProviderConfig,
  loadConfig,
  saveConfig,
  validateProviderConfig,
  type GmailConfig,
  type OutlookConfig,
} from "../core/config.js";
import { configPath } from "../core/paths.js";
import type { Provider } from "../core/paths.js";
import { logger } from "../core/logger.js";
import { authorizeGmail, needsGmailAuthorization } from "../gmail/oauth.js";
import { GmailApiClient } from "../gmail/client.js";
import { authorizeOutlook, needsOutlookAuthorization } from "../outlook/oauth.js";
import { GraphApiClient } from "../outlook/client.js";
import { EmailMcpError } from "../core/errors.js";

/** @types/prompts 声明不完整（缺 skip 等属性），这里用宽松类型桥接 */
type PromptItem = prompts.PromptObject<string>;
function promptItem(p: Record<string, unknown>): PromptItem {
  return p as unknown as PromptItem;
}

/**
 * 首次配置向导：交互式收集凭据 → 校验 → 写入 ~/.email-mcp/config.json。
 * （OAuth 授权环节在 M1 里程碑接入；本里程碑完成凭据收集与落盘。）
 */
export async function setupProvider(provider: Provider): Promise<void> {
  console.log(`\n===== email-mcp setup ${provider} =====\n`);
  if (provider === "gmail") {
    console.log("申请 Google 凭据（约 5 分钟）: docs/01-google-gmail-oauth-setup.md");
    console.log("在线控制台: https://console.cloud.google.com\n");
  } else {
    console.log("申请 Microsoft 凭据（约 5 分钟）: docs/02-microsoft-outlook-setup.md");
    console.log("在线控制台: https://entra.microsoft.com\n");
  }

  const answers = provider === "gmail" ? await askGmail() : await askOutlook();
  if (!answers || Object.keys(answers).length === 0) {
    console.log("已取消，未做任何修改。");
    return;
  }

  const cfg = loadConfig();
  if (provider === "gmail") {
    const a = answers as { clientId: string; clientSecret?: string; scopes: string[] };
    cfg.gmail = {
      clientId: a.clientId.trim(),
      clientSecret: a.clientSecret?.trim() || undefined,
      scopes: a.scopes,
      callbackPort: cfg.gmail?.callbackPort ?? DEFAULT_CALLBACK_PORT,
      account: cfg.gmail?.account,
    } satisfies GmailConfig;
  } else {
    const a = answers as { clientId: string; tenant: string; scopes: string[] };
    cfg.outlook = {
      clientId: a.clientId.trim(),
      tenant: a.tenant.trim(),
      scopes: a.scopes,
      account: cfg.outlook?.account,
    } satisfies OutlookConfig;
  }

  const errors = validateProviderConfig(provider, getProviderConfig(cfg, provider));
  if (errors.length > 0) {
    console.error("❌ 配置校验未通过：");
    for (const e of errors) console.error(`  - ${e}`);
    console.error("请重新运行: email-mcp setup " + provider);
    process.exitCode = 1;
    return;
  }

  saveConfig(cfg);
  console.log(`\n✅ 凭据已保存到 ${configPath()}`);

  if (provider === "gmail") {
    await authorizeAndVerifyGmail(cfg.gmail!);
  } else {
    await authorizeAndVerifyOutlook(cfg.outlook!);
  }
  logger.info(`setup ${provider} 完成（凭据已落盘）`);
}

/** Outlook：完成 device code 授权并用 Graph /me 校验账号 */
async function authorizeAndVerifyOutlook(o: OutlookConfig): Promise<void> {
  if (!needsOutlookAuthorization()) {
    console.log("ℹ 检测到已有授权 token（可复用），跳过授权。");
  } else {
    await authorizeOutlook(o);
  }
  try {
    const profile = await new GraphApiClient(o).getProfile();
    const cfg = loadConfig();
    if (cfg.outlook) {
      cfg.outlook.account = profile.mail || profile.userPrincipalName || profile.displayName;
      saveConfig(cfg);
    }
    console.log(`\n✅ Outlook 授权成功: ${profile.mail ?? profile.userPrincipalName ?? profile.displayName ?? "(未知账号)"}`);
    console.log("\n下一步：在 MCP 客户端中注册本 server（见 docs/04-mcp-client-integration.md），");
    console.log("  然后启动: email-mcp outlook");
  } catch (err) {
    const e = err as EmailMcpError;
    console.error(`\n⚠ token 已保存，但账号校验失败: ${e.message}`);
    if (e.hint) console.error(`  建议: ${e.hint}`);
  }
}

/** Gmail：完成 OAuth 授权并用 getProfile 校验账号 */
async function authorizeAndVerifyGmail(g: GmailConfig): Promise<void> {
  if (!needsGmailAuthorization()) {
    console.log("ℹ 检测到已有授权 token（可复用），跳过浏览器授权。");
  } else {
    await authorizeGmail(g);
  }
  try {
    const profile = await new GmailApiClient(g).getProfile();
    const cfg = loadConfig();
    if (cfg.gmail) {
      cfg.gmail.account = profile.emailAddress;
      saveConfig(cfg);
    }
    console.log(`\n✅ Gmail 授权成功: ${profile.emailAddress}`);
    console.log("\n下一步：在 MCP 客户端中注册本 server（见 docs/04-mcp-client-integration.md），");
    console.log("  然后启动: email-mcp gmail");
  } catch (err) {
    const e = err as EmailMcpError;
    console.error(`\n⚠ token 已保存，但账号校验失败: ${e.message}`);
    if (e.hint) console.error(`  建议: ${e.hint}`);
  }
}

async function askGmail() {
  const questions: PromptItem[] = [
    {
      type: "text",
      name: "clientId",
      message:
        "粘贴 client_id（Google Cloud Console 下载的 client_secret_*.json 中复制）",
      validate: (v: string) =>
        GMAIL_CLIENT_ID_RE.test(String(v).trim()) ||
        "格式不正确，应为 数字-xxxx.apps.googleusercontent.com",
    },
    {
      type: "password",
      name: "clientSecret",
      message: "client_secret（可选，留空则走 PKCE 公钥流程）",
    },
    {
      type: "toggle",
      name: "useDefaultScopes",
      message: `使用推荐权限范围（${DEFAULT_GMAIL_SCOPES.join(" ")}）？`,
      initial: true,
      active: "是",
      inactive: "自定义",
    },
    promptItem({
      type: "text",
      name: "customScopes",
      message: "自定义 scopes（空格分隔）",
      skip: (prev: boolean) => prev === true,
    }),
  ];
  return prompts(questions).then((r) => ({
    clientId: r.clientId as string,
    clientSecret: r.clientSecret as string | undefined,
    scopes: r.useDefaultScopes
      ? DEFAULT_GMAIL_SCOPES
      : String(r.customScopes || "").split(/\s+/).filter(Boolean),
  }));
}

async function askOutlook() {
  const questions: PromptItem[] = [
    {
      type: "text",
      name: "clientId",
      message:
        "粘贴 Application (client) ID（Entra 应用注册页复制，形如 11111111-....-555555555555）",
      validate: (v: string) =>
        UUID_RE.test(String(v).trim()) ||
        "格式不正确，应为 UUID（可复制错成了 Directory ID？）",
    },
    {
      type: "text",
      name: "tenant",
      message: "租户（个人账号直接回车，默认 common）",
      initial: "common",
    },
    {
      type: "toggle",
      name: "useDefaultScopes",
      message: `使用推荐权限范围（${DEFAULT_OUTLOOK_SCOPES.join(" ")}）？`,
      initial: true,
      active: "是",
      inactive: "自定义",
    },
    promptItem({
      type: "text",
      name: "customScopes",
      message: "自定义 scopes（空格分隔）",
      skip: (prev: boolean) => prev === true,
    }),
  ];
  return prompts(questions).then((r) => ({
    clientId: r.clientId as string,
    tenant: (r.tenant as string) || "common",
    scopes: r.useDefaultScopes
      ? DEFAULT_OUTLOOK_SCOPES
      : String(r.customScopes || "").split(/\s+/).filter(Boolean),
  }));
}
