// email-mcp 命令行测试控制台：连接真实 MCP server 并调用工具
// 用法:
//   node scripts/mcp-console.mjs <gmail|outlook> list
//   node scripts/mcp-console.mjs <gmail|outlook> <tool> '<json 参数>'
// 示例:
//   node scripts/mcp-console.mjs gmail list
//   node scripts/mcp-console.mjs gmail gmail_get_profile '{}'
//   node scripts/mcp-console.mjs gmail gmail_search '{"query":"is:unread","maxResults":5}'
//   node scripts/mcp-console.mjs outlook outlook_create_draft '{"to":"me@outlook.com","subject":"测试","body":"你好"}'
// 注意: 发送/删除类工具需带 "confirm": true
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [provider, tool, argsJson] = process.argv.slice(2);

if (!provider || !["gmail", "outlook"].includes(provider)) {
  console.log(`用法: node scripts/mcp-console.mjs <gmail|outlook> <list|工具名> '<JSON 参数>'`);
  process.exit(1);
}

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/cli.js", provider],
  stderr: "inherit",
});
const client = new Client({ name: "mcp-console", version: "0.1.0" });
try {
  await client.connect(transport);
} catch (err) {
  console.error(`\n❌ 无法连接 ${provider} server（请查看上方 server 输出）`);
  console.error("   常见原因：未配置/未授权 → 先运行 email-mcp setup " + provider);
  process.exit(1);
}

if (tool === "list") {
  const t = await client.listTools();
  console.log(`\n${t.tools.length} 个工具:`);
  for (const x of t.tools) console.log(`  - ${x.name}    ${x.title ?? ""}`);
} else if (!tool) {
  console.log("请指定工具名（list 查看全部）");
} else {
  let args = {};
  if (argsJson) {
    try {
      args = JSON.parse(argsJson);
    } catch {
      console.error("❌ 参数必须是合法 JSON");
      process.exit(1);
    }
  }
  console.log(`\n==> 调用 ${tool} ${argsJson ?? "{}"}\n`);
  const res = await client.callTool({ name: tool, arguments: args });
  const text = res.content[0]?.type === "text" ? res.content[0].text : JSON.stringify(res.content);
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text);
  }
}

await client.close();
