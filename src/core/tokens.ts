import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import type { Provider } from "./paths.js";
import { tokenPath, tokensDir } from "./paths.js";

export interface TokenRecord {
  accessToken: string;
  refreshToken?: string;
  /** 过期时间（epoch ms） */
  expiresAt?: number;
  account?: string;
  scope?: string;
}

export function readToken(provider: Provider): TokenRecord | null {
  const p = tokenPath(provider);
  if (!existsSync(p)) return null;
  try {
    const rec = JSON.parse(readFileSync(p, "utf8")) as TokenRecord;
    if (!rec?.accessToken) return null;
    return rec;
  } catch {
    return null;
  }
}

export function hasToken(provider: Provider): boolean {
  return readToken(provider) !== null;
}

/** token 剩余有效期（ms），无过期信息返回 null */
export function tokenExpiresIn(provider: Provider): number | null {
  const t = readToken(provider);
  if (!t?.expiresAt) return null;
  return t.expiresAt - Date.now();
}

/** 原子写入 token 文件（临时文件 + rename），权限 0600 */
export function writeToken(provider: Provider, rec: TokenRecord): void {
  mkdirSync(tokensDir(), { recursive: true });
  const finalPath = tokenPath(provider);
  const tmpPath = finalPath + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(rec, null, 2) + "\n", { mode: 0o600, encoding: "utf8" });
  try {
    chmodSync(tmpPath, 0o600);
  } catch {
    /* Windows 忽略 */
  }
  renameSync(tmpPath, finalPath);
}

export function deleteToken(provider: Provider): void {
  try {
    unlinkSync(tokenPath(provider));
  } catch {
    /* 不存在则忽略 */
  }
}
