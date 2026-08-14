// M3 冒烟：Gmail/Outlook 读写工具 + confirm 门控 + MCP 协议端到端（mock 双侧 API）
import { createServer } from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { GmailApiClient } from "../dist/gmail/client.js";
import { GraphApiClient } from "../dist/outlook/client.js";
import {
  handleSend as gSend, handleReply as gReply, handleCreateDraft as gDraft,
  handleSendDraft as gSendDraft, handleModify as gModify, handleListLabels as gLabels,
  handleCreateLabel as gCreateLabel, handleDeleteLabel as gDeleteLabel,
} from "../dist/gmail/tools.js";
import {
  handleSend as oSend, handleReply as oReply, handleCreateDraft as oDraft,
  handleSendDraft as oSendDraft, handleModify as oModify, handleMove as oMove,
  handleListFolders as oFolders, handleDelete as oDelete,
} from "../dist/outlook/tools.js";

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${extra ? " — " + extra : ""}`);
  if (!cond) failures++;
};

const HOME = "/tmp/email-mcp-m3";
rmSync(HOME, { recursive: true, force: true });
mkdirSync(HOME + "/tokens", { recursive: true });

// ---------- mock：同一服务器按路径前缀分发 ----------
let gmailRawDecoded = "";
let gmailModifyBody = null;
let gmailReplyMeta = null;
let outlookSendBody = null;
let outlookPatchBody = null;
let outlookMoveBody = null;
let outlookDraftBody = null;

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  const bodyPromise = () =>
    new Promise((resolve) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => resolve(b ? JSON.parse(b) : {}));
    });

  void (async () => {
    const p = url.pathname;

    // ===== Gmail =====
    if (p === "/gmail/v1/users/me/messages/send") {
      const body = await bodyPromise();
      gmailRawDecoded = Buffer.from(body.raw, "base64url").toString("utf8");
      return send(200, { id: "sent1", threadId: "th-sent" });
    }
    if (p === "/gmail/v1/users/me/drafts") {
      const body = await bodyPromise();
      if (body.message?.raw) gmailRawDecoded = Buffer.from(body.message.raw, "base64url").toString("utf8");
      return send(200, { id: "draft1", message: { id: "draftmsg1" } });
    }
    if (p === "/gmail/v1/users/me/drafts/send") {
      return send(200, { id: "sent2", threadId: "th2" });
    }
    if (p.startsWith("/gmail/v1/users/me/messages/msg1") && p.endsWith("/modify")) {
      gmailModifyBody = await bodyPromise();
      return send(200, { id: "msg1", labelIds: ["INBOX", "UNREAD"] });
    }
    if (p === "/gmail/v1/users/me/messages/msg1" && url.searchParams.get("format") === "metadata") {
      gmailReplyMeta = url.searchParams.get("metadataHeaders");
      return send(200, {
        id: "msg1", threadId: "th-orig", snippet: "原文内容",
        payload: { headers: [
          { name: "From", value: "Alice <alice@example.com>" },
          { name: "Subject", value: "主题一" },
          { name: "Date", value: "Tue, 14 Aug 2025 10:00:00 +0800" },
          { name: "Message-ID", value: "<orig-1@example.com>" },
        ] },
      });
    }
    if (p === "/gmail/v1/users/me/labels" && req.method === "POST") {
      const body = await bodyPromise();
      return send(200, { id: "Label_1", name: body.name });
    }
    if (p === "/gmail/v1/users/me/labels") {
      return send(200, { labels: [{ id: "INBOX", name: "INBOX", type: "system" }, { id: "Label_1", name: "工作", type: "user", messagesTotal: 3 }] });
    }
    if (p === "/gmail/v1/users/me/labels/Label_1" && req.method === "DELETE") {
      res.writeHead(204); return res.end();
    }

    // ===== Graph =====
    if (p === "/v1.0/me/sendMail") {
      outlookSendBody = await bodyPromise();
      res.writeHead(202); return res.end();
    }
    if (p === "/v1.0/me/messages/oms1/reply") {
      return send(202, {});
    }
    if (p === "/v1.0/me/messages" && req.method === "POST") {
      outlookDraftBody = await bodyPromise();
      return send(201, { id: "gdraft1" });
    }
    if (p === "/v1.0/me/messages/gdraft1/send") {
      res.writeHead(202); return res.end();
    }
    if (p === "/v1.0/me/messages/oms1" && req.method === "PATCH") {
      outlookPatchBody = await bodyPromise();
      return send(200, { id: "oms1" });
    }
    if (p === "/v1.0/me/messages/oms1/move") {
      outlookMoveBody = await bodyPromise();
      return send(200, { id: "oms1" });
    }
    if (p === "/v1.0/me/mailFolders") {
      return send(200, { value: [
        { id: "inbox", displayName: "收件箱", totalItemCount: 5, unreadItemCount: 2 },
        { id: "sent", displayName: "已发送邮件", totalItemCount: 10, unreadItemCount: 0 },
      ] });
    }
    if (p === "/v1.0/me/messages/oms2" && req.method === "DELETE") {
      res.writeHead(204); return res.end();
    }
    send(404, { error: { code: "mock_unknown", message: p } });
  })();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const apiBase = `http://127.0.0.1:${server.address().port}`;
