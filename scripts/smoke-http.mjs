// M4 冒烟：HTTP（streamable HTTP）模式端到端 —— 真实 spawn CLI + SDK HTTP Client
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${extra ? " — " + extra : ""}`);
  if (!cond) failures++;
};

const HOME = "/tmp/email-mcp-http";
rmSync(HOME, { recursive: true, force: true });
mkdirSync(HOME + "/tokens", { recursive: true });

// mock Gmail API（只读简版）
const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  res.writeHead(200, { "Content-Type": "application/json" });
  if (url.pathname === "/gmail/v1/users/me/profile") {
    res.end(JSON.stringify({ emailAddress: "me@gmail.com", messagesTotal: 42, threadsTotal: 40, historyId: "h1" }));
  } else if (url.pathname === "/gmail/v1/users/me/messages") {
    res.end(JSON.stringify({ messages: [{ id: "msg1", threadId: "th1" }], nextPageToken: "p2", resultSizeEstimate: 1 }));
  } else if (url.pathname === "/gmail/v1/users/me/messages/msg1" && url.searchParams.get("format") === "metadata") {
    res.end(JSON.stringify({ id: "msg1", threadId: "th1", snippet: "s", payload: { headers: [
      { name: "From", value: "A <a@b.com>" }, { name: "Subject", value: "主题" }, { name: "Date", value: "Tue, 14 Aug 2025 10:00:00 +0800" },
    ] } }));
  } else {
    res.end(JSON.stringify({ error: "mock_unknown:" + url.pathname }));
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const apiBase = `http://127.0.0.1:${server.address().port}`;
console.log(`[mock] ${apiBase}\n`);

writeFileSync(HOME + "/tokens/gmail.json", JSON.stringify({ accessToken: "gt", refreshToken: "grt", expiresAt: Date.now() + 3600_000 }));
writeFileSync(HOME + "/config.json", JSON.stringify({
  version: 1,
  gmail: { clientId: "1234567890-abcdef.apps.googleusercontent.com", clientSecret: "s", scopes: ["gmail.readonly"], callbackPort: 8787 },
}));

const HTTP_PORT = 18788;

// 启动 HTTP 模式 server（子进程）
const child = spawn("node", ["dist/cli.js", "gmail", "--transport", "http", "--port", String(HTTP_PORT)], {
  env: { ...process.env, EMAIL_MCP_HOME: HOME, EMAIL_MCP_GMAIL_API_BASE: apiBase },
  stdio: ["ignore", "inherit", "inherit"],
});

// 等待端口就绪
let ready = false;
for (let i = 0; i < 50; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/mcp`, { method: "GET" });
    if (res.status === 404 || res.status === 400) { ready = true; break; }
  } catch { /* 未就绪 */ }
  await new Promise((r) => setTimeout(r, 200));
}
check("HTTP server 端口就绪", ready);

// 关闭子进程的辅助
const stop = () =>
  new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill("SIGTERM");
    setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 3000);
  });

try {
  // SDK HTTP Client 连接
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${HTTP_PORT}/mcp`));
  const mcp = new Client({ name: "smoke-http", version: "0.0.1" });
  await mcp.connect(transport);
  check("HTTP 握手成功（initialize）", true);

  const tools = await mcp.listTools();
  check("listTools 12 个 gmail_* 工具", tools.tools.length === 12 && tools.tools.every((t) => t.name.startsWith("gmail_")));

  const call = await mcp.callTool({ name: "gmail_search", arguments: { query: "from:a", maxResults: 5 } });
  const parsed = JSON.parse(call.content[0].type === "text" ? call.content[0].text : "{}");
  check("callTool gmail_search ok=true", parsed.ok === true && parsed.data.messages.length === 1);

  const callProfile = await mcp.callTool({ name: "gmail_get_profile", arguments: {} });
  const pp = JSON.parse(callProfile.content[0].type === "text" ? callProfile.content[0].text : "{}");
  check("callTool gmail_get_profile", pp.ok === true && pp.data.emailAddress === "me@gmail.com");

  await mcp.close();
} catch (err) {
  check("HTTP 会话流程", false, err instanceof Error ? err.message : String(err));
} finally {
  await stop();
}
server.close();

console.log(failures === 0 ? "\n[smoke-http] 全部通过 ✅" : `\n[smoke-http] ${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
