import { randomBytes } from "node:crypto";
import { netFetch, ensureProxyEnv } from "../core/net.js";
ensureProxyEnv(); // 必须在任何 fetch 之前启用环境代理（Google/Microsoft 端点）
import type { GmailConfig } from "../core/config.js";
import { EmailMcpError } from "../core/errors.js";
import { logger } from "../core/logger.js";
import { readToken, writeToken } from "../core/tokens.js";
import { refreshAccessToken } from "./oauth.js";

/** Gmail REST API 基地址（运行时读取环境变量，便于测试 mock） */
export function gmailApiBase(): string {
  return process.env.EMAIL_MCP_GMAIL_API_BASE || "https://gmail.googleapis.com";
}

export interface GmailProfile {
  emailAddress: string;
  messagesTotal: number;
  threadsTotal: number;
  historyId: string;
}

export interface GmailMessageSummary {
  id: string;
  threadId: string;
  from?: string;
  subject?: string;
  date?: string;
  snippet?: string;
}

export interface GmailAttachmentMeta {
  attachmentId?: string;
  filename: string;
  mimeType: string;
  size?: number;
  inline: boolean;
}

export interface GmailMessageDetail {
  id: string;
  threadId: string;
  snippet?: string;
  headers: Record<string, string>;
  bodyText?: string;
  bodyHtml?: string;
  attachments: GmailAttachmentMeta[];
}

