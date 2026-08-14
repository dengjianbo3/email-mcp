// M2 冒烟：mock Microsoft Graph + device code 轮询（pending/slow_down）+ MCP 协议端到端
import { createServer } from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { GraphApiClient } from "../dist/outlook/client.js";
import { startDeviceCodeAuth } from "../dist/outlook/oauth.js";
import { handleGet, handleGetAttachment, handleGetProfile, handleSearch } from "../dist/outlook/tools.js";

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${extra ? " — " + extra : ""}`);
  if (!cond) failures++;
};

const HOME = "/tmp/email-mcp-m2";
rmSync(HOME, { recursive: true, force: true });
mkdirSync(HOME + "/tokens", { recursive: true });

// ---------- mock Graph + token 端点 ----------
const pollLog = {}; // device_code -> [timestamp...]
let dcCallCount = 0;
let refreshCount = 0;
let lastSearchParam = "";
let lastNextLinkPath = "";

const tokenPayload = (extra = {}) => ({
  access_token: "ms-fresh-token-1",
  refresh_token: "ms-rotated-rt",
  expires_in: 3600,
  scope: "Mail.ReadWrite Mail.Send User.Read offline_access",
  ...extra,
});

const graphMsgs = [
  {
    id: "ms1", subject: "Outlook 测试主题", hasAttachments: true, isRead: false, importance: "normal",
    receivedDateTime: "2025-08-14T02:00:00Z",
    from: { emailAddress: { name: "微软团队", address: "noreply@microsoft.com" } },
    toRecipients: [{ emailAddress: { name: "Me", address: "me@outlook.com" } }],
  },
  {
    id: "ms2", subject: "Re: hi", hasAttachments: false, isRead: true, importance: "high",
    receivedDateTime: "2025-08-13T10:00:00Z",
    from: { emailAddress: { address: "bob@example.com" } },
    toRecipients: [{ emailAddress: { address: "me@outlook.com" } }],
  },
];

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };

  const collectBody = () =>
    new Promise((resolve) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => resolve(new URLSearchParams(b)));
    });

  if (req.method === "POST" && url.pathname.endsWith("/devicecode")) {
    dcCallCount++;
    // 第一次调用 → main 场景；第二次 → slow_down 场景（不同 device_code 隔离轮询计数）
    send(200, {
      device_code: dcCallCount === 1 ? "DEV-CODE-1" : "slow-test",
      user_code: "ABC-DEFG",
      verification_uri: "https://microsoft.com/devicelogin", expires_in: 900, interval: 1, message: "msg",
    });
    return;
  }

  if (req.method === "POST" && url.pathname.endsWith("/token")) {
    void (async () => {
      const params = await collectBody();
      const grant = params.get("grant_type");
      if (grant === "urn:ietf:params:oauth:grant-type:device_code") {
        const dc = params.get("device_code");
        (pollLog[dc] ??= []).push(Date.now());
        const n = pollLog[dc].length;
        if (dc === "slow-test") {
          if (n === 1) return send(400, { error: "slow_down", error_description: "slow" });
          if (n === 2) return send(400, { error: "authorization_pending" });
          return send(200, tokenPayload({ access_token: "ms-slow-ok" }));
        }
        // main：第 1 次 pending，第 2 次成功
        if (n === 1) return send(400, { error: "authorization_pending" });
        return send(200, tokenPayload());
      }
      if (grant === "refresh_token") {
        check("refresh 请求带 refresh_token", params.get("refresh_token") === "ms-old-rt");
        refreshCount++;
        return send(200, tokenPayload());
      }
      send(400, { error: "unsupported_grant_type" });
    })();
    return;
  }

  const auth = req.headers.authorization ?? "";
  const p = url.pathname;

  if (p === "/v1.0/me" && url.searchParams.get("$select")?.includes("displayName")) {
    send(200, { displayName: "张三", mail: "me@outlook.com", userPrincipalName: "me@outlook.com" });
  } else if (p === "/v1.0/me/messages") {
    lastSearchParam = url.searchParams.get("$search") ?? "";
    lastNextLinkPath = url.search;
    if (url.searchParams.get("$skiptoken") === "page2") {
      send(200, { value: [{ id: "ms3", subject: "第二页邮件", from: { emailAddress: { address: "c@example.com" } } }] });
    } else {
      send(200, { value: graphMsgs, "@odata.nextLink": `${process.env.EMAIL_MCP_GRAPH_API_BASE}/v1.0/me/messages?\$skiptoken=page2` });
    }
  } else if (p === "/v1.0/me/messages/ms1" && url.searchParams.get("$expand") === "attachments") {
    send(200, {
      id: "ms1", subject: "Outlook 测试主题",
      from: { emailAddress: { name: "微软团队", address: "noreply@microsoft.com" } },
      toRecipients: [{ emailAddress: { address: "me@outlook.com" } }],
      receivedDateTime: "2025-08-14T02:00:00Z",
      body: { contentType: "html", content: "<p>Outlook 正文</p>" },
      attachments: [
        { "@odata.type": "#microsoft.graph.fileAttachment", id: "att1", name: "计划.txt", contentType: "text/plain", size: 15, isInline: false, contentBytes: Buffer.from("hello outlook", "utf8").toString("base64") },
        { "@odata.type": "#microsoft.graph.fileAttachment", id: "att2", name: "logo.png", contentType: "image/png", size: 9, isInline: true, contentBytes: Buffer.from("imgdata", "utf8").toString("base64") },
        { "@odata.type": "#microsoft.graph.referenceAttachment", id: "att3", name: "链接.xlsx" },
      ],
    });
  } else if (p === "/v1.0/me/messages/ms1/attachments/att1") {
    send(200, { id: "att1", name: "计划.txt", contentType: "text/plain", size: 15, contentBytes: Buffer.from("hello outlook", "utf8").toString("base64") });
  } else {
    send(404, { error: { code: "mock_unknown", message: "mock 未实现: " + p } });
  }
});
await new Promise((res) => server.listen(0, "127.0.0.1", res));
const apiBase = `http://127.0.0.1:${server.address().port}`;
console.log(`[mock] Graph 监听 ${apiBase}\n`);

