import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GraphApiClient } from "./client.js";
import { fail, ok, registerSensitiveTool, type ToolResult } from "../core/toolkit.js";

// ---------- 纯业务函数（可独立测试） ----------

export interface SearchArgs {
  query?: string;
  top?: number;
  skip?: number;
  nextLink?: string;
}

export async function handleSearch(client: GraphApiClient, args: SearchArgs) {
  const page = await client.listMessages(args.query ?? "", args.top ?? 20, args.skip ?? 0, args.nextLink);
  return { messages: page.messages, nextLink: page.nextLink };
}

export interface GetArgs {
  messageId: string;
}

export async function handleGet(client: GraphApiClient, args: GetArgs) {
  return client.getMessage(args.messageId);
}

export interface GetAttachmentArgs {
  messageId: string;
  attachmentId: string;
}

export async function handleGetAttachment(client: GraphApiClient, args: GetAttachmentArgs) {
  const att = await client.getAttachment(args.messageId, args.attachmentId);
  let dataText: string | undefined;
  if (att.contentBase64 && /^text\/|json|xml|csv|javascript/.test(att.contentType ?? "")) {
    dataText = Buffer.from(att.contentBase64, "base64").toString("utf8");
  }
  return { ...att, dataText };
}

export async function handleGetProfile(client: GraphApiClient) {
  return client.getProfile();
}

// ---------- MCP 注册 ----------

export function registerOutlookTools(server: McpServer, client: GraphApiClient): void {
  server.registerTool(
    "outlook_search",
    {
      title: "搜索 Outlook 邮件",
      description:
        "按 KQL 语法搜索邮件（如 from:xxx subject:xxx），返回 id/主题/发件人/时间摘要，支持 $top/$skip 与 nextLink 分页。",
      inputSchema: {
        query: z.string().optional().describe("KQL 搜索语法，留空返回收件箱"),
        top: z.number().int().min(1).max(100).optional().describe("返回条数，默认 20"),
        skip: z.number().int().min(0).optional().describe("跳过的条数，默认 0"),
        nextLink: z.string().optional().describe("分页链接（上次返回的 nextLink，提供后忽略 query/top/skip）"),
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
    "outlook_get",
    {
      title: "读取 Outlook 邮件详情",
      description:
        "读取单封邮件：正文（text/html）、发件人/收件人、时间与附件清单。附件内容用 outlook_get_attachment 获取。",
      inputSchema: {
        messageId: z.string().describe("消息 ID（outlook_search 返回）"),
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
    "outlook_get_attachment",
    {
      title: "下载 Outlook 附件",
      description: "获取指定附件（contentBytes base64），文本类附件额外附解码后的 dataText。",
      inputSchema: {
        messageId: z.string().describe("消息 ID"),
        attachmentId: z.string().describe("附件 ID（outlook_get 返回的 attachments[].id）"),
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
    "outlook_get_profile",
    {
      title: "获取 Outlook 账号信息",
      description: "返回授权账号的显示名、邮箱与用户主体名。",
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

export async function handleSend(client: GraphApiClient, args: SendArgs) {
  return client.sendMail({
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
  confirm?: boolean;
}

export async function handleReply(client: GraphApiClient, args: ReplyArgs) {
  return client.replyMessage(args.messageId, args.body);
}

export async function handleCreateDraft(client: GraphApiClient, args: SendArgs) {
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
  messageId: string;
  confirm?: boolean;
}

export async function handleSendDraft(client: GraphApiClient, args: SendDraftArgs) {
  return client.sendDraft(args.messageId);
}

export interface ModifyArgs {
  messageId: string;
  markRead?: boolean;
  categories?: string[];
}

export async function handleModify(client: GraphApiClient, args: ModifyArgs) {
  return client.modifyMessage(args.messageId, { markRead: args.markRead, categories: args.categories });
}

export interface MoveArgs {
  messageId: string;
  folderId: string;
  confirm?: boolean;
}

export async function handleMove(client: GraphApiClient, args: MoveArgs) {
  return client.moveMessage(args.messageId, args.folderId);
}

export async function handleListFolders(client: GraphApiClient) {
  return client.listFolders();
}

export async function handleDelete(client: GraphApiClient, messageId: string) {
  await client.deleteMessage(messageId);
  return { deleted: messageId };
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

export function registerOutlookWriteTools(server: McpServer, client: GraphApiClient): void {
  registerSensitiveTool<SendArgs>(
    server,
    "outlook_send",
    "发送 Outlook 邮件",
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
    "outlook_reply",
    "回复 Outlook 邮件",
    "回复指定邮件（仅回复发件人）。敏感操作：默认需 confirm: true 确认。",
    {
      messageId: z.string().describe("要回复的消息 ID"),
      body: z.string().describe("回复正文（纯文本）"),
      confirm: z.boolean().optional().describe("确认执行，必须显式传 true"),
    },
    (args) => handleReply(client, args),
    (args) => `回复邮件 ${args.messageId}`
  );

  server.registerTool(
    "outlook_create_draft",
    {
      title: "创建 Outlook 草稿",
      description: "创建一封草稿（不发送），返回草稿 ID。",
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
    "outlook_send_draft",
    "发送 Outlook 草稿",
    "发送指定草稿。敏感操作：默认需 confirm: true 确认。",
    {
      messageId: z.string().describe("草稿消息 ID（outlook_create_draft 返回）"),
      confirm: z.boolean().optional().describe("确认执行，必须显式传 true"),
    },
    (args) => handleSendDraft(client, args),
    (args) => `发送草稿 ${args.messageId}`
  );

  server.registerTool(
    "outlook_modify",
    {
      title: "修改 Outlook 邮件状态",
      description: "标记已读/未读、设置分类（categories）。",
      inputSchema: {
        messageId: z.string().describe("消息 ID"),
        markRead: z.boolean().optional().describe("true=标已读，false=标未读"),
        categories: z.array(z.string()).optional().describe("分类列表（如 [\"重要\"]）"),
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

  registerSensitiveTool<MoveArgs>(
    server,
    "outlook_move",
    "移动 Outlook 邮件",
    "将邮件移动到指定文件夹。敏感操作：默认需 confirm: true 确认。",
    {
      messageId: z.string().describe("消息 ID"),
      folderId: z.string().describe("目标文件夹 ID（outlook_list_folders 返回）"),
      confirm: z.boolean().optional().describe("确认执行，必须显式传 true"),
    },
    (args) => handleMove(client, args),
    (args) => `移动邮件 ${args.messageId} 到文件夹 ${args.folderId}`
  );

  server.registerTool(
    "outlook_list_folders",
    {
      title: "列出 Outlook 文件夹",
      description: "返回邮件文件夹列表（收件箱/已发送等）及邮件计数。",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await handleListFolders(client));
      } catch (err) {
        return fail(err);
      }
    }
  );

  registerSensitiveTool<{ messageId: string; confirm?: boolean }>(
    server,
    "outlook_delete",
    "删除 Outlook 邮件",
    "永久删除指定邮件。敏感操作：默认需 confirm: true 确认。",
    {
      messageId: z.string().describe("消息 ID"),
      confirm: z.boolean().optional().describe("确认执行，必须显式传 true"),
    },
    (args) => handleDelete(client, args.messageId),
    (args) => `删除邮件 ${args.messageId}`
  );
}