interface GmailListResponse {
  messages?: { id: string; threadId?: string }[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

let refreshLock: Promise<string> | null = null;

export class GmailApiClient {
  constructor(private cfg: GmailConfig) {}

  private async getAccessToken(): Promise<string> {
    const tok = readToken("gmail");
    if (!tok?.accessToken) {
      throw new EmailMcpError("gmail 未授权", "运行 email-mcp setup gmail 完成授权");
    }
    if (tok.expiresAt && tok.expiresAt > Date.now() + 60_000) return tok.accessToken;
    if (!tok.refreshToken) {
      throw new EmailMcpError("缺少 refresh_token，无法刷新", "重新运行 email-mcp setup gmail");
    }
    if (!refreshLock) {
      refreshLock = (async () => {
        try {
          const fresh = await refreshAccessToken(this.cfg, tok.refreshToken!);
          writeToken("gmail", {
            accessToken: fresh.accessToken,
            refreshToken: fresh.refreshToken ?? tok.refreshToken,
            expiresAt: fresh.expiresIn ? Date.now() + fresh.expiresIn * 1000 : undefined,
            scope: fresh.scope ?? tok.scope,
            account: tok.account,
          });
          logger.debug("gmail access token 已刷新");
          return fresh.accessToken;
        } finally {
          refreshLock = null;
        }
      })();
    }
    return refreshLock;
  }

  private async request<T>(
    path: string,
    params: Record<string, string | string[]> = {},
    retried = false
  ): Promise<T> {
    return this.doRequest<T>(path, { params }, retried);
  }

  private async doRequest<T>(
    path: string,
    opts: { params?: Record<string, string | string[]>; method?: string; body?: unknown } = {},
    retried = false
  ): Promise<T> {
    const token = await this.getAccessToken();
    const url = new URL(gmailApiBase() + path);
    for (const [k, v] of Object.entries(opts.params ?? {})) {
      // 数组值 → 重复 query 参数（Gmail 的 metadataHeaders 不接受逗号分隔）
      if (Array.isArray(v)) {
        for (const item of v) if (item) url.searchParams.append(k, item);
      } else if (v) {
        url.searchParams.set(k, v);
      }
    }

    let res: Response;
    try {
      res = await netFetch(url, {
        method: opts.method ?? "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch {
      throw new EmailMcpError("无法连接 Gmail API（网络问题）", "请检查网络后重试");
    }

    if (res.status === 401 && !retried) {
      logger.debug("收到 401，强制刷新 token 后重试");
      const cur = readToken("gmail");
      if (cur) writeToken("gmail", { ...cur, expiresAt: 0 });
      return this.doRequest<T>(path, opts, true);
    }

    if (!res.ok) {
      throw this.mapError(res);
    }
    if (res.status === 204) return {} as T;
    return (await res.json()) as T;
  }

  private async mapError(res: Response): Promise<EmailMcpError> {
    let message = `Gmail API 错误 ${res.status}`;
    let hint: string | undefined;
    try {
      const body = (await res.json()) as { error?: { message?: string; code?: number } };
      if (body.error?.message) message = body.error.message;
    } catch {
      /* 非 JSON 错误体 */
    }
    if (res.status === 401) {
      hint = "授权已失效，请重新运行 email-mcp setup gmail";
    } else if (res.status === 403 && /scopes?/i.test(message)) {
      hint = "权限不足，请运行 email-mcp setup gmail 并授予所需权限";
    } else if (res.status === 404) {
      hint = "消息或资源不存在";
    } else if (res.status === 429) {
      hint = "触发限流，请稍后重试";
    }
    return new EmailMcpError(message, hint);
  }

  async getProfile(): Promise<GmailProfile> {
    const p = await this.request<GmailProfile>("/gmail/v1/users/me/profile");
    return p;
  }

  async listMessages(query: string, maxResults: number, pageToken?: string): Promise<GmailListResponse> {
    return this.request<GmailListResponse>("/gmail/v1/users/me/messages", {
      q: query,
      maxResults: String(maxResults),
      pageToken: pageToken ?? "",
    });
  }

  async getMessage(id: string, format: string, metadataHeaders?: string[]): Promise<GmailMessageDetail> {
    // Gmail API 的 format 枚举必须大写（FULL/METADATA/MINIMAL），小写会被忽略
    const formatUpper = (format ?? "full").toUpperCase();
    const raw = await this.request<{
      id: string;
      threadId: string;
      snippet?: string;
      payload?: PayloadPart;
    }>("/gmail/v1/users/me/messages/" + id, {
      format: formatUpper,
      metadataHeaders: metadataHeaders ?? [],
    });
    const headers: Record<string, string> = {};
    for (const h of raw.payload?.headers ?? []) {
      if (!(h.name.toLowerCase() in headers)) headers[h.name.toLowerCase()] = h.value;
    }
    const parsed = parsePayload(raw.payload);
    return {
      id: raw.id,
      threadId: raw.threadId,
      snippet: raw.snippet,
      headers,
      bodyText: parsed.bodyText,
      bodyHtml: parsed.bodyHtml,
      attachments: parsed.attachments,
    };
  }

  async getAttachment(messageId: string, attachmentId: string): Promise<{
    attachmentId: string;
    mimeType: string;
    filename: string;
    size: number;
    dataBase64Url: string;
  }> {
    const raw = await this.request<{
      attachmentId?: string;
      mimeType?: string;
      filename?: string;
      size?: number;
      data?: string;
    }>(`/gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}`);
    return {
      attachmentId: raw.attachmentId ?? attachmentId,
      mimeType: raw.mimeType ?? "application/octet-stream",
      filename: raw.filename ?? "attachment",
      size: raw.size ?? 0,
      dataBase64Url: raw.data ?? "",
    };
  }

  // ---------- M3 读写 ----------

  async sendMessage(opts: {
    to: string[];
    subject: string;
    body: string;
    cc?: string[];
    bcc?: string[];
    attachments?: SendAttachment[];
    threadId?: string;
    inReplyTo?: string;
    references?: string;
  }): Promise<{ id: string; threadId?: string }> {
    const raw = buildRfc822(opts);
    const body: Record<string, unknown> = { raw };
    if (opts.threadId) body.threadId = opts.threadId;
    return this.doRequest<{ id: string; threadId?: string }>(
      "/gmail/v1/users/me/messages/send",
      { method: "POST", body }
    );
  }

  async replyMessage(messageId: string, bodyText: string, attachments?: SendAttachment[]): Promise<{ id: string; threadId?: string }> {
    const meta = await this.getMessage(messageId, "metadata", ["From", "Subject", "Date", "Message-ID", "References"]);
    const quote = quoteOriginal(meta);
    const full = bodyText + (quote ? "\n\n" + quote : "");
    return this.sendMessage({
      to: [stripName(meta.headers.from ?? "")].filter(Boolean),
      subject: (meta.headers.subject ?? "").replace(/^(?:(?:Re|Fwd?|回复)\s*:\s*)+/i, "") ? `Re: ${(meta.headers.subject ?? "").replace(/^(?:(?:Re|Fwd?|回复)\s*:\s*)+/i, "")}` : `Re: ${meta.headers.subject ?? ""}`,
      body: full,
      attachments,
      threadId: meta.threadId,
      inReplyTo: meta.headers["message-id"],
      references: meta.headers.references,
    });
  }

  async createDraft(opts: {
    to: string[];
    subject: string;
    body: string;
    cc?: string[];
    bcc?: string[];
    attachments?: SendAttachment[];
  }): Promise<{ draftId: string; messageId: string }> {
    const raw = buildRfc822(opts);
    const r = await this.doRequest<{ id: string; message?: { id?: string } }>(
      "/gmail/v1/users/me/drafts",
      { method: "POST", body: { message: { raw } } }
    );
    return { draftId: r.id, messageId: r.message?.id ?? "" };
  }

  async sendDraft(draftId: string): Promise<{ id: string; threadId?: string }> {
    return this.doRequest<{ id: string; threadId?: string }>(
      "/gmail/v1/users/me/drafts/send",
      { method: "POST", body: { id: draftId } }
    );
  }

  async modifyMessage(
    messageId: string,
    actions: { markRead?: boolean; archive?: boolean; trash?: boolean; addLabels?: string[]; removeLabels?: string[] }
  ): Promise<{ id: string; labelIds?: string[] }> {
    const addLabelIds = [...(actions.addLabels ?? [])];
    const removeLabelIds = [...(actions.removeLabels ?? [])];
    if (actions.markRead === true) removeLabelIds.push("UNREAD");
    if (actions.markRead === false) addLabelIds.push("UNREAD");
    if (actions.archive === true) removeLabelIds.push("INBOX");
    if (actions.trash === true) addLabelIds.push("TRASH");
    return this.doRequest<{ id: string; labelIds?: string[] }>(
      `/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/modify`,
      { method: "POST", body: { addLabelIds, removeLabelIds } }
    );
  }

  async listLabels(): Promise<{ id: string; name: string; type?: string; messagesTotal?: number; threadsTotal?: number }[]> {
    const r = await this.request<{ labels?: { id: string; name: string; type?: string; messagesTotal?: number; threadsTotal?: number }[] }>(
      "/gmail/v1/users/me/labels"
    );
    return r.labels ?? [];
  }

  async createLabel(name: string): Promise<{ id: string; name: string }> {
    return this.doRequest<{ id: string; name: string }>("/gmail/v1/users/me/labels", {
      method: "POST",
      body: { name, labelListVisibility: "labelShow", messageListVisibility: "show" },
    });
  }

  async deleteLabel(labelId: string): Promise<void> {
    await this.doRequest<unknown>(`/gmail/v1/users/me/labels/${encodeURIComponent(labelId)}`, {
      method: "DELETE",
    });
  }
}

export interface SendAttachment {
  filename: string;
  mimeType: string;
  /** 标准 base64 编码的文件内容 */
  dataBase64: string;
}

/** RFC2047 编码非 ASCII 头字段（中文主题/收件人） */
function encodeHeaderWord(s: string): string {
  if (/^[\x20-\x7e\t]*$/.test(s)) return s;
  return "=?UTF-8?B?" + Buffer.from(s, "utf8").toString("base64") + "?=";
}

/** 构造 RFC822 邮件（multipart/mixed + base64），返回 base64url 编码 */
export function buildRfc822(opts: {
  to: string[];
  subject: string;
  body: string;
  cc?: string[];
  bcc?: string[];
  attachments?: SendAttachment[];
  inReplyTo?: string;
  references?: string;
}): string {
  const boundary = "emailmcp_" + randomBytes(12).toString("hex");
  const lines: string[] = [
    `To: ${opts.to.map(encodeHeaderWord).join(", ")}`,
  ];
  if (opts.cc?.length) lines.push(`Cc: ${opts.cc.map(encodeHeaderWord).join(", ")}`);
  if (opts.bcc?.length) lines.push(`Bcc: ${opts.bcc.map(encodeHeaderWord).join(", ")}`);
  lines.push(`Subject: ${encodeHeaderWord(opts.subject)}`);
  if (opts.inReplyTo) lines.push(`In-Reply-To: ${opts.inReplyTo}`);
  if (opts.references) lines.push(`References: ${opts.references}`);
  lines.push("MIME-Version: 1.0");
  lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  lines.push(`Date: ${new Date().toUTCString()}`);
  lines.push("");

  const attachParts = (opts.attachments ?? []).map((a) => {
    const safeName = String(a.filename).replace(/["\\\r\n]/g, "_");
    return [
      `--${boundary}`,
      `Content-Type: ${a.mimeType}; name="${safeName}"`,
      `Content-Disposition: attachment; filename="${safeName}"`,
      "Content-Transfer-Encoding: base64",
      "",
      a.dataBase64,
      "",
    ].join("\r\n");
  });

  const body =
    lines.join("\r\n") +
    `\r\n--${boundary}\r\n` +
    "Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n" +
    Buffer.from(opts.body, "utf8").toString("base64") +
    "\r\n" +
    attachParts.join("\r\n") +
    `\r\n--${boundary}--\r\n`;

  return Buffer.from(body, "utf8").toString("base64url");
}

/** 生成引用原文（供回复正文追加） */
function quoteOriginal(meta: { headers: Record<string, string>; snippet?: string }): string {
  const from = meta.headers.from ?? "";
  const date = meta.headers.date ?? "";
  const snippet = meta.snippet ?? "";
  const who = from ? (stripName(from) || from) : "对方";
  const when = date ? `${date}` : "之前";
  const quoted = snippet.split(/\r?\n/).map((l) => "> " + l).join("\n");
  return `On ${when}, ${who} wrote:\n${quoted}`;
}

function stripName(addr: string): string {
  const m = /<([^>]+)>/.exec(addr);
  return m ? m[1]! : addr.trim();
}

interface PayloadPart {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; size?: number; attachmentId?: string };
  headers?: { name: string; value: string }[];
  parts?: PayloadPart[];
}

function decodeBase64Url(s: string): string {
  return Buffer.from(s, "base64url").toString("utf8");
}

/** 递归解析 payload：收集 text/plain、text/html 与附件元数据 */
function parsePayload(payload?: PayloadPart): {
  bodyText?: string;
  bodyHtml?: string;
  attachments: GmailAttachmentMeta[];
} {
  const texts: string[] = [];
  const htmls: string[] = [];
  const attachments: GmailAttachmentMeta[] = [];

  const walk = (part: PayloadPart | undefined) => {
    if (!part) return;
    const isInline = (part.headers ?? []).some((h) => h.name.toLowerCase() === "content-id");
    if (part.mimeType === "text/plain" && part.body?.data) {
      texts.push(decodeBase64Url(part.body.data));
    } else if (part.mimeType === "text/html" && part.body?.data) {
      htmls.push(decodeBase64Url(part.body.data));
    } else if (part.filename || part.body?.attachmentId) {
      attachments.push({
        attachmentId: part.body?.attachmentId,
        filename: part.filename || "(unnamed)",
        mimeType: part.mimeType ?? "application/octet-stream",
        size: part.body?.size,
        inline: isInline,
      });
    }
    for (const sub of part.parts ?? []) walk(sub);
  };
  walk(payload);

  return {
    bodyText: texts.length > 0 ? texts.join("\n\n") : undefined,
    bodyHtml: htmls.length > 0 ? htmls.join("\n\n") : undefined,
    attachments,
  };
}
