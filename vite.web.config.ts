import { defineConfig, type Plugin } from 'vite'
import path from 'node:path'
import react from '@vitejs/plugin-react'

/**
 * 纯浏览器（非 Electron）开发/构建配置
 *
 * 与 vite.config.ts 的区别：移除了 vite-plugin-electron 插件，
 * 因此不会拉起 Electron 主进程，可作为普通 Web 应用在浏览器中运行。
 *
 * 用法：
 *   pnpm dev:web       # 浏览器开发服务器
 *   pnpm build:web     # 生产静态构建
 *   pnpm preview:web   # 预览静态构建
 *
 * 注意：浏览器模式下本地存图 / local-image:// 协议 / 文件对话框 /
 * 自动更新 / 示例种子不可用；图像视频生成受 CORS 限制。
 * 详见 docs/CODE_ANALYSIS.md 第 5、6 节。
 */

/**
 * Vite 插件：API CORS 代理
 *
 * 在开发服务器上注册 /__api_proxy 中间件，
 * 将浏览器端的外部 API 请求由服务端转发，绕过 CORS 限制。
 *
 * 用法（前端）：
 *   fetch('/__api_proxy?url=' + encodeURIComponent('https://example.com/api'))
 */
function apiCorsProxyPlugin(): Plugin {
  return {
    name: 'api-cors-proxy',
    configureServer(server) {
      server.middlewares.use('/__api_proxy', async (req, res) => {
        // 处理 OPTIONS 预检请求
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': '*',
          });
          res.end();
          return;
        }

        // 解析目标 URL
        const urlParam = new URL(req.url || '', 'http://localhost').searchParams.get('url');
        if (!urlParam) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing ?url= parameter' }));
          return;
        }

        try {
          // 读取请求体
          const bodyChunks: Buffer[] = [];
          for await (const chunk of req) {
            bodyChunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
          }
          const body = bodyChunks.length > 0 ? Buffer.concat(bodyChunks) : undefined;

          // 解包 x-proxy-headers 中的原始请求头
          const proxyHeadersRaw = req.headers['x-proxy-headers'];
          let forwardHeaders: Record<string, string> = {};
          if (typeof proxyHeadersRaw === 'string') {
            try {
              forwardHeaders = JSON.parse(proxyHeadersRaw);
            } catch { /* ignore parse errors */ }
          }

          // 服务端转发请求
          const response = await fetch(urlParam, {
            method: req.method || 'GET',
            headers: forwardHeaders,
            body: req.method !== 'GET' && req.method !== 'HEAD' ? body : undefined,
          });

          // 将远程响应转发回浏览器
          const respBody = await response.arrayBuffer();
          const headers: Record<string, string> = {
            'Access-Control-Allow-Origin': '*',
          };
          // 转发 content-type
          const ct = response.headers.get('content-type');
          if (ct) headers['Content-Type'] = ct;

          res.writeHead(response.status, headers);
          res.end(Buffer.from(respBody));
        } catch (err: any) {
          console.error('[api-cors-proxy] Proxy error:', err?.message || err);
          res.writeHead(502, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(JSON.stringify({ error: 'Proxy request failed', detail: err?.message }));
        }
      });
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@opencut/ai-core/services/prompt-compiler': path.resolve(__dirname, './src/packages/ai-core/services/prompt-compiler.ts'),
      '@opencut/ai-core/api/task-poller': path.resolve(__dirname, './src/packages/ai-core/api/task-poller.ts'),
      '@opencut/ai-core/protocol': path.resolve(__dirname, './src/packages/ai-core/protocol/index.ts'),
      '@opencut/ai-core': path.resolve(__dirname, './src/packages/ai-core/index.ts'),
    },
  },
  plugins: [
    apiCorsProxyPlugin(),
    react(),
  ],
})
