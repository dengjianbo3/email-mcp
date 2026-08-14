import { spawn } from "node:child_process";
import { logger } from "./logger.js";

/** 打开系统浏览器（macOS/Linux/Windows），失败仅告警不阻塞 */
export function openBrowser(url: string): void {
  const platform = process.platform;
  try {
    if (platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else if (platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    logger.warn(`无法自动打开浏览器，请手动访问：${url}`);
  }
}
