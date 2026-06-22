#!/usr/bin/env node
/**
 * 一次性修复脚本：把历史"受保护远程视频 URL"下载到本地，并改写项目数据引用。
 *
 * 背景：换 look2eye API 后，视频内容地址形如
 *   https://ai.silkroadai.io/v1/videos/{taskId}/content
 * 需带 Authorization 才能访问。早期生成的视频因下载 401 失败，
 * 数据里存的仍是该远程地址，本地无文件，导致无法预览/导出。
 *
 * 用法（在项目根目录）：
 *   LOOK2EYE_KEY=你的Key node scripts/fix-protected-videos.mjs
 *   # 预演（只看不改）：加 --dry-run
 *
 * 安全：Key 仅从环境变量读取，不写入任何文件；脚本只改写本地 JSON。
 * 改写前会把原 JSON 备份为 <file>.bak-<时间戳>。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import http from 'node:http';

const DRY_RUN = process.argv.includes('--dry-run');
const API_KEY = process.env.LOOK2EYE_KEY || '';

// macOS 默认数据根目录（与 electron app.getPath('userData') 一致）
const APP_DATA = path.join(os.homedir(), 'Library', 'Application Support', '魔因漫创');
const PROJECTS_ROOT = path.join(APP_DATA, 'projects');
const MEDIA_VIDEOS_DIR = path.join(APP_DATA, 'media', 'videos');

// 受保护视频内容端点：/v1/videos/{id}/content
const PROTECTED_RE = /https?:\/\/[^"'\s]*\/videos\/[^/"'\s]+\/content\/?/gi;

if (!API_KEY && !DRY_RUN) {
  console.error('错误：未设置 LOOK2EYE_KEY 环境变量。');
  console.error('用法：LOOK2EYE_KEY=你的Key node scripts/fix-protected-videos.mjs [--dry-run]');
  process.exit(1);
}

// 带鉴权下载 URL 到本地文件，跟随重定向。校验 Content-Length 确保完整。
function downloadOnce(url, filePath, redirects = 5) {
  return new Promise((resolve, reject) => {
    if (redirects <= 0) return reject(new Error('Too many redirects'));
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { Authorization: `Bearer ${API_KEY}` } }, (res) => {
      const status = res.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
        res.resume();
        return downloadOnce(res.headers.location, filePath, redirects - 1).then(resolve).catch(reject);
      }
      if (status !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${status}`));
      }
      const expected = parseInt(res.headers['content-length'] || '0', 10);
      const file = fs.createWriteStream(filePath);
      res.pipe(file);
      file.on('finish', () => file.close(() => {
        // 校验下载大小与 Content-Length 一致，避免中断留下残缺文件
        const actual = fs.statSync(filePath).size;
        if (expected > 0 && actual !== expected) {
          fs.unlink(filePath, () => {});
          return reject(new Error(`不完整：收到 ${actual}/${expected} 字节`));
        }
        if (actual === 0) {
          fs.unlink(filePath, () => {});
          return reject(new Error('空文件'));
        }
        resolve();
      }));
      file.on('error', (e) => { fs.unlink(filePath, () => {}); reject(e); });
    });
    req.on('error', (e) => { fs.unlink(filePath, () => {}); reject(e); });
    // 60s 无响应视为超时
    req.setTimeout(60000, () => { req.destroy(new Error('超时')); });
  });
}

// 下载并自动重试（应对 ECONNRESET 等瞬时网络错误）
async function download(url, filePath, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      await downloadOnce(url, filePath);
      return;
    } catch (e) {
      lastErr = e;
      if (i < attempts) {
        process.stdout.write(`重试(${i}/${attempts - 1})... `);
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }
  throw lastErr;
}

// 递归列出某目录下所有指定文件名的 JSON
function findJsonFiles(dir, names) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findJsonFiles(full, names));
    else if (names.includes(entry.name)) out.push(full);
  }
  return out;
}

async function main() {
  fs.mkdirSync(MEDIA_VIDEOS_DIR, { recursive: true });

  const files = findJsonFiles(PROJECTS_ROOT, ['director.json', 'timeline.json', 'media.json']);
  console.log(`扫描到 ${files.length} 个数据文件${DRY_RUN ? '（预演模式，不会修改）' : ''}\n`);

  // 同一远程 URL 只下载一次，多个文件共用同一本地路径
  const urlToLocal = new Map();
  let totalReplacements = 0;

  for (const file of files) {
    let content = fs.readFileSync(file, 'utf8');
    const urls = [...new Set(content.match(PROTECTED_RE) || [])];
    if (urls.length === 0) continue;

    let changed = false;
    for (const url of urls) {
      if (!urlToLocal.has(url)) {
        // 用 taskId 生成稳定文件名
        const taskMatch = url.match(/videos\/([^/]+)\/content/i);
        const taskId = taskMatch ? taskMatch[1] : `vid_${Date.now()}`;
        const fileName = `recovered_${taskId}.mp4`;
        const dest = path.join(MEDIA_VIDEOS_DIR, fileName);
        const localUrl = `local-image://videos/${fileName}`;

        if (DRY_RUN) {
          console.log(`[预演] 将下载 ${url}\n        → ${dest}`);
          urlToLocal.set(url, localUrl);
        } else if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
          console.log(`[跳过] 本地已存在：${fileName}`);
          urlToLocal.set(url, localUrl);
        } else {
          process.stdout.write(`[下载] ${taskId} ... `);
          try {
            await download(url, dest);
            const kb = Math.round(fs.statSync(dest).size / 1024);
            console.log(`完成 (${kb}KB)`);
            urlToLocal.set(url, localUrl);
          } catch (e) {
            console.log(`失败：${e.message}（保留原 URL）`);
            urlToLocal.set(url, url); // 失败则不改写
          }
        }
      }

      const localUrl = urlToLocal.get(url);
      if (localUrl !== url) {
        const before = content;
        content = content.split(url).join(localUrl);
        if (content !== before) { changed = true; totalReplacements++; }
      }
    }

    if (changed && !DRY_RUN) {
      const bak = `${file}.bak-${Date.now()}`;
      fs.copyFileSync(file, bak);
      fs.writeFileSync(file, content, 'utf8');
      console.log(`[改写] ${path.relative(PROJECTS_ROOT, file)}（备份：${path.basename(bak)}）`);
    }
  }

  console.log(`\n完成。${DRY_RUN ? '预演' : '实际'}替换引用 ${totalReplacements} 处，下载 ${[...urlToLocal.values()].filter(v => v.startsWith('local-image://')).length} 个视频。`);
  if (!DRY_RUN) console.log('请重启应用查看效果。如有问题，可用 .bak 备份恢复。');
}

main().catch((e) => { console.error('脚本异常：', e); process.exit(1); });
