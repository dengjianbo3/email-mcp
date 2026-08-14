/** 脱敏显示 clientId / 账号（仅保留后 4 位） */
export function maskId(id: string | undefined | null, label = "(未配置)"): string {
  if (!id) return label;
  const s = id.trim();
  if (s.length <= 8) return "****";
  return `****${s.slice(-4)}`;
}

/** 脱敏显示 token */
export function maskToken(tok: string | undefined | null, label = "(无)"): string {
  if (!tok) return label;
  if (tok.length <= 8) return "****";
  return `****${tok.slice(-4)}`;
}

/** 从对象中剔除敏感字段（用于打印/日志前的拷贝） */
export function redact<T extends Record<string, unknown>>(obj: T, sensitiveKeys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...obj };
  for (const k of sensitiveKeys) {
    if (k in out) out[k] = "****";
  }
  return out;
}
