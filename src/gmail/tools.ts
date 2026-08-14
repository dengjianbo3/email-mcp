import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GmailApiClient, GmailMessageDetail, GmailMessageSummary } from "./client.js";
import { fail, ok, registerSensitiveTool, type ToolResult } from "../core/toolkit.js";

// ---------- 纯业务函数（可独立测试） ----------

export interface SearchArgs {
  query?: string;
  maxResults?: number;
  pageToken?: string;
}

export async function handleSearch(client: GmailApiClient, args: SearchArgs) {
  const page = await client.listMessages(args.query ?? "", args.maxResults ?? 20, args.pageToken);
  const ids = (page.messages ?? []).map((m) => m.id).filter(Boolean) as string[];
  // 并发拉取元数据（主题/发件人/时间），失败项降级为 null
  const CONCURRENCY = 5;
  const summaries: (GmailMessageSummary | null)[] = new Array(ids.length).fill(null);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, ids.length) }, async () => {
      while (cursor < ids.length) {
        const i = cursor++;
        const id = ids[i];
        if (!id) continue;
        try {
          const m = await client.getMessage(id, "metadata", ["From", "Subject", "Date"]);
          summaries[i] = {
            id: m.id,
            threadId: m.threadId,
            from: m.headers.from,
            subject: m.headers.subject,
            date: m.headers.date,
            snippet: m.snippet,
          };
        } catch {
          summaries[i] = null;
        }
      }
    })
  );
  return {
    messages: summaries.filter((s): s is GmailMessageSummary => s !== null),
    nextPageToken: page.nextPageToken,
    resultSizeEstimate: page.resultSizeEstimate,
  };
}

export interface GetArgs {
  messageId: string;
  format?: "full" | "metadata" | "minimal";
}

export async function handleGet(client: GmailApiClient, args: GetArgs): Promise<GmailMessageDetail> {
  return client.getMessage(args.messageId, args.format ?? "full");
}

export interface GetAttachmentArgs {
  messageId: string;
  attachmentId: string;
}

export async function handleGetAttachment(client: GmailApiClient, args: GetAttachmentArgs) {
  const att = await client.getAttachment(args.messageId, args.attachmentId);
  let dataText: string | undefined;
  if (/^text\/|json|xml|csv|javascript/.test(att.mimeType)) {
    dataText = Buffer.from(att.dataBase64Url, "base64url").toString("utf8");
  }
  return { ...att, dataText };
}

export async function handleGetProfile(client: GmailApiClient) {
  return client.getProfile();
}

// ---------- MCP 注册 ----------

