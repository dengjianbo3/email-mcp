/** 发送/删除等敏感操作的确认门控：
 *  - confirm === true  → 放行（返回 null）
 *  - 其余情况         → 返回"需确认"结果，提示调用方携带 confirm: true 重试
 */
export interface ConfirmationResult {
  ok: false;
  error: { code: "confirmation_required"; message: string; hint: string };
}

export function confirmGate(confirm: boolean | undefined, preview: string): ConfirmationResult | null {
  if (confirm === true) return null;
  return {
    ok: false,
    error: {
      code: "confirmation_required",
      message: `操作需要确认：${preview}`,
      hint: "如确认无误，请携带 confirm: true 重新调用本工具",
    },
  };
}
