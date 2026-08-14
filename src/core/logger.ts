export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: LogLevel[] = ["debug", "info", "warn", "error"];

function parseLevel(): LogLevel {
  const v = process.env.EMAIL_MCP_LOG?.toLowerCase().trim();
  return (v && (LEVEL_ORDER as string[]).includes(v) ? v : "info") as LogLevel;
}

let minLevel: LogLevel = parseLevel();
let stderrOnly = false;

/** MCP server 模式：全部日志走 stderr，stdout 只留协议数据 */
export function useStderrMode(): void {
  stderrOnly = true;
}

function log(level: LogLevel, msg: string): void {
  if (LEVEL_ORDER.indexOf(level) < LEVEL_ORDER.indexOf(minLevel)) return;
  const line = `[email-mcp] [${level.toUpperCase()}] ${msg}`;
  if (stderrOnly || level === "error") console.error(line);
  else console.log(line);
}

/** 统一日志（MCP server 模式下全部走 stderr，避免污染协议通道） */
export const logger = {
  debug: (m: string) => log("debug", m),
  info: (m: string) => log("info", m),
  warn: (m: string) => log("warn", m),
  error: (m: string) => log("error", m),
};
