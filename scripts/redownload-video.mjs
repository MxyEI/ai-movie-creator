#!/usr/bin/env node
/**
 * 重新下载单个受保护视频到本地（修复之前下载中断导致的残缺文件）。
 *
 * 用法（项目根目录）：
 *   LOOK2EYE_KEY=你的Key node scripts/redownload-video.mjs <taskId>
 *   # 不传 taskId 时默认修复 task_8kGrfwIH9H55Bj6bKkLEHPgVHAFYug8L
 *
 * 用 node https 下载（对中文路径处理可靠），下载后校验 Content-Length
 * 与 moov atom，确保文件完整可播放。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';

const API_KEY = process.env.LOOK2EYE_KEY || '';
const taskId = process.argv[2] || 'task_8kGrfwIH9H55Bj6bKkLEHPgVHAFYug8L';

if (!API_KEY) {
  console.error('错误：未设置 LOOK2EYE_KEY。用法：LOOK2EYE_KEY=你的Key node scripts/redownload-video.mjs [taskId]');
  process.exit(1);
}

const APP_DATA = path.join(os.homedir(), 'Library', 'Application Support', '魔因漫创');
const dest = path.join(APP_DATA, 'media', 'videos', `recovered_${taskId}.mp4`);
const url = `https://ai.silkroadai.io/v1/videos/${taskId}/content`;

function downloadOnce(u, filePath, redirects = 5) {
  return new Promise((resolve, reject) => {
    if (redirects <= 0) return reject(new Error('Too many redirects'));
    const req = https.get(u, { headers: { Authorization: `Bearer ${API_KEY}` } }, (res) => {
      const status = res.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
        res.resume();
        return downloadOnce(res.headers.location, filePath, redirects - 1).then(resolve).catch(reject);
      }
      if (status !== 200) { res.resume(); return reject(new Error(`HTTP ${status}`)); }
      const expected = parseInt(res.headers['content-length'] || '0', 10);
      const file = fs.createWriteStream(filePath);
      res.pipe(file);
      file.on('finish', () => file.close(() => {
        const actual = fs.statSync(filePath).size;
        if (expected > 0 && actual !== expected) {
          fs.unlink(filePath, () => {});
          return reject(new Error(`不完整：${actual}/${expected} 字节`));
        }
        resolve(actual);
      }));
      file.on('error', (e) => { fs.unlink(filePath, () => {}); reject(e); });
    });
    req.on('error', (e) => { fs.unlink(filePath, () => {}); reject(e); });
    req.setTimeout(120000, () => req.destroy(new Error('超时')));
  });
}

async function main() {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) fs.unlinkSync(dest); // 清掉可能的残缺旧文件

  let size;
  for (let i = 1; i <= 4; i++) {
    try {
      process.stdout.write(`下载尝试 ${i}/4 ... `);
      size = await downloadOnce(url, dest);
      console.log(`完成 (${Math.round(size / 1024)}KB)`);
      break;
    } catch (e) {
      console.log(`失败：${e.message}`);
      if (i < 4) await new Promise((r) => setTimeout(r, 2000));
      else { console.error('多次下载失败，请稍后重试。'); process.exit(1); }
    }
  }

  // 校验 moov atom（MP4 索引），缺失则无法播放
  const buf = fs.readFileSync(dest);
  const hasMoov = buf.includes(Buffer.from('moov'));
  console.log(`moov atom 校验：${hasMoov ? '✓ 存在（可播放）' : '✗ 缺失（文件仍残缺）'}`);
  if (!hasMoov) process.exit(1);
  console.log(`\n已保存：${dest}\n重启应用即可播放。`);
}

main().catch((e) => { console.error('异常：', e); process.exit(1); });
