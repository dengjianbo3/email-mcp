import type { OutlookConfig } from "../core/config.js";
import { EmailMcpError } from "../core/errors.js";
import { logger } from "../core/logger.js";
import { readToken, writeToken } from "../core/tokens.js";
import { graphApiBase, refreshAccessToken } from "./oauth.js";

export interface OutlookProfile {
  displayName?: string;
  mail?: string;
  userPrincipalName?: string;
}

export interface OutlookMessageSummary {
  id: string;
  subject?: string;
  from?: string;
  to?: string;
  receivedDateTime?: string;
  hasAttachments?: boolean;
  isRead?: boolean;
  importance?: string;
}

export interface OutlookAttachmentMeta {
  id?: string;
  name: string;
  contentType?: string;
  size?: number;
  isInline?: boolean;
}

export interface OutlookMessageDetail {
  id: string;
  subject?: string;
  from?: string;
  to?: string[];
  receivedDateTime?: string;
  body?: { contentType?: string; content?: string };
  attachments: OutlookAttachmentMeta[];
}

interface GraphMessage {
  id?: string;
  subject?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  toRecipients?: { emailAddress?: { name?: string; address?: string } }[];
  receivedDateTime?: string;
  hasAttachments?: boolean;
  isRead?: boolean;
  importance?: string;
  body?: { contentType?: string; content?: string };
  attachments?: {
    "@odata.type"?: string;
    id?: string;
    name?: string;
    contentType?: string;
    size?: number;
    isInline?: boolean;
    contentBytes?: string;
  }[];
}

interface GraphListResponse {
  value?: GraphMessage[];
  "@odata.nextLink"?: string;
}

let refreshLock: Promise<string> | null = null;

export class GraphApiClient {
  constructor(private cfg: OutlookConfig) {}

  private async getAccessToken(): Promise<string> {
    const tok = readToken("outlook");
    if (!tok?.accessToken) {
      throw new EmailMcpError("outlook 未授权", "运行 email-mcp setup outlook 完成授权");
    }
    if (tok.expiresAt && tok.expiresAt > Date.now() + 60_000) return tok.accessToken;
    if (!tok.refreshToken) {
      throw new EmailMcpError("缺少 refresh_token，无法刷新", "重新运行 email-mcp setup outlook");
    }
    if (!refreshLock) {
      refreshLock = (async () => {
        try {
          const fresh = await refreshAccessToken(this.cfg, tok.refreshToken!);
          writeToken("outlook", {
            accessToken: fresh.accessToken,
            refreshToken: fresh.refreshToken ?? tok.refreshToken,
            expiresAt: fresh.expiresIn ? Date.now() + fresh.expiresIn * 1000 : undefined,
            scope: fresh.scope ?? tok.scope,
            account: tok.account,
          });
          logger.debug("outlook access token 已刷新");
          return fresh.accessToken;
        } finally {
          refreshLock = null;
        }
      })();
    }
    return refreshLock;
  }

  private async request<T>(path: string, retried = false): Promise<T> {
    return this.doRequest<T>(path, {}, retried);
  }