process.env.EMAIL_MCP_HOME = HOME;
process.env.EMAIL_MCP_GRAPH_API_BASE = apiBase;
process.env.EMAIL_MCP_MS_TOKEN_URL = apiBase + "/common/oauth2/v2.0/token";
process.env.EMAIL_MCP_MS_DEVICECODE_URL = apiBase + "/common/oauth2/v2.0/devicecode";

const outlookCfg = {
  clientId: "11111111-2222-3333-4444-555555555555",
  tenant: "common",
  scopes: ["Mail.ReadWrite", "Mail.Send", "User.Read", "offline_access"],
};

// ---------- 1) device code 授权轮询 ----------
console.log("== 1) device code 授权 ==");
const sess = await startDeviceCodeAuth(outlookCfg);
check("device code 返回 user_code", sess.userCode === "ABC-DEFG");
check("device code 返回 verification_uri", sess.verificationUri === "https://microsoft.com/devicelogin");
const tok = await sess.waitForCompletion(20_000);
check("轮询 pending 后拿到 token", tok.accessToken === "ms-fresh-token-1");

// slow_down：间隔应 +5s（两次轮询时间差 >= 4s）
const slowSess = await startDeviceCodeAuth(outlookCfg);
await new Promise((r) => setTimeout(r, 0)); // 让首轮询发出
await slowSess.waitForCompletion(30_000);
const times = pollLog["slow-test"] ?? [];
check("slow_down 轮询 3 次", times.length === 3);
check("slow_down 后间隔 +5s 生效", times.length >= 2 && times[1] - times[0] >= 4000, `间隔 ${((times[1] - times[0]) / 1000).toFixed(1)}s`);

