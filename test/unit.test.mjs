// 单元测试（node --test）：MIME 构造 / 配置校验 / confirm 门控 / 脱敏
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRfc822 } from "../dist/gmail/client.js";
import { validateProviderConfig, GMAIL_CLIENT_ID_RE, UUID_RE } from "../dist/core/config.js";
import { confirmGate } from "../dist/core/confirm.js";
import { maskId, maskToken } from "../dist/core/mask.js";

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

test("buildRfc822: 基本头部（To/Cc/Subject/Date/MIME-Version）", () => {
  const raw = Buffer.from(buildRfc822({ to: ["a@b.com", "c@d.com"], cc: ["e@f.com"], subject: "hello", body: "hi" }), "base64url").toString("utf8");
  assert.ok(raw.includes("To: a@b.com, c@d.com"));
  assert.ok(raw.includes("Cc: e@f.com"));
  assert.ok(raw.includes("Subject: hello"));
  assert.ok(raw.includes("MIME-Version: 1.0"));
  assert.ok(raw.includes("multipart/mixed"));
});

test("buildRfc822: 中文主题走 RFC2047 编码", () => {
  const raw = Buffer.from(buildRfc822({ to: ["a@b.com"], subject: "中文主题", body: "x" }), "base64url").toString("utf8");
  assert.ok(raw.includes("=?UTF-8?B?"), "应包含 RFC2047 前缀");
  const m = raw.match(/=\?UTF-8\?B\?([^?]+)\?=/);
  const decoded = m ? Buffer.from(m[1], "base64").toString("utf8") : "";
  assert.equal(decoded, "中文主题");
});

test("buildRfc822: 正文与附件 base64 可还原", () => {
  const raw = Buffer.from(
    buildRfc822({ to: ["a@b.com"], subject: "s", body: "你好世界", attachments: [{ filename: "f.txt", mimeType: "text/plain", dataBase64: b64("FILE") }] }),
    "base64url"
  ).toString("utf8");
  assert.ok(raw.includes(b64("你好世界")), "正文 base64 应在 MIME 中");
  assert.ok(raw.includes(b64("FILE")), "附件 base64 应在 MIME 中");
  assert.ok(raw.includes('name="f.txt"'), "附件文件名");
});

test("validateProviderConfig: Gmail 正反例", () => {
  assert.equal(validateProviderConfig("gmail", { clientId: "12345-x.apps.googleusercontent.com", scopes: ["gmail.readonly"], callbackPort: 8787 }).length, 0);
  const errs = validateProviderConfig("gmail", { clientId: "bad", scopes: [], callbackPort: 99999 });
  assert.ok(errs.length >= 2);
});

test("validateProviderConfig: Outlook 正反例", () => {
  assert.equal(validateProviderConfig("outlook", { clientId: "11111111-2222-3333-4444-555555555555", tenant: "common", scopes: ["Mail.Read"] }).length, 0);
  const errs = validateProviderConfig("outlook", { clientId: "not-uuid", tenant: "", scopes: [] });
  assert.ok(errs.length >= 3);
});

test("GMAIL_CLIENT_ID_RE / UUID_RE", () => {
  assert.ok(GMAIL_CLIENT_ID_RE.test("1234567890-abcdef.apps.googleusercontent.com"));
  assert.ok(!GMAIL_CLIENT_ID_RE.test("abc"));
  assert.ok(UUID_RE.test("11111111-2222-3333-4444-555555555555"));
});

test("confirmGate: true 放行 / 缺失拒绝", () => {
  assert.equal(confirmGate(true, "preview"), null);
  const denied = confirmGate(undefined, "发送邮件");
  assert.equal(denied?.ok, false);
  assert.equal(denied?.error.code, "confirmation_required");
  assert.ok(denied?.error.message.includes("发送邮件"));
});

test("mask: 只保留后 4 位", () => {
  assert.equal(maskId("1234567890-abc.apps.googleusercontent.com"), "****.com");
  assert.equal(maskId(undefined), "(未配置)");
  assert.equal(maskToken("abcdefghijkl"), "****ijkl");
});