  private async doRequest<T>(
    path: string,
    opts: { method?: string; body?: unknown } = {},
    retried = false
  ): Promise<T> {
    const token = await this.getAccessToken();
    const url = graphApiBase() + path;
    let res: Response;
    try {
      res = await fetch(url, {
        method: opts.method ?? "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch {
      throw new EmailMcpError("无法连接 Microsoft Graph（网络问题）", "请检查网络后重试");
    }

    if (res.status === 401 && !retried) {
      logger.debug("收到 401，强制刷新 token 后重试");
      const cur = readToken("outlook");
      if (cur) writeToken("outlook", { ...cur, expiresAt: 0 });
      return this.doRequest<T>(path, opts, true);
    }

    if (!res.ok) {
      throw await this.mapError(res);
    }
    if (res.status === 204 || res.status === 202) return {} as T;
    return (await res.json()) as T;
  }

  private async mapError(res: Response): Promise<EmailMcpError> {
    let message = `Microsoft Graph 错误 ${res.status}`;
    let hint: string | undefined;
    try {
      const body = (await res.json()) as {
        error?: { message?: string; code?: string };
      };
      if (body.error?.message) message = `${body.error.code ?? ""} ${body.error.message}`.trim();
      const code = body.error?.code ?? "";
      if (code.includes("RequestDenied") || code.includes("AccessDenied")) {
        hint = "权限不足，请重新运行 email-mcp setup outlook 并授予所需权限";
      }
    } catch {
      /* 非 JSON 错误体 */
    }
    if (res.status === 401) {
      hint = "授权已失效，请重新运行 email-mcp setup outlook";
    } else if (res.status === 404) {
      hint = "消息或资源不存在";
    } else if (res.status === 429) {
      const retryAfter = res.headers.get("Retry-After");
      hint = retryAfter ? `触发限流，请约 ${retryAfter} 秒后重试` : "触发限流，请稍后重试";
    }
    return new EmailMcpError(message, hint);
  }

  async getProfile(): Promise<OutlookProfile> {
    const p = await this.request<OutlookProfile>("/v1.0/me?$select=displayName,mail,userPrincipalName");
    return p;
  }

  async listMessages(
    search: string,
    top: number,
    skip: number,
    nextLink?: string
  ): Promise<{ messages: OutlookMessageSummary[]; nextLink?: string }> {
    const select = "id,subject,from,toRecipients,receivedDateTime,hasAttachments,isRead,importance";
    const path = nextLink
      ? nextLink.replace(graphApiBase(), "")
      : `/v1.0/me/messages?\$select=${encodeURIComponent(select)}&\$top=${top}&\$skip=${skip}${
          search ? `&\$search=${encodeURIComponent(search)}` : ""
        }`;
    const raw = await this.request<GraphListResponse>(path);
    const messages = (raw.value ?? []).map((m) => ({
      id: m.id ?? "",
      subject: m.subject,
      from: fmtAddress(m.from?.emailAddress),
      to: fmtAddress(m.toRecipients?.[0]?.emailAddress),
      receivedDateTime: m.receivedDateTime,
      hasAttachments: m.hasAttachments,
      isRead: m.isRead,
      importance: m.importance,
    }));
    return { messages, nextLink: raw["@odata.nextLink"] };
  }

  async getMessage(id: string): Promise<OutlookMessageDetail> {
    const raw = await this.request<GraphMessage>(
      `/v1.0/me/messages/${encodeURIComponent(id)}?\$select=id,subject,from,toRecipients,receivedDateTime,body&\$expand=attachments`
    );
    return {
      id: raw.id ?? id,
      subject: raw.subject,
      from: fmtAddress(raw.from?.emailAddress),
      to: (raw.toRecipients ?? []).map((r) => r.emailAddress?.address ?? "").filter(Boolean),
      receivedDateTime: raw.receivedDateTime,
      body: raw.body
        ? { contentType: raw.body.contentType, content: raw.body.content }
        : undefined,
      attachments: (raw.attachments ?? [])
        .filter((a) => a["@odata.type"]?.includes("fileAttachment") || a["@odata.type"]?.includes("itemAttachment"))
        .map((a) => ({
          id: a.id,
          name: a.name ?? "(unnamed)",
          contentType: a.contentType,
          size: a.size,
          isInline: a.isInline,
        })),
    };
  }

  async getAttachment(
    messageId: string,
    attachmentId: string
  ): Promise<{ attachmentId: string; name: string; contentType?: string; size?: number; contentBase64?: string }> {
    const raw = await this.request<{
      id?: string;
      name?: string;
      contentType?: string;
      size?: number;
      contentBytes?: string;
    }>(`/v1.0/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`);
    return {
      attachmentId: raw.id ?? attachmentId,
      name: raw.name ?? "attachment",
      contentType: raw.contentType,
      size: raw.size,
      contentBase64: raw.contentBytes,
    };
  }

  // ---------- M3 读写 ----------

  async sendMail(opts: {
    to: string[];
    subject: string;
    body: string;
    cc?: string[];
    bcc?: string[];
    attachments?: SendAttachment[];
  }): Promise<{ id?: string }> {
    const message = buildGraphMessage(opts, false);
    return this.doRequest<{ id?: string }>("/v1.0/me/sendMail", {
      method: "POST",
      body: { message, saveToSentItems: true },
    });
  }

  async replyMessage(messageId: string, body: string): Promise<{ id?: string }> {
    return this.doRequest<{ id?: string }>(`/v1.0/me/messages/${encodeURIComponent(messageId)}/reply`, {
      method: "POST",
      body: { message: { body: { contentType: "text", content: body } } },
    });
  }

  async createDraft(opts: {
    to: string[];
    subject: string;
    body: string;
    cc?: string[];
    bcc?: string[];
    attachments?: SendAttachment[];
  }): Promise<{ id: string }> {
    const message = buildGraphMessage(opts, true);
    return this.doRequest<{ id: string }>("/v1.0/me/messages", { method: "POST", body: message });
  }

  async sendDraft(messageId: string): Promise<{ id?: string }> {
    return this.doRequest<{ id?: string }>(`/v1.0/me/messages/${encodeURIComponent(messageId)}/send`, {
      method: "POST",
    });
  }

  async modifyMessage(
    messageId: string,
    actions: { markRead?: boolean; categories?: string[] }
  ): Promise<{ id?: string }> {
    const patch: Record<string, unknown> = {};
    if (actions.markRead !== undefined) patch.isRead = actions.markRead;
    if (actions.categories !== undefined) patch.categories = actions.categories;
    return this.doRequest<{ id?: string }>(`/v1.0/me/messages/${encodeURIComponent(messageId)}`, {
      method: "PATCH",
      body: patch,
    });
  }

  async moveMessage(messageId: string, folderId: string): Promise<{ id?: string }> {
    return this.doRequest<{ id?: string }>(`/v1.0/me/messages/${encodeURIComponent(messageId)}/move`, {
      method: "POST",
      body: { destinationId: folderId },
    });
  }

  async listFolders(): Promise<{ id: string; displayName: string; totalItemCount?: number; unreadItemCount?: number }[]> {
    const raw = await this.request<{ value?: { id?: string; displayName?: string; totalItemCount?: number; unreadItemCount?: number }[] }>(
      "/v1.0/me/mailFolders?$select=id,displayName,totalItemCount,unreadItemCount"
    );
    return (raw.value ?? [])
      .filter((f) => f.id && f.displayName)
      .map((f) => ({ id: f.id!, displayName: f.displayName!, totalItemCount: f.totalItemCount, unreadItemCount: f.unreadItemCount }));
  }

  async deleteMessage(messageId: string): Promise<void> {
    await this.doRequest<unknown>(`/v1.0/me/messages/${encodeURIComponent(messageId)}`, { method: "DELETE" });
  }
}

export interface SendAttachment {
  filename: string;
  mimeType: string;
  /** 标准 base64 编码的文件内容 */
  dataBase64: string;
}

function buildGraphMessage(
  opts: { to: string[]; subject: string; body: string; cc?: string[]; bcc?: string[]; attachments?: SendAttachment[] },
  isDraft: boolean
): Record<string, unknown> {
  const recipients = (list: string[]) =>
    list.map((address) => ({ emailAddress: { address } }));
  const message: Record<string, unknown> = {
    subject: opts.subject,
    body: { contentType: "text", content: opts.body },
    toRecipients: recipients(opts.to),
  };
  if (opts.cc?.length) message.ccRecipients = recipients(opts.cc);
  if (opts.bcc?.length) message.bccRecipients = recipients(opts.bcc);
  if (isDraft) message.isDraft = true;
  if (opts.attachments?.length) {
    message.attachments = opts.attachments.map((a) => ({
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: a.filename,
      contentType: a.mimeType,
      contentBytes: a.dataBase64,
    }));
  }
  return message;
}

function fmtAddress(addr?: { name?: string; address?: string }): string | undefined {
  if (!addr?.address) return undefined;
  return addr.name && addr.name !== addr.address ? `${addr.name} <${addr.address}>` : addr.address;
}
