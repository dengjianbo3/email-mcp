// setup 向导回归：交互收集凭据（inject 模拟）→ 落盘 → 已有 token 复用 → 账号校验（mock API）
// 注意：inject 注入的是"最终答案"——toggle 需注入布尔值 true/false
import prompts from "prompts";
import { createServer } from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { setupProvider } from "../dist/commands/setup.js";

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${extra ? " — " + extra : ""}`);
  if (!cond) failures++;
};

const HOME = "/tmp/email-mcp-setup";
rmSync(HOME, { recursive: true, force: true });
mkdirSync(HOME + "/tokens", { recursive: true });

// mock：Gmail profile + Graph /me（setup 授权后的账号校验用）
const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  res.writeHead(200, { "Content-Type": "application/json" });
  if (url.pathname === "/gmail/v1/users/me/profile") {
    res.end(JSON.stringify({ emailAddress: "me@gmail.com", messagesTotal: 1, threadsTotal: 1, historyId: "h" }));
  } else if (url.pathname === "/v1.0/me") {
    res.end(JSON.stringify({ displayName: "张三", mail: "me@outlook.com", userPrincipalName: "me@outlook.com" }));
  } else {
    res.end(JSON.stringify({}));
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const apiBase = `http://127.0.0.1:${server.address().port}`;
console.log(`[mock] ${apiBase}\n`);

process.env.EMAIL_MCP_HOME = HOME;
process.env.EMAIL_MCP_GMAIL_API_BASE = apiBase;
process.env.EMAIL_MCP_GRAPH_API_BASE = apiBase;

// 预写有效 token（复用路径：跳过浏览器授权，直接校验账号）
writeFileSync(HOME + "/tokens/gmail.json", JSON.stringify({ accessToken: "gt", refreshToken: "grt", expiresAt: Date.now() + 3600_000 }));
writeFileSync(HOME + "/tokens/outlook.json", JSON.stringify({ accessToken: "ot", refreshToken: "ort", expiresAt: Date.now() + 3600_000 }));

// --- Gmail 向导：自定义 scopes ---
prompts.inject([
  "1234567890-abcdef.apps.googleusercontent.com",
  "",                          // clientSecret 留空
  false,                       // 自定义 scopes
  "gmail.readonly gmail.send",
]);
await setupProvider("gmail");

// --- Outlook 向导：默认 scopes ---
prompts.inject([
  "11111111-2222-3333-4444-555555555555",
  "common",
  true,
]);
await setupProvider("outlook");

const cfg = JSON.parse((await import("node:fs")).readFileSync(HOME + "/config.json", "utf8"));
check("gmail 自定义 scopes 落盘", JSON.stringify(cfg.gmail.scopes) === JSON.stringify(["gmail.readonly", "gmail.send"]));
check("gmail account 由校验回填", cfg.gmail.account === "me@gmail.com");
check("outlook 默认 scopes 落盘", cfg.outlook.scopes.includes("Mail.ReadWrite") && cfg.outlook.scopes.includes("offline_access"));
check("outlook account 由校验回填", cfg.outlook.account === "me@outlook.com");

server.close();
console.log(failures === 0 ? "\n[smoke-setup] 全部通过 ✅" : `\n[smoke-setup] ${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
