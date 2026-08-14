// core 层冒烟：token 存取 + 凭据校验（含负面用例）
import { writeToken, readToken, hasToken, tokenExpiresIn, deleteToken } from "../dist/core/tokens.js";
import { validateProviderConfig, GMAIL_CLIENT_ID_RE, UUID_RE } from "../dist/core/config.js";

process.env.EMAIL_MCP_HOME = "/tmp/email-mcp-test";
let failures = 0;
const check = (name, cond) => {
  console.log(`  ${cond ? "✅" : "❌"} ${name}`);
  if (!cond) failures++;
};

// --- token 存取 ---
writeToken("gmail", { accessToken: "ya29.test", refreshToken: "1//test", expiresAt: Date.now() + 3600_000, account: "me@gmail.com" });
check("hasToken(gmail) = true", hasToken("gmail") === true);
const t = readToken("gmail");
check("readToken 字段完整", t?.accessToken === "ya29.test" && t.account === "me@gmail.com");
check("tokenExpiresIn > 0", (tokenExpiresIn("gmail") ?? 0) > 0);
writeToken("gmail", { accessToken: "x", expiresAt: Date.now() - 1000 });
check("过期 token 剩余为负", (tokenExpiresIn("gmail") ?? 0) < 0);
deleteToken("gmail");
check("deleteToken 后 hasToken = false", hasToken("gmail") === false);

// --- 凭据校验 ---
const goodGmail = { clientId: "1234567890-abcdef.apps.googleusercontent.com", scopes: ["gmail.readonly"], callbackPort: 8787 };
const badGmail = { clientId: "not-a-google-client", scopes: [], callbackPort: 99999 };
check("合法 gmail clientId 通过", validateProviderConfig("gmail", goodGmail).length === 0);
check("非法 gmail clientId 被拒", validateProviderConfig("gmail", badGmail).length === 3);
const goodOutlook = { clientId: "11111111-2222-3333-4444-555555555555", tenant: "common", scopes: ["Mail.Read"] };
const badOutlook = { clientId: "abc", tenant: "", scopes: [] };
check("合法 outlook clientId 通过", validateProviderConfig("outlook", goodOutlook).length === 0);
check("非法 outlook 被拒", validateProviderConfig("outlook", badOutlook).length === 3);
check("GMAIL 正则命中", GMAIL_CLIENT_ID_RE.test("1234567890-abc.apps.googleusercontent.com") === true);
check("UUID 正则命中", UUID_RE.test("11111111-2222-3333-4444-555555555555") === true);

console.log(failures === 0 ? "\n[smoke-core] 全部通过 ✅" : `\n[smoke-core] ${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