export function registerGmailTools(server: McpServer, client: GmailApiClient): void {
  server.registerTool(
    "gmail_search",
    {
      title: "搜索 Gmail 邮件",
      description:
        "按 Gmail 查询语法搜索邮件（如 from:github has:attachment is:unread），返回主题/发件人/时间摘要列表，支持分页。",
      inputSchema: {
        query: z.string().optional().describe("Gmail 查询语法，留空返回收件箱"),
        maxResults: z.number().int().min(1).max(100).optional().describe("返回条数，默认 20"),
        pageToken: z.string().optional().describe("分页令牌（上次返回的 nextPageToken）"),
      },
    },
    async (args) => {
      try {
        return ok(await handleSearch(client, args));
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    "gmail_get",
    {
      title: "读取 Gmail 邮件详情",
      description:
        "读取单封邮件：正文（纯文本与 HTML）、头部（From/To/Subject/Date）与附件清单。附件内容用 gmail_get_attachment 获取。",
      inputSchema: {
        messageId: z.string().describe("消息 ID（gmail_search 返回）"),
        format: z.enum(["full", "metadata", "minimal"]).optional().describe("full=完整（默认），metadata=仅头部，minimal=最小"),
      },
    },
    async (args) => {
      try {
        return ok(await handleGet(client, args));
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    "gmail_get_attachment",
    {
      title: "下载 Gmail 附件",
      description: "获取指定邮件的附件内容（base64url），文本类附件额外附解码后的 dataText。",
      inputSchema: {
        messageId: z.string().describe("消息 ID"),
        attachmentId: z.string().describe("附件 ID（gmail_get 返回的 attachments[].attachmentId）"),
      },
    },
    async (args) => {
      try {
        return ok(await handleGetAttachment(client, args));
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    "gmail_get_profile",
    {
      title: "获取 Gmail 账号信息",
      description: "返回授权账号的邮箱、邮件/会话总数与配额信息。",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await handleGetProfile(client));
      } catch (err) {
        return fail(err);
      }
    }
  );
}

// ---------- M3 读写 ----------

export interface SendArgs {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  attachments?: { filename: string; mimeType: string; dataBase64: string }[];
  confirm?: boolean;
}

function splitAddresses(s?: string): string[] {
  return (s ?? "").split(/[,;，；]/).map((x) => x.trim()).filter(Boolean);
}

export async function handleSend(client: GmailApiClient, args: SendArgs) {
  return client.sendMessage({
    to: splitAddresses(args.to),
    cc: splitAddresses(args.cc),
    bcc: splitAddresses(args.bcc),
    subject: args.subject,
    body: args.body,
    attachments: args.attachments,
  });
}

export interface ReplyArgs {
  messageId: string;
  body: string;
  attachments?: { filename: string; mimeType: string; dataBase64: string }[];
  confirm?: boolean;
}

export async function handleReply(client: GmailApiClient, args: ReplyArgs) {
  return client.replyMessage(args.messageId, args.body, args.attachments);
}

export async function handleCreateDraft(client: GmailApiClient, args: SendArgs) {
  return client.createDraft({
    to: splitAddresses(args.to),
    cc: splitAddresses(args.cc),
    bcc: splitAddresses(args.bcc),
    subject: args.subject,
    body: args.body,
    attachments: args.attachments,
  });
}

export interface SendDraftArgs {
  draftId: string;
  confirm?: boolean;
}

export async function handleSendDraft(client: GmailApiClient, args: SendDraftArgs) {
  return client.sendDraft(args.draftId);
}

export interface ModifyArgs {
  messageId: string;
  markRead?: boolean;
  archive?: boolean;
  trash?: boolean;
  addLabels?: string[];
  removeLabels?: string[];
}

export async function handleModify(client: GmailApiClient, args: ModifyArgs) {
  return client.modifyMessage(args.messageId, {
    markRead: args.markRead,
    archive: args.archive,
    trash: args.trash,
    addLabels: args.addLabels,
    removeLabels: args.removeLabels,
  });
}

export async function handleListLabels(client: GmailApiClient) {
  return client.listLabels();
}

export async function handleCreateLabel(client: GmailApiClient, name: string) {
  return client.createLabel(name);
}

export async function handleDeleteLabel(client: GmailApiClient, labelId: string) {
  await client.deleteLabel(labelId);
  return { deleted: labelId };
}

const attachmentSchema = z
  .array(
    z.object({
      filename: z.string().describe("文件名"),
      mimeType: z.string().describe("MIME 类型，如 text/plain、application/pdf"),
      dataBase64: z.string().describe("文件内容（标准 base64 编码）"),
    })
  )
  .optional()
  .describe("附件列表");

export function registerGmailWriteTools(server: McpServer, client: GmailApiClient): void {
  registerSensitiveTool<SendArgs>(
    server,
    "gmail_send",
    "发送 Gmail 邮件",
    "发送一封新邮件（纯文本正文 + 可选附件）。敏感操作：默认需 confirm: true 确认。",
    {
      to: z.string().describe("收件人，多个用逗号分隔"),
      subject: z.string().describe("主题"),
      body: z.string().describe("正文（纯文本）"),
      cc: z.string().optional().describe("抄送，多个用逗号分隔"),
      bcc: z.string().optional().describe("密送，多个用逗号分隔"),
      attachments: attachmentSchema,
      confirm: z.boolean().optional().describe("确认执行，必须显式传 true"),
    },
    (args) => handleSend(client, args),
    (args) => `发送邮件至 ${args.to}：${args.subject}`
  );

  registerSensitiveTool<ReplyArgs>(
    server,
    "gmail_reply",
    "回复 Gmail 邮件",
    "回复指定邮件（保留线程，自动引用原文）。敏感操作：默认需 confirm: true 确认。",
    {
      messageId: z.string().describe("要回复的消息 ID"),
      body: z.string().describe("回复正文（纯文本）"),
      attachments: attachmentSchema,
      confirm: z.boolean().optional().describe("确认执行，必须显式传 true"),
    },
    (args) => handleReply(client, args),
    (args) => `回复邮件 ${args.messageId}`
  );

  server.registerTool(
    "gmail_create_draft",
    {
      title: "创建 Gmail 草稿",
      description: "创建一封草稿（不发送），返回 draftId 与 messageId。",
      inputSchema: {
        to: z.string().describe("收件人，多个用逗号分隔"),
        subject: z.string().describe("主题"),
        body: z.string().describe("正文（纯文本）"),
        cc: z.string().optional().describe("抄送"),
        bcc: z.string().optional().describe("密送"),
        attachments: attachmentSchema,
      },
    },
    async (args: SendArgs) => {
      try {
        return ok(await handleCreateDraft(client, args));
      } catch (err) {
        return fail(err);
      }
    }
  );

  registerSensitiveTool<SendDraftArgs>(
    server,
    "gmail_send_draft",
    "发送 Gmail 草稿",
    "发送指定草稿。敏感操作：默认需 confirm: true 确认。",
    {
      draftId: z.string().describe("草稿 ID（gmail_create_draft 返回）"),
      confirm: z.boolean().optional().describe("确认执行，必须显式传 true"),
    },
    (args) => handleSendDraft(client, args),
    (args) => `发送草稿 ${args.draftId}`
  );

  server.registerTool(
    "gmail_modify",
    {
      title: "修改 Gmail 邮件状态",
      description: "标记已读/未读、归档、移入回收站、增删标签（需 gmail.modify 权限）。",
      inputSchema: {
        messageId: z.string().describe("消息 ID"),
        markRead: z.boolean().optional().describe("true=标已读，false=标未读"),
        archive: z.boolean().optional().describe("true=移出收件箱（归档）"),
        trash: z.boolean().optional().describe("true=移入回收站"),
        addLabels: z.array(z.string()).optional().describe("要添加的标签 ID（gmail_list_labels 返回）"),
        removeLabels: z.array(z.string()).optional().describe("要移除的标签 ID"),
      },
    },
    async (args: ModifyArgs) => {
      try {
        return ok(await handleModify(client, args));
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    "gmail_list_labels",
    {
      title: "列出 Gmail 标签",
      description: "返回全部标签（含系统标签与用户标签）及邮件计数。",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await handleListLabels(client));
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    "gmail_create_label",
    {
      title: "创建 Gmail 标签",
      description: "新建一个用户标签（需 gmail.labels 权限）。",
      inputSchema: {
        name: z.string().describe("标签名称"),
      },
    },
    async (args: { name: string }) => {
      try {
        return ok(await handleCreateLabel(client, args.name));
      } catch (err) {
        return fail(err);
      }
    }
  );

  registerSensitiveTool<{ labelId: string; confirm?: boolean }>(
    server,
    "gmail_delete_label",
    "删除 Gmail 标签",
    "删除指定标签。敏感操作：默认需 confirm: true 确认。",
    {
      labelId: z.string().describe("标签 ID"),
      confirm: z.boolean().optional().describe("确认执行，必须显式传 true"),
    },
    (args) => handleDeleteLabel(client, args.labelId),
    (args) => `删除标签 ${args.labelId}`
  );
}
