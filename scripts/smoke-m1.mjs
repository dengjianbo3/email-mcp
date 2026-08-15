// M1 冒烟：mock Gmail API + OAuth 组件 + MCP 协议端到端（无需真实凭据）
import { createServer } from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { GmailApiClient } from "../dist/gmail/client.js";
import {
  base64UrlEncode, generatePkce, buildAuthUrl, startCallbackServer, exchangeCode,
} from "../dist/gmail/oauth.js";
import { handleGet, handleGetAttachment, handleGetProfile, handleSearch } from "../dist/gmail/tools.js";

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${extra ? " — " + extra : ""}`);
  if (!cond) failures++;
};

const HOME = "/tmp/email-mcp-m1";
rmSync(HOME, { recursive: true, force: true });
mkdirSync(HOME + "/tokens", { recursive: true });

// ---------- mock Gmail API + token 端点 ----------
let refreshCount = 0;
const receivedAuths = [];
const b64 = (s) => Buffer.from(s, "utf8").toString("base64url");

const attachmentsData = { att1: { attachmentId: "att1", mimeType: "text/plain", filename: "note.txt", size: 5, data: b64("hello") } };
const msg1Full = {
  id: "msg1", threadId: "th1", snippet: "测试邮件",
  payload: {
    mimeType: "multipart/mixed",
    headers: [
      { name: "From", value: "Alice <alice@example.com>" },
      { name: "To", value: "me@gmail.com" },
      { name: "Subject", value: "你好，M1 冒烟" },
      { name: "Date", value: "Tue, 14 Aug 2025 10:00:00 +0800" },
    ],
    parts: [
      { mimeType: "multipart/alternative", parts: [
        { mimeType: "text/plain", body: { data: b64("正文纯文本：你好世界") } },
        { mimeType: "text/html", body: { data: b64("<p>正文HTML</p>") } },
      ]},
      { mimeType: "text/plain", filename: "note.txt", body: { attachmentId: "att1", size: 5 } },
      { mimeType: "image/png", filename: "inline.png", headers: [{ name: "Content-ID", value: "<img1>" }], body: { attachmentId: "att2", size: 10 } },
    ],
  },
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };

  if (req.method === "POST" && url.pathname === "/token") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const params = new URLSearchParams(body);
      if (params.get("grant_type") === "authorization_code") {
        check("exchange 请求带 code 与 code_verifier", params.get("code") === "auth-code-123" && params.get("code_verifier")?.length >= 43);
        check("exchange 请求带 client_id", params.get("client_id") === gmailCfg.clientId);
        return send(200, { access_token: "exchanged-token", refresh_token: "exchanged-rt", expires_in: 3600, scope: "gmail.readonly" });
      }
      check("refresh 请求带 refresh_token", params.get("refresh_token") === "old-refresh-token");
      check("refresh 请求带 grant_type", params.get("grant_type") === "refresh_token");
      refreshCount++;
      send(200, { access_token: "fresh-token-abc", refresh_token: "rotated-refresh", expires_in: 3600, scope: "gmail.readonly" });
    });
    return;
  }

  const auth = req.headers.authorization ?? "";
  receivedAuths.push(auth);

  if (url.pathname === "/gmail/v1/users/me/profile") {
    send(200, { emailAddress: "me@gmail.com", messagesTotal: 42, threadsTotal: 40, historyId: "h1" });
  } else if (url.pathname === "/gmail/v1/users/me/messages") {
    send(200, { messages: [{ id: "msg1", threadId: "th1" }, { id: "msg2", threadId: "th2" }], nextPageToken: "page2", resultSizeEstimate: 2 });
  } else if (url.pathname === "/gmail/v1/users/me/messages/msg1" && url.searchParams.get("format") === "METADATA") {
    check("metadata 请求带重复 metadataHeaders", url.searchParams.getAll("metadataHeaders").join(",") === "From,Subject,Date");
    send(200, { id: "msg1", threadId: "th1", snippet: "测试邮件", payload: { headers: [
      { name: "From", value: "Alice <alice@example.com>" },
      { name: "Subject", value: "你好，M1 冒烟" },
      { name: "Date", value: "Tue, 14 Aug 2025 10:00:00 +0800" },
    ] } });
  } else if (url.pathname === "/gmail/v1/users/me/messages/msg1") {
    send(200, msg1Full);
  } else if (url.pathname === "/gmail/v1/users/me/messages/msg2" && url.searchParams.get("format") === "METADATA") {
    send(200, { id: "msg2", threadId: "th2", snippet: "另一封", payload: { headers: [{ name: "From", value: "Bob <bob@example.com>" }, { name: "Subject", value: "Re: hi" }] } });
  } else if (url.pathname === "/gmail/v1/users/me/messages/msg1/attachments/att1") {
    send(200, attachmentsData.att1);
  } else {
    send(404, { error: { message: "mock 未实现: " + url.pathname } });
  }
});
await new Promise((res) => server.listen(0, "127.0.0.1", res));
const port = server.address().port;
const apiBase = `http://127.0.0.1:${port}`;
console.log(`[mock] Gmail API 监听 ${apiBase}\n`);

process.env.EMAIL_MCP_HOME = HOME;
process.env.EMAIL_MCP_GMAIL_API_BASE = apiBase;
process.env.EMAIL_MCP_OAUTH_TOKEN_URL = apiBase + "/token";

// 过期 token（触发刷新）
writeFileSync(HOME + "/tokens/gmail.json", JSON.stringify({
  accessToken: "expired-token", refreshToken: "old-refresh-token", expiresAt: Date.now() - 1000, account: "me@gmail.com",
}));