console.log(`[mock] ${apiBase}\n`);

process.env.EMAIL_MCP_HOME = HOME;
process.env.EMAIL_MCP_GMAIL_API_BASE = apiBase;
process.env.EMAIL_MCP_GRAPH_API_BASE = apiBase;
writeFileSync(HOME + "/tokens/gmail.json", JSON.stringify({ accessToken: "gt", refreshToken: "grt", expiresAt: Date.now() + 3600_000 }));
writeFileSync(HOME + "/tokens/outlook.json", JSON.stringify({ accessToken: "ot", refreshToken: "ort", expiresAt: Date.now() + 3600_000 }));

const gmailCfg = { clientId: "1-a.apps.googleusercontent.com", clientSecret: "s", scopes: ["gmail.modify", "gmail.labels"], callbackPort: 8787 };
const outlookCfg = { clientId: "11111111-2222-3333-4444-555555555555", tenant: "common", scopes: ["Mail.ReadWrite", "Mail.Send"] };
const gc = new GmailApiClient(gmailCfg);
const oc = new GraphApiClient(outlookCfg);

// ---------- 1) Gmail 读写 ----------
console.log("== 1) Gmail 读写 ==");
const att = { filename: "报告.pdf", mimeType: "application/pdf", dataBase64: b64("PDFDATA") };
const sent = await gSend(gc, { to: "a@b.com, c@d.com", cc: "e@f.com", subject: "中文主题", body: "正文内容", attachments: [att] });
check("send 返回 id", sent.id === "sent1");
check("MIME: To 头正确", gmailRawDecoded.includes("To: a@b.com, c@d.com"));
check("MIME: Cc 头正确", gmailRawDecoded.includes("Cc: e@f.com"));
check("MIME: 中文主题 RFC2047 编码", gmailRawDecoded.includes("=?UTF-8?B?") && !gmailRawDecoded.includes("Subject: 中文"));
check("MIME: 正文 base64 可解码", gmailRawDecoded.includes(b64("正文内容")));
check("MIME: 附件段含文件名", gmailRawDecoded.includes('name="报告.pdf"'));
check("MIME: 附件内容", gmailRawDecoded.includes(b64("PDFDATA")));

// 提取 MIME 中 text/plain 的 base64 正文并解码
const decodePlainBody = (raw) => {
  const m = /Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/.exec(raw);
  return m ? Buffer.from(m[1].replace(/\s+/g, ""), "base64").toString("utf8") : "";
};

const reply = await gReply(gc, { messageId: "msg1", body: "好的收到" });
check("reply 保留 threadId", reply.threadId === "th-sent");
check("reply 请求 metadata 头部", gmailReplyMeta === "From,Subject,Date,Message-ID,References");
const replyPlain = decodePlainBody(gmailRawDecoded);
check("reply 引用原文", replyPlain.includes("On Tue, 14 Aug 2025 10:00:00 +0800, alice@example.com wrote:") && replyPlain.includes("> 原文内容") && replyPlain.includes("好的收到"));
check("reply 主题加 Re 前缀", gmailRawDecoded.includes("=?UTF-8?B?") && (() => { const m = /Subject: (.+)/.exec(gmailRawDecoded); return m ? m[1].includes("Re") || Buffer.from(m[1].replace(/=\?UTF-8\?B\?([^?]+)\?=/g, (_, x) => Buffer.from(x, "base64").toString("utf8")), "utf8").includes("Re: 主题一") : false; })());

const draft = await gDraft(gc, { to: "a@b.com", subject: "草稿主题", body: "草稿正文" });
check("createDraft 返回 draftId", draft.draftId === "draft1");
const sentDraft = await gSendDraft(gc, { draftId: "draft1" });
check("sendDraft 返回", sentDraft.id === "sent2");

