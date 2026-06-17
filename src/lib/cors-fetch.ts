// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// Commercial licensing available. See COMMERCIAL_LICENSE.md.
/**
 * CORS 统一解决方案
 *
 * 运行环境自动检测：
 * - Electron 桌面模式 → 原生 fetch()（无 CORS 限制）
 * - 浏览器开发模式   → 全局劫持 fetch()，把所有跨域请求改写为经 Vite
 *                      开发服务器 /__api_proxy?url=... 中间件转发，绕过 CORS
 * - 浏览器生产模式   → 原生 fetch()（需后端/Nginx 提供反向代理）
 *
 * `installCorsProxy()` 在 web 开发模式下全局替换 `window.fetch`，因此
 * 任何代码（包括第三方库与未使用 `corsFetch` 的原生 fetch 调用）发出的
 * 跨域请求都会被自动代理，无需逐个改写调用点。
 */

/** window 上的运行时增强字段（Electron 注入 / 本模块的安装标记） */
type AugmentedWindow = Window & {
  electron?: unknown;
  ipcRenderer?: unknown;
  __corsProxyInstalled?: boolean;
};

function augmentedWindow(): AugmentedWindow {
  return window as AugmentedWindow;
}

/** 检测是否在 Electron 环境中运行 */
function isElectron(): boolean {
  if (typeof window === 'undefined') return false;
  const w = augmentedWindow();
  return !!(w.electron || w.ipcRenderer);
}

/** 检测是否在 Vite 开发服务器中运行 */
function isViteDev(): boolean {
  return import.meta.env?.DEV === true;
}

/** 是否需要代理：仅跨域的 http(s) 绝对地址才需要绕过 CORS */
function shouldProxyUrl(rawUrl: string): boolean {
  if (!rawUrl || typeof window === 'undefined') return false;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl, window.location.href);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  // 同源（含相对路径、/__api_proxy 自身、HMR、静态资源）无需代理
  if (parsed.origin === window.location.origin) return false;
  return true;
}

/** 解析 fetch 入参，得到目标 URL 字符串 */
function resolveRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  // Request 对象
  return (input as Request).url;
}

/**
 * 将一次跨域请求改写为经 /__api_proxy 转发的请求。
 * 通过 saved native fetch 发出，避免递归调用被劫持的 window.fetch。
 */
async function proxiedFetch(
  nativeFetch: typeof fetch,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const targetUrl = resolveRequestUrl(input);
  const req = input instanceof Request ? input : null;

  const method = (init?.method || req?.method || 'GET').toUpperCase();

  // 合并原始请求头（Request.headers 为底，init.headers 覆盖）
  const headers = new Headers(req?.headers || undefined);
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  }
  const originalHeaders: Record<string, string> = {};
  headers.forEach((value, key) => {
    // 这些头由浏览器/代理端重新计算，不应透传
    if (key === 'content-length' || key === 'host' || key === 'connection') return;
    originalHeaders[key] = value;
  });

  // 提取请求体（GET/HEAD 无体）
  let body: BodyInit | undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    if (init?.body != null) {
      body = init.body as BodyInit;
    } else if (req && req.body != null) {
      // Request 自带 body：克隆后取原始字节，保留 multipart 边界
      body = await req.clone().arrayBuffer();
    }
  }

  const proxyUrl = `/__api_proxy?url=${encodeURIComponent(targetUrl)}`;

  // 注意：不要在此设置 Content-Type。让浏览器按 body 类型自动生成
  // （FormData 会带 multipart 边界），代理端据此正确转发。原始 Content-Type
  // 已包含在 x-proxy-headers 中，由代理端优先使用。
  return nativeFetch(proxyUrl, {
    method,
    headers: {
      'x-proxy-headers': JSON.stringify(originalHeaders),
    },
    body,
  });
}

/**
 * 在浏览器开发模式下全局安装 CORS 代理（替换 window.fetch）。
 * 幂等：重复调用无副作用。Electron / 非开发环境下为空操作。
 */
export function installCorsProxy(): void {
  if (typeof window === 'undefined') return;
  if (isElectron() || !isViteDev()) return;
  const w = augmentedWindow();
  if (w.__corsProxyInstalled) return;
  w.__corsProxyInstalled = true;

  const nativeFetch = window.fetch.bind(window);

  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    try {
      const url = resolveRequestUrl(input);
      if (!shouldProxyUrl(url)) return nativeFetch(input, init);
      return proxiedFetch(nativeFetch, input, init);
    } catch {
      // 任何改写异常都回退到原生 fetch，保证不破坏正常请求
      return nativeFetch(input, init);
    }
  };

  console.info('[cors-proxy] 已启用：跨域请求将经 /__api_proxy 转发（web 开发模式）');
}

/**
 * CORS 安全的 fetch 封装（向后兼容）。
 *
 * 全局拦截器安装后，原生 `fetch` 已具备代理能力，因此此封装仅
 * 委托给（可能已被劫持的）全局 `fetch`，无需额外逻辑。保留导出以
 * 兼容现有调用点。
 */
export async function corsFetch(
  url: string | URL,
  init?: RequestInit,
): Promise<Response> {
  return fetch(url.toString(), init);
}
