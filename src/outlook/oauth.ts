import type { OutlookConfig } from "../core/config.js";
import { EmailMcpError } from "../core/errors.js";
import { openBrowser } from "../core/browser.js";
import { readToken, writeToken } from "../core/tokens.js";

/** 端点运行时读取环境变量（便于测试注入 mock） */
export function microsoftTokenUrl(tenant: string): string {
  return (
    process.env.EMAIL_MCP_MS_TOKEN_URL ||
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`
  );
}

export function microsoftDeviceCodeUrl(tenant: string): string {
  return (
    process.env.EMAIL_MCP_MS_DEVICECODE_URL ||
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/devicecode`
  );
}

export function graphApiBase(): string {
  return process.env.EMAIL_MCP_GRAPH_API_BASE || "https://graph.microsoft.com";
}

export interface TokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  scope?: string;
}

async function tokenRequest(cfg: OutlookConfig, params: URLSearchParams, action: string): Promise<TokenResponse> {
  const res = await fetch(microsoftTokenUrl(cfg.tenant), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const desc = String(data.error_description || data.error || res.status);
    throw new EmailMcpError(
      `${action}失败: ${desc}`,
      /invalid_grant|invalid_client/.test(desc)
        ? "凭据或授权已失效，请重新运行 email-mcp setup outlook"
        : "请检查 client_id/tenant 是否正确"
    );
  }
  return {
    accessToken: String(data.access_token ?? ""),
    refreshToken: data.refresh_token ? String(data.refresh_token) : undefined,
    expiresIn: typeof data.expires_in === "number" ? data.expires_in : undefined,
    scope: data.scope ? String(data.scope) : undefined,
  };
}

export interface DeviceCodeSession {
  userCode: string;
  verificationUri: string;
  message: string;
  waitForCompletion: (timeoutMs: number) => Promise<TokenResponse>;
}

/** 发起 device code 授权，返回一次性会话（含轮询等待） */
export async function startDeviceCodeAuth(cfg: OutlookConfig): Promise<DeviceCodeSession> {
  const res = await fetch(microsoftDeviceCodeUrl(cfg.tenant), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: cfg.clientId, scope: cfg.scopes.join(" ") }),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new EmailMcpError(
      `获取设备码失败: ${data.error_description ?? data.error ?? res.status}`,
      "请检查 client_id 与租户配置（个人账号用 common）"
    );
  }
  const deviceCode = String(data.device_code ?? "");
  const userCode = String(data.user_code ?? "");
  const verificationUri = String(data.verification_uri ?? "https://microsoft.com/devicelogin");
  const expiresIn = Number(data.expires_in ?? 900);
  let intervalMs = Number(data.interval ?? 5) * 1000;
  if (!deviceCode || !userCode) {
    throw new EmailMcpError("设备码响应缺少 device_code/user_code");
  }

  let stopped = false;
  const waitForCompletion = (timeoutMs: number): Promise<TokenResponse> =>
    new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const tick = async (): Promise<void> => {
        if (stopped) return;
        if (Date.now() > deadline) {
          reject(new EmailMcpError("设备码授权超时（15 分钟）", "请重新运行 email-mcp setup outlook"));
          return;
        }
        try {
          const res = await fetch(microsoftTokenUrl(cfg.tenant), {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              client_id: cfg.clientId,
              grant_type: "urn:ietf:params:oauth:grant-type:device_code",
              device_code: deviceCode,
            }),
          });
          const data = (await res.json()) as Record<string, unknown>;
          const err = String(data.error ?? "");
          if (err === "authorization_pending") {
            setTimeout(() => void tick(), intervalMs);
          } else if (err === "slow_down") {
            intervalMs += 5000; // 协议要求：slow_down 后间隔 +5s
            setTimeout(() => void tick(), intervalMs);
          } else if (err === "expired_token") {
            reject(new EmailMcpError("设备码已过期", "请重新运行 email-mcp setup outlook"));
          } else if (err === "access_denied") {
            reject(new EmailMcpError("用户在浏览器中拒绝了授权"));
          } else if (!res.ok) {
            reject(new EmailMcpError(`授权轮询失败: ${data.error_description ?? err ?? res.status}`));
          } else {
            resolve({
              accessToken: String(data.access_token ?? ""),
              refreshToken: data.refresh_token ? String(data.refresh_token) : undefined,
              expiresIn: typeof data.expires_in === "number" ? data.expires_in : undefined,
              scope: data.scope ? String(data.scope) : undefined,
            });
          }
        } catch (e) {
          reject(e instanceof EmailMcpError ? e : new EmailMcpError("授权轮询网络错误", "请检查网络后重试"));
        }
      };
      void tick();
    });

  return { userCode, verificationUri, message: String(data.message ?? ""), waitForCompletion };
}

/** 用 refresh_token 刷新 access_token */
export async function refreshAccessToken(cfg: OutlookConfig, refreshToken: string): Promise<TokenResponse> {
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: cfg.scopes.join(" "),
  });
  return tokenRequest(cfg, params, "token 刷新");
}

/**
 * 完整授权流程：device code → 终端显示链接与代码 → 轮询等待用户完成 → token 落盘。
 */
export async function authorizeOutlook(cfg: OutlookConfig): Promise<void> {
  const session = await startDeviceCodeAuth(cfg);
  console.log(`\n1) 打开网址: ${session.verificationUri}`);
  console.log(`2) 输入代码: ${session.userCode}`);
  console.log("3) 用你的 Outlook 账号登录并同意权限（可在手机浏览器完成）\n");
  openBrowser(session.verificationUri);

  const tok = await session.waitForCompletion(15 * 60_000);
  if (!tok.refreshToken) {
    throw new EmailMcpError(
      "未获取到 refresh_token（offline_access 未生效）",
      "请确认应用注册的账户类型包含个人账号，或重新运行 setup"
    );
  }
  writeToken("outlook", {
    accessToken: tok.accessToken,
    refreshToken: tok.refreshToken,
    expiresAt: tok.expiresIn ? Date.now() + tok.expiresIn * 1000 : undefined,
    scope: tok.scope,
  });
}

/** setup 时调用：已有有效 refresh token 则跳过授权 */
export function needsOutlookAuthorization(): boolean {
  const rec = readToken("outlook");
  return !(rec?.accessToken && rec.refreshToken);
}
