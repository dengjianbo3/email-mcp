import { getProviderConfig, loadConfig } from "../core/config.js";
import { emailMcpHome } from "../core/paths.js";
import type { Provider } from "../core/paths.js";
import { maskId } from "../core/mask.js";
import { readToken, tokenExpiresIn } from "../core/tokens.js";

/** 查看各服务配置状态（脱敏显示） */
export function statusCmd(): void {
  const cfg = loadConfig();
  console.log(`\n配置目录: ${emailMcpHome()}\n`);

  for (const provider of ["gmail", "outlook"] as Provider[]) {
    const pc = getProviderConfig(cfg, provider);
    console.log(`[${provider}]`);
    if (!pc?.clientId) {
      console.log("  凭据  : 未配置");
      console.log("  授权  : —");
      console.log("  修复  : email-mcp setup " + provider + "\n");
      continue;
    }
    console.log(`  凭据  : 已配置 (clientId ${maskId(pc.clientId)})`);
    const tok = readToken(provider);
    if (tok?.accessToken) {
      console.log(`  授权  : 已授权${tok.account ? ` (${tok.account})` : ""}`);
      const left = tokenExpiresIn(provider);
      console.log(
        `  token : ${left === null ? "无过期信息" : left > 0 ? `剩余约 ${Math.round(left / 60000)} 分钟` : "已过期（将自动刷新，失败则需重跑 setup）"}`
      );
    } else {
      console.log("  授权  : 未授权（运行 email-mcp setup " + provider + " 完成 OAuth 授权）");
    }
    console.log("");
  }
}
