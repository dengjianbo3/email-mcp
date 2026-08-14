/** 统一错误类型：message 为用户可读信息，hint 为修复建议 */
export class EmailMcpError extends Error {
  readonly hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = "EmailMcpError";
    this.hint = hint;
  }
}
