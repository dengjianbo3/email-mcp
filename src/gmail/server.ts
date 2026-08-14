import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GmailApiClient } from "./client.js";
import { registerGmailTools, registerGmailWriteTools } from "./tools.js";

export function createGmailServer(client: GmailApiClient): McpServer {
  const server = new McpServer({
    name: "email-mcp-gmail",
    version: "0.2.0",
  });
  registerGmailTools(server, client);
  registerGmailWriteTools(server, client);
  return server;
}
