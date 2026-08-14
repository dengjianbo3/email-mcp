import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GraphApiClient } from "./client.js";
import { registerOutlookTools, registerOutlookWriteTools } from "./tools.js";

export function createOutlookServer(client: GraphApiClient): McpServer {
  const server = new McpServer({
    name: "email-mcp-outlook",
    version: "0.2.0",
  });
  registerOutlookTools(server, client);
  registerOutlookWriteTools(server, client);
  return server;
}
