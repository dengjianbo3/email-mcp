import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Request, Response } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { logger } from "./logger.js";

export interface HttpServerHandle {
  close: () => Promise<void>;
}

interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

/**
 * 启动 streamable HTTP MCP server（默认仅监听 127.0.0.1，带 DNS rebinding 防护）。
 * 多会话模型：每个会话独立 McpServer 实例 + transport（SDK 的 server.connect 仅支持单连接）。
 */
export async function startHttpServer(
  port: number,
  serverFactory: () => McpServer,
  host = "127.0.0.1"
): Promise<HttpServerHandle> {
  const app = createMcpExpressApp({ host });
  const sessions = new Map<string, Session>();

  const handleRequest = async (req: Request, res: Response, body?: unknown): Promise<void> => {
    const sessionId = (req.headers["mcp-session-id"] as string | undefined) ?? undefined;
    const existing = sessionId ? sessions.get(sessionId) : undefined;

    if (existing) {
      await existing.transport.handleRequest(req, res, body);
      return;
    }
    // 无会话：仅 POST 可建立（initialize）
    if (req.method !== "POST") {
      res.status(404).json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" } });
      return;
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (sid) => {
        sessions.set(sid, { server, transport });
        logger.debug(`MCP HTTP 会话建立: ${sid}`);
      },
      onsessionclosed: (sid) => {
        sessions.delete(sid);
        logger.debug(`MCP HTTP 会话关闭: ${sid}`);
      },
    });
    const server = serverFactory();
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };

  const fail = (res: Response, err: unknown) => {
    logger.error(`HTTP 请求处理失败: ${(err as Error)?.message ?? err}`);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" } });
    else res.end();
  };

  app.post("/mcp", (req: Request, res: Response) => void handleRequest(req, res, req.body).catch((e) => fail(res, e)));
  app.get("/mcp", (req: Request, res: Response) => void handleRequest(req, res).catch((e) => fail(res, e)));
  app.delete("/mcp", async (req: Request, res: Response) => {
    try {
      await handleRequest(req, res);
    } catch (e) {
      fail(res, e);
    }
  });

  const httpServer: Server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => resolve());
  });

  logger.info(`HTTP MCP server 已启动: http://${host}:${port}/mcp`);
  return {
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sessions.values()) void s.server.close().catch(() => {});
        sessions.clear();
        httpServer.close(() => resolve());
      }),
  };
}