const modified = await gModify(gc, { messageId: "msg1", markRead: true, archive: true });
check("modify 返回", modified.id === "msg1");
check("modify: markRead → removeLabelIds 含 UNREAD", gmailModifyBody.removeLabelIds.includes("UNREAD"));
check("modify: archive → removeLabelIds 含 INBOX", gmailModifyBody.removeLabelIds.includes("INBOX"));

const labels = await gLabels(gc);
check("listLabels 返回系统+用户标签", labels.length === 2 && labels[1].name === "工作");
const newLabel = await gCreateLabel(gc, "新标签");
check("createLabel 返回 id", newLabel.id === "Label_1");
const delLabel = await gDeleteLabel(gc, "Label_1");
check("deleteLabel", delLabel.deleted === "Label_1");

// ---------- 2) Outlook 读写 ----------
console.log("\n== 2) Outlook 读写 ==");
const osent = await oSend(oc, { to: "x@y.com", subject: "Outlook 发送", body: "正文", cc: "z@w.com", attachments: [{ filename: "a.txt", mimeType: "text/plain", dataBase64: b64("abc") }] });
check("sendMail 成功", osent !== undefined);
check("sendMail: toRecipients", outlookSendBody.message.toRecipients[0].emailAddress.address === "x@y.com");
check("sendMail: ccRecipients", outlookSendBody.message.ccRecipients[0].emailAddress.address === "z@w.com");
check("sendMail: saveToSentItems", outlookSendBody.saveToSentItems === true);
check("sendMail: 附件 contentBytes", outlookSendBody.message.attachments[0].contentBytes === b64("abc"));

await oReply(oc, { messageId: "oms1", body: "回复内容" });
check("reply 已调用（202）", true);

const odraft = await oDraft(oc, { to: "x@y.com", subject: "草稿", body: "草稿正文" });
check("createDraft 返回 id", odraft.id === "gdraft1");
check("createDraft: isDraft=true", outlookDraftBody.isDraft === true);
await oSendDraft(oc, { messageId: "gdraft1" });
check("sendDraft 已调用", true);

await oModify(oc, { messageId: "oms1", markRead: true, categories: ["重要"] });
check("modify: isRead", outlookPatchBody.isRead === true);
check("modify: categories", outlookPatchBody.categories[0] === "重要");

await oMove(oc, { messageId: "oms1", folderId: "archive" });
check("move: destinationId", outlookMoveBody.destinationId === "archive");

const folders = await oFolders(oc);
check("listFolders 2 个", folders.length === 2 && folders[0].displayName === "收件箱");
const del = await oDelete(oc, "oms2");
check("delete 返回", del.deleted === "oms2");

// ---------- 3) MCP 协议端到端 + confirm 门控 ----------
console.log("\n== 3) MCP 协议端到端 + confirm 门控 ==");

async function e2e(provider, expectTools) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/cli.js", provider],
    stderr: "inherit",
    env: {
      ...process.env,
      EMAIL_MCP_HOME: HOME,
      EMAIL_MCP_GMAIL_API_BASE: apiBase,
      EMAIL_MCP_GRAPH_API_BASE: apiBase,
      EMAIL_MCP_GMAIL_CLIENT_ID: gmailCfg.clientId,
      EMAIL_MCP_GMAIL_CLIENT_SECRET: gmailCfg.clientSecret,
      EMAIL_MCP_OUTLOOK_CLIENT_ID: outlookCfg.clientId,
    },
  });
  const mcp = new Client({ name: "smoke-m3", version: "0.0.1" });
  await mcp.connect(transport);
  const t = await mcp.listTools();
  check(`${provider} listTools ${expectTools} 个`, t.tools.length === expectTools);
  check(`${provider} 工具前缀`, t.tools.every((x) => x.name.startsWith(provider + "_")));

  const toolSend = provider + "_send";
  const noConfirm = await mcp.callTool({ name: toolSend, arguments: { to: "a@b.com", subject: "s", body: "b" } });
  const nc = JSON.parse(noConfirm.content[0].type === "text" ? noConfirm.content[0].text : "{}");
  check(`${toolSend} 无 confirm → confirmation_required`, nc.ok === false && nc.error.code === "confirmation_required");

  const withConfirm = await mcp.callTool({ name: toolSend, arguments: { to: "a@b.com", subject: "s", body: "b", confirm: true } });
  const wc = JSON.parse(withConfirm.content[0].type === "text" ? withConfirm.content[0].text : "{}");
  check(`${toolSend} 带 confirm → ok=true`, wc.ok === true);

  await mcp.close();
}

await e2e("gmail", 12);
await e2e("outlook", 12);

server.close();
console.log(failures === 0 ? "\n[smoke-m3] 全部通过 ✅" : `\n[smoke-m3] ${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