// ---------- 2) 客户端与工具（过期 token 自动刷新） ----------
console.log("\n== 2) Graph 客户端与工具 ==");
writeFileSync(HOME + "/tokens/outlook.json", JSON.stringify({
  accessToken: "ms-expired", refreshToken: "ms-old-rt", expiresAt: Date.now() - 1000, account: "me@outlook.com",
}));

const client = new GraphApiClient(outlookCfg);
const profile = await handleGetProfile(client);
check("profile 显示名/邮箱", profile.displayName === "张三" && profile.mail === "me@outlook.com");
check("过期 token 触发刷新", refreshCount === 1);

const search = await handleSearch(client, { query: "from:alice", top: 10, skip: 5 });
check("search 返回 2 条", search.messages.length === 2);
check("search $search 参数透传", lastSearchParam === "from:alice");
check("search 摘要含主题（中文）", search.messages[0].subject === "Outlook 测试主题");
check("search 摘要发件人格式化", search.messages[0].from === "微软团队 <noreply@microsoft.com>");
check("search 返回 nextLink", search.nextLink?.includes("$skiptoken=page2"));

const page2 = await handleSearch(client, { nextLink: search.nextLink });
check("nextLink 分页取到第二页", page2.messages.length === 1 && page2.messages[0].id === "ms3");
check("nextLink 请求路径正确", lastNextLinkPath.includes("$skiptoken=page2"));

const detail = await handleGet(client, { messageId: "ms1" });
check("get 正文", detail.body?.content === "<p>Outlook 正文</p>");
check("get to 收件人解析", detail.to[0] === "me@outlook.com");
check("get 附件过滤 referenceAttachment", detail.attachments.length === 2);
check("get 附件名", detail.attachments[0].name === "计划.txt");
check("get inline 标记", detail.attachments[1].isInline === true);

const att = await handleGetAttachment(client, { messageId: "ms1", attachmentId: "att1" });
check("附件 base64 解码", att.dataText === "hello outlook");

// ---------- 3) MCP 协议端到端 ----------
console.log("\n== 3) MCP 协议端到端 ==");
const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/cli.js", "outlook"],
  stderr: "inherit",
  env: {
    ...process.env,
    EMAIL_MCP_HOME: HOME,
    EMAIL_MCP_GRAPH_API_BASE: apiBase,
    EMAIL_MCP_MS_TOKEN_URL: apiBase + "/common/oauth2/v2.0/token",
    EMAIL_MCP_MS_DEVICECODE_URL: apiBase + "/common/oauth2/v2.0/devicecode",
    EMAIL_MCP_OUTLOOK_CLIENT_ID: outlookCfg.clientId,
  },
});
const mcp = new Client({ name: "smoke-m2", version: "0.0.1" });
await mcp.connect(transport);
const toolsList = await mcp.listTools();
check("listTools 返回 12 个工具", toolsList.tools.length === 12);
check("工具名均为 outlook_* 前缀", toolsList.tools.every((t) => t.name.startsWith("outlook_")));

const callSearch = await mcp.callTool({ name: "outlook_search", arguments: { query: "from:alice" } });
const sParsed = JSON.parse(callSearch.content[0].type === "text" ? callSearch.content[0].text : "{}");
check("callTool outlook_search ok=true", sParsed.ok === true && sParsed.data.messages.length === 2);

const callProfile = await mcp.callTool({ name: "outlook_get_profile", arguments: {} });
const pParsed = JSON.parse(callProfile.content[0].type === "text" ? callProfile.content[0].text : "{}");
check("callTool outlook_get_profile", pParsed.ok === true && pParsed.data.mail === "me@outlook.com");

const callBad = await mcp.callTool({ name: "outlook_get", arguments: { messageId: "missing" } });
const bParsed = JSON.parse(callBad.content[0].type === "text" ? callBad.content[0].text : "{}");
check("不存在消息返回 ok=false", bParsed.ok === false && bParsed.error?.message?.length > 0);

await mcp.close();
server.close();

console.log(failures === 0 ? "\n[smoke-m2] 全部通过 ✅" : `\n[smoke-m2] ${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
