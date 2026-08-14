import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { GmailConfig } from "../core/config.js";
import { EmailMcpError } from "../core/errors.js";
import { logger } from "../core/logger.js";
import { readToken, writeToken } from "../core/tokens.js";
import { openBrowser } from "../core/browser.js";

/** 端点运行时读取环境变量（便于测试注入 mock，也允许运行时调整） */
export function gmailAuthUrl(): string {
  return process.env.EMAIL_MCP_OAUTH_AUTH_URL || "https://accounts.google.com/o/oauth2/v2/auth";
}

export function gmailTokenUrl(): string {
  return process.env.EMAIL_MCP_OAUTH_TOKEN_URL || "https://oauth2.googleapis.com/token";
}

export function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64url");
}

/** 生成 PKCE verifier + S256 challenge */
export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64UrlEncode(randomBytes(32));
  const challenge = base64UrlEncode(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function redirectUriFor(port: number): string {
  return `http://localhost:${port}/callback`;
}

export function buildAuthUrl(
  cfg: GmailConfig,
  redirectUri: string,
  scopes: string[],
  challenge: string,
  state: string
): string {
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scopes.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
    state,
  });
  if (cfg.clientSecret) params.set("client_secret", cfg.clientSecret);
  return `${gmailAuthUrl()}?${params.toString()}`;
}

export interface CallbackServer {
  redirectUri: string;
  waitForCode: (timeoutMs: number) => Promise<string>;
  close: () => void;
}

/** 本地回调服务器：接收 /callback?code=... */
export function startCallbackServer(port: number): CallbackServer {
  let resolveCode: (code: string) => void = () => {};
  let rejectCode: (err: Error) => void = () => {};
  const promise = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });
  let timer: NodeJS.Timeout | undefined;

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      if (error) {
        res.end(`<h3>授权失败：${error}</h3><p>可以关闭此页面，回到终端重试。</p>`);
        rejectCode(new EmailMcpError(`授权失败: ${error}`, "请重新运行 email-mcp setup gmail"));
      } else if (code) {
        res.end("<h3>✅ 授权成功！可以关闭此页面，回到终端继续。</h3>");
        resolveCode(code);
      } else {
        res.writeHead(400);
        res.end("missing code");
      }
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    }
  });
  server.listen(port, "127.0.0.1");

  return {
    redirectUri: redirectUriFor(port),
    waitForCode: (timeoutMs) => {
      timer = setTimeout(
        () => rejectCode(new EmailMcpError("等待授权超时（5 分钟）", "请重新运行 email-mcp setup gmail")),
        timeoutMs
      );
      return promise;
    },
    close: () => {
      clearTimeout(timer);
      server.close();
    },
  };
}

export interface TokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  scope?: string;
}

async function tokenRequest(cfg: GmailConfig, params: URLSearchParams, action: string): Promise<TokenResponse> {
  const res = await fetch(gmailTokenUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const desc = String(data.error_description || data.error || res.status);
    throw new EmailMcpError(
      `${action}失败: ${desc}`,
      /invalid_grant/.test(desc)
        ? "凭据或授权已失效，请重新运行 email-mcp setup gmail"
        : "请检查 client_id/client_secret 是否正确"
    );
  }
  return {
    accessToken: String(data.access_token),
    refreshToken: data.refresh_token ? String(data.refresh_token) : undefined,
    expiresIn: typeof data.expires_in === "number" ? data.expires_in : undefined,
    scope: data.scope ? String(data.scope) : undefined,
  };
}

/** 用授权码交换 token */
export async function exchangeCode(
  cfg: GmailConfig,
  code: string,
  verifier: string,
  redirectUri: string
): Promise<TokenResponse> {
  const params = new URLSearchParams({
    code,
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    grant_type: "authorization_code",
  });
  if (cfg.clientSecret) params.set("client_secret", cfg.clientSecret);
  return tokenRequest(cfg, params, "token 交换");
}

/** 用 refresh_token 刷新 access_token */
export async function refreshAccessToken(cfg: GmailConfig, refreshToken: string): Promise<TokenResponse> {
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  if (cfg.clientSecret) params.set("client_secret", cfg.clientSecret);
  return tokenRequest(cfg, params, "token 刷新");
}

/**
 * 完整授权流程：PKCE → 开回调服务器 → 打开浏览器 → 等 code → 换 token → 落盘。
 * （授权后的账号校验由调用方通过 GmailApiClient.getProfile() 完成）
 */
export async function authorizeGmail(cfg: GmailConfig): Promise<void> {
  const { verifier, challenge } = generatePkce();
  const cb = startCallbackServer(cfg.callbackPort);
  const state = base64UrlEncode(randomBytes(16));
  const authUrl = buildAuthUrl(cfg, cb.redirectUri, cfg.scopes, challenge, state);

  console.log(`\n请在浏览器中完成 Google 授权（如未自动打开，请手动访问）：\n\n  ${authUrl}\n`);
  openBrowser(authUrl);

  const code = await cb.waitForCode(5 * 60_000);
  const redirectUri = cb.redirectUri;
  cb.close();

  const tok = await exchangeCode(cfg, code, verifier, redirectUri);
  if (!tok.refreshToken) {
    throw new EmailMcpError(
      "未获取到 refresh_token（offline 授权未生效）",
      "若 Google 侧已存在旧授权，请到 https://myaccount.google.com/permissions 撤销后重试"
    );
  }
  writeToken("gmail", {
    accessToken: tok.accessToken,
    refreshToken: tok.refreshToken,
    expiresAt: tok.expiresIn ? Date.now() + tok.expiresIn * 1000 : undefined,
    scope: tok.scope,
  });
}

/** setup 时调用：已有有效 refresh token 则跳过授权 */
export function needsGmailAuthorization(): boolean {
  const rec = readToken("gmail");
  return !(rec?.accessToken && rec.refreshToken);
}
