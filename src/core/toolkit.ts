import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EmailMcpError } from "./errors.js";
import { confirmGate } from "./confirm.js";

export type ToolResult = { content: { type: "text"; text: string }[] };

export function ok<T>(data: T): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, data }) }] };
}

export function fail(err: unknown): ToolResult {
  const e = err as EmailMcpError;
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ok: false,
          error: { code: "email_mcp_error", message: e.message ?? String(err), hint: e.hint },
        }),
      },
    ],
  };
}

export type ToolHandler<A> = (args: A) => Promise<unknown>;

/**
 * 注册"敏感操作"工具（发送/删除等）：confirm 门控 + 统一 ok/fail 包装。
 * 说明：SDK 的 registerTool 泛型无法从 Record schema 推导回调类型，
 * 运行时传 zod shape 完全安全，此处用 any 桥接类型系统。
 */
export function registerSensitiveTool<A extends { confirm?: boolean }>(
  server: McpServer,
  name: string,
  title: string,
  description: string,
  inputSchema: Record<string, unknown>,
  cb: ToolHandler<A>,
  preview: (args: A) => string
): void {
  // 注意：必须保持 server.registerTool(...) 成员调用形式（解构方法会丢失 this）
  const register = server.registerTool.bind(server) as unknown as (
    n: string,
    c: { title?: string; description?: string; inputSchema: Record<string, unknown> },
    cb: (a: A) => Promise<unknown>
  ) => void;
  register(name, { title, description, inputSchema }, async (a: A) => {
    try {
      const gate = confirmGate(a.confirm, preview(a));
      if (gate) return { content: [{ type: "text", text: JSON.stringify(gate) }] };
      return ok(await cb(a));
    } catch (err) {
      return fail(err);
    }
  });
}