const gmailCfg = {
  clientId: "1234567890-abcdef.apps.googleusercontent.com",
  clientSecret: "GOCSPX-secret",
  scopes: ["gmail.readonly"],
  callbackPort: 8791,
};

// ---------- 1) OAuth 组件 ----------
console.log("== 1) OAuth 组件 ==");
const pkce = generatePkce();
check("PKCE verifier 长度合规", pkce.verifier.length >= 43 && pkce.verifier.length <= 128);
check("PKCE challenge = S256(verifier)", pkce.challenge === base64UrlEncode(createHash("sha256").update(pkce.verifier).digest()));
const authUrl = buildAuthUrl(gmailCfg, "http://localhost:8791/callback", gmailCfg.scopes, pkce.challenge, "st1");
check("auth URL 含 code_challenge", authUrl.includes("code_challenge=" + pkce.challenge));
check("auth URL 含 access_type=offline", authUrl.includes("access_type=offline"));
check("auth URL 含 redirect_uri", authUrl.includes("redirect_uri=" + encodeURIComponent("http://localhost:8791/callback")));

// 回调服务器
const cb = startCallbackServer(8792);
const cbPromise = cb.waitForCode(5000).then(
  (c) => { check("回调收到 code", c === "auth-code-123"); return c; },
  (e) => { check("回调收到 code", false, String(e.message)); }
);
await fetch("http://127.0.0.1:8792/callback?code=auth-code-123");
await cbPromise;
cb.close();

// token 交换（authorization_code grant）
const exchanged = await exchangeCode(gmailCfg, "auth-code-123", pkce.verifier, "http://localhost:8792/callback");
check("exchangeCode 返回 access/refresh", exchanged.accessToken === "exchanged-token" && exchanged.refreshToken === "exchanged-rt");

// ---------- 2) API 客户端 + 工具（连 mock） ----------
console.log("\n== 2) API 客户端与工具（mock） ==");
const client = new GmailApiClient(gmailCfg);

const profile = await handleGetProfile(client);
check("getProfile 账号正确", profile.emailAddress === "me@gmail.com");
check("getProfile 触发了一次刷新", refreshCount === 1);
check("刷新后使用新 token 调 API", receivedAuths.some((a) => a === "Bearer fresh-token-abc"));
check("token 文件已更新（rotated refresh）", JSON.parse((await import("node:fs")).readFileSync(HOME + "/tokens/gmail.json", "utf8")).refreshToken === "rotated-refresh");

const search = await handleSearch(client, { query: "from:alice", maxResults: 5 });
check("search 返回 2 条", search.messages.length === 2);
check("search 摘要含主题", search.messages[0].subject === "你好，M1 冒烟");
check("search 摘要含发件人", search.messages[0].from === "Alice <alice@example.com>");
check("search 带 nextPageToken", search.nextPageToken === "page2");

const detail = await handleGet(client, { messageId: "msg1" });
check("get 正文纯文本解码（中文）", detail.bodyText === "正文纯文本：你好世界");
check("get 正文 HTML", detail.bodyHtml === "<p>正文HTML</p>");
check("get 头部 From/To/Subject", detail.headers.from === "Alice <alice@example.com>" && detail.headers.subject === "你好，M1 冒烟");
check("get 附件清单 2 项", detail.attachments.length === 2);
check("get 附件含 filename", detail.attachments[0].filename === "note.txt");
check("get inline 附件被标记", detail.attachments[1].inline === true && detail.attachments[0].inline === false);

const att = await handleGetAttachment(client, { messageId: "msg1", attachmentId: "att1" });
check("附件 base64 数据", att.dataBase64Url === b64("hello"));
check("附件文本解码", att.dataText === "hello");

// ---------- 3) MCP 协议端到端（真实 spawn CLI） ----------
console.log("\n== 3) MCP 协议端到端 ==");
const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/cli.js", "gmail"],
  stderr: "inherit",
  env: {
    ...process.env,
    EMAIL_MCP_HOME: HOME,
    EMAIL_MCP_GMAIL_API_BASE: apiBase,
    EMAIL_MCP_OAUTH_TOKEN_URL: apiBase + "/token",
    EMAIL_MCP_GMAIL_CLIENT_ID: gmailCfg.clientId,
    EMAIL_MCP_GMAIL_CLIENT_SECRET: gmailCfg.clientSecret,
  },
});
const mcp = new Client({ name: "smoke-test", version: "0.0.1" });
await mcp.connect(transport);

const tools = await mcp.listTools();
check("listTools 返回 12 个工具", tools.tools.length === 12);
check("工具名均为 gmail_* 前缀", tools.tools.every((t) => t.name.startsWith("gmail_")));

const callRes = await mcp.callTool({ name: "gmail_search", arguments: { query: "from:alice", maxResults: 5 } });
const text = callRes.content[0].type === "text" ? callRes.content[0].text : "";
const parsed = JSON.parse(text);
check("callTool gmail_search ok=true", parsed.ok === true);
check("callTool 返回 2 条", parsed.data.messages.length === 2);

const callProfile = await mcp.callTool({ name: "gmail_get_profile", arguments: {} });
const p2 = JSON.parse(callProfile.content[0].type === "text" ? callProfile.content[0].text : "{}");
check("callTool gmail_get_profile", p2.ok === true && p2.data.emailAddress === "me@gmail.com");

const badCall = await mcp.callTool({ name: "gmail_get", arguments: { messageId: "missing" } });
const badParsed = JSON.parse(badCall.content[0].type === "text" ? badCall.content[0].text : "{}");
check("不存在消息返回 ok=false 错误结构", badParsed.ok === false && badParsed.error?.message?.length > 0);

await mcp.close();
server.close();

console.log(failures === 0 ? "\n[smoke-m1] 全部通过 ✅" : `\n[smoke-m1] ${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
