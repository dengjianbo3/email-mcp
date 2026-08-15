import { existsSync } from "node:fs";
import {
  getProviderConfig,
  loadConfig,
  validateProviderConfig,
  type GmailConfig,
  type OutlookConfig,
} from "../core/config.js";
import { configPath, emailMcpHome, PROVIDERS } from "../core/paths.js";
import type { Provider } from "../core/paths.js";
import { readToken, tokenExpiresIn } from "../core/tokens.js";
import { gmailApiBase } from "../gmail/client.js";
import { GmailApiClient } from "../gmail/client.js";
import { GraphApiClient } from "../outlook/client.js";
import { graphApiBase } from "../outlook/oauth.js";
import { netFetch } from "../core/net.js";

/** 配置体检：配置/凭据/token/连通性/有效性，逐项检查并给出修复建议 */
export async function doctorCmd(): Promise<void> {
  console.log("\n===== email-mcp doctor =====\n");
  let ok = true;

  const report = (name: string, pass: boolean, detail: string, fix?: string) => {
    console.log(`  ${pass ? "✅" : "❌"} ${name}: ${detail}`);
    if (!pass) {
      ok = false;
      if (fix) console.log(`       建议: ${fix}`);
    }
  };

  // 1. 配置目录
  report("配置目录", true, emailMcpHome());

  // 2. 配置文件可解析
  let cfg;
  try {
    cfg = loadConfig();
    report("配置文件", existsSync(configPath()), existsSync(configPath()) ? "存在且可解析" : "不存在（可运行 setup 创建）");
  } catch (err) {
    const e = err as Error;
    report("配置文件", false, e.message, "运行 email-mcp setup <provider> 重建");
    console.log("\n结果: ❌ 存在配置解析问题，无法继续检查\n");
    process.exitCode = 1;
    return;
  }

  // 3. 各 provider 凭据 / token / 网络连通性 / token 有效性
  const gmailCfg = cfg.gmail as GmailConfig | undefined;
  const outlookCfg = cfg.outlook as OutlookConfig | undefined;
  const gmailBase = gmailApiBase();
  const graphBase = graphApiBase();

  if (gmailCfg?.clientId || outlookCfg?.clientId) {
    const checks = [
      { name: "Gmail API 网络", url: gmailBase, enabled: !!gmailCfg?.clientId },
      { name: "Microsoft Graph 网络", url: graphBase, enabled: !!outlookCfg?.clientId },
    ];
    for (const c of checks) {
      if (!c.enabled) continue;
      try {
        const res = await netFetch(c.url + "/", { method: "GET", signal: AbortSignal.timeout(6000) });
        report(c.name, true, `可达（HTTP ${res.status}）`);
      } catch (err) {
        const cause = (err as { cause?: { message?: string } }).cause;
        report(c.name, false, `不可达：${cause?.message ?? (err as Error).message}`, "请检查网络/代理设置");
      }
    }
  }

  for (const provider of PROVIDERS) {
    const pc = getProviderConfig(cfg, provider);
    if (!pc?.clientId) {
      report(provider + " 凭据", false, "未配置", "运行 email-mcp setup " + provider);
      continue;
    }
    const errs = validateProviderConfig(provider, pc);
    report(provider + " 凭据", errs.length === 0, errs.length === 0 ? "格式正确" : errs.join("；"), "重新运行 email-mcp setup " + provider);

    const tok = readToken(provider);
    if (!tok) {
      report(provider + " 授权", false, "无 token", "运行 email-mcp setup " + provider + " 完成 OAuth 授权");
      continue;
    }
    const left = tokenExpiresIn(provider);
    report(
      provider + " 授权",
      left === null || left > 0,
      left === null ? "已授权（无过期信息）" : left > 0 ? `已授权，token 剩余约 ${Math.round(left / 60000)} 分钟` : "token 已过期",
      left !== null && left <= 0 ? "启动时会自动刷新；失败则重跑 email-mcp setup " + provider : undefined
    );

    // token 有效性：静默调用一次只读 API 验证
    try {
      if (provider === "gmail") {
        const profile = await new GmailApiClient(pc as GmailConfig).getProfile();
        report(provider + " 有效性", true, `token 有效（账号 ${profile.emailAddress}）`);
      } else {
        const profile = await new GraphApiClient(pc as OutlookConfig).getProfile();
        report(provider + " 有效性", true, `token 有效（账号 ${profile.mail ?? profile.userPrincipalName ?? "?"}）`);
      }
    } catch (err) {
      const e = err as Error & { hint?: string };
      report(provider + " 有效性", false, e.message, e.hint ?? "重新运行 email-mcp setup " + provider);
    }
  }

  console.log(`\n结果: ${ok ? "✅ 全部通过" : "❌ 存在问题，请按上述建议修复"}\n`);
  process.exitCode = ok ? 0 : 1;
}
