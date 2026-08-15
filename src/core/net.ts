import { ProxyAgent, fetch as undiciFetch } from "undici";

/**
 * 网络层封装：
 * - 环境存在 HTTP(S)_PROXY（如 Clash 7890）时，Google/Microsoft 端点走代理
 *   （undici 默认不读代理环境变量，导致 OAuth token 交换/API 调用超时）；
 * - 本地回环地址（127.0.0.1/localhost，测试 mock 服务器）始终直连。
 */
let proxyDispatcher: ProxyAgent | undefined;

function getProxyDispatcher(): ProxyAgent | undefined {
  if (proxyDispatcher !== undefined) return proxyDispatcher;
  const proxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy;
  if (!proxy) {
    proxyDispatcher = null as unknown as undefined;
    return undefined;
  }
  try {
    proxyDispatcher = new ProxyAgent(proxy);
  } catch {
    proxyDispatcher = null as unknown as undefined;
  }
  return proxyDispatcher;
}

/** 统一 fetch：外部地址走代理（若有），本地回环直连 */
export function netFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const u = new URL(String(input));
  const isLocal = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "::1";
  const dispatcher = isLocal ? undefined : getProxyDispatcher();
  // undici 的 fetch 类型与 lib.dom 存在泛型差异，运行时完全兼容，此处做类型桥接
  return undiciFetch(
    input as unknown as Parameters<typeof undiciFetch>[0],
    (dispatcher ? { ...init, dispatcher } : init) as unknown as Parameters<typeof undiciFetch>[1]
  ) as unknown as Promise<Response>;
}

/** 兼容旧名：进程早期启用环境代理支持（已由 ProxyAgent 替代，保留以防 Node 原生 fetch 路径） */
export function ensureProxyEnv(): void {
  process.env.NODE_USE_ENV_PROXY = "1";
}
