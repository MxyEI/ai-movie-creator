// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// Commercial licensing available. See COMMERCIAL_LICENSE.md.
/**
 * Image Storage Utility
 * Handles saving and loading images via Electron IPC
 */

import { useAPIConfigStore, type AIFeature } from '@/stores/api-config-store';
import { parseApiKeys } from '@/lib/api-key-manager';
import { getFeatureConfig } from '@/lib/ai/feature-router';
import { corsFetch } from '@/lib/cors-fetch';

// Type declarations for the imageStorage API exposed by preload
declare global {
  interface Window {
    imageStorage?: {
      saveImage: (url: string, category: string, filename: string, headers?: Record<string, string>) => Promise<{ success: boolean; localPath?: string; error?: string }>;
      getImagePath: (localPath: string) => Promise<string | null>;
      deleteImage: (localPath: string) => Promise<boolean>;
      readAsBase64: (localPath: string) => Promise<{ success: boolean; base64?: string; mimeType?: string; size?: number; error?: string }>;
      getAbsolutePath: (localPath: string) => Promise<string | null>;
    };
  }
}

export type ImageCategory = 'characters' | 'scenes' | 'shots' | 'wardrobe' | 'videos' | 'styles' | 'props';

/**
 * Check if running in Electron environment
 */
export const isElectron = (): boolean => {
  return typeof window !== 'undefined' && !!window.imageStorage;
};

/**
 * 为受保护的媒体 URL 解析鉴权请求头。
 *
 * 部分中转站（如 look2eye）返回的视频/图片内容地址（例如
 * https://ai.silkroadai.io/v1/videos/.../content）需要携带 Bearer token
 * 才能访问，否则主进程下载或页面预览会得到 401。
 *
 * 注意：内容地址的 host 可能与 provider 的 baseUrl 不同（上游存储域名），
 * 因此不能仅靠 host 匹配；这里收集所有已配置 provider 的首个可用 Key，
 * 优先使用指定功能绑定的 Key。本地 / data URL 不需要鉴权，返回 undefined。
 */
function resolveAuthHeaders(url: string, feature?: AIFeature): Record<string, string> | undefined {
  if (!url || url.startsWith('local-image://') || url.startsWith('data:') || url.startsWith('file://')) {
    return undefined;
  }

  const tryKey = (key?: string | null): Record<string, string> | undefined =>
    key ? { Authorization: `Bearer ${key}` } : undefined;

  // 1. 优先使用功能绑定 provider 的 Key
  if (feature) {
    try {
      const config = getFeatureConfig(feature);
      const fromFeature = tryKey(config?.apiKey);
      if (fromFeature) return fromFeature;
    } catch {
      /* getFeatureConfig 不可用时回退到下一步 */
    }
  }

  // 2. 回退：任意已配置 provider 的首个 Key（中转站通常共用同一套 Key）
  try {
    const { providers } = useAPIConfigStore.getState();
    for (const provider of providers) {
      const keys = parseApiKeys(provider.apiKey);
      const fromProvider = tryKey(keys[0]);
      if (fromProvider) return fromProvider;
    }
  } catch {
    /* store 不可用 */
  }

  return undefined;
}

/**
 * 判断 URL 是否为需要鉴权的视频内容端点（OpenAI 官方视频格式 /v1/videos/{id}/content，
 * sora/veo 等）。这类地址直接交给主进程下载或 <video src> 都不会带 Authorization。
 */
function isProtectedVideoContentUrl(url: string): boolean {
  return /^https?:\/\//i.test(url) && /\/videos\/[^/]+\/content\/?$/i.test(url);
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('视频转码失败'));
    reader.readAsDataURL(blob);
  });
}

/**
 * 在渲染进程用 corsFetch（带鉴权头、经统一跨域流程）把受保护媒体地址拉成 data URL。
 * 与自由生成的处理方式一致：主进程直连 protocol.get 拿不到 Key / 可能被上游域名限制，
 * 因此对受保护内容端点改在渲染进程下载，再把字节交给主进程落盘。
 * 拉取失败返回 null，调用方回退到原始 URL。
 */
async function fetchProtectedAsDataUrl(url: string, feature?: AIFeature, apiKey?: string): Promise<string | null> {
  const headers = apiKey
    ? { Authorization: `Bearer ${apiKey}` }
    : resolveAuthHeaders(url, feature);
  if (!headers) return null;
  try {
    const resp = await corsFetch(url, { headers });
    if (!resp.ok) {
      console.warn(`[ImageStorage] 受保护媒体下载失败 (${resp.status})，回退原始 URL`);
      return null;
    }
    const blob = await resp.blob();
    return await blobToDataUrl(blob);
  } catch (err) {
    console.warn('[ImageStorage] 受保护媒体下载异常，回退原始 URL：', err);
    return null;
  }
}

/**
 * Save an image from URL to local storage
 * @param url - The URL of the image to save
 * @param category - Category folder (characters, scenes, shots, wardrobe)
 * @param filename - Optional filename hint
 * @returns Local path (local-image://...) or original URL if not in Electron
 */
export async function saveImageToLocal(
  url: string, 
  category: ImageCategory, 
  filename: string = 'image.png'
): Promise<string> {
  // If not in Electron, return original URL
  if (!isElectron()) {
    console.warn('Not running in Electron, image will not be saved locally');
    return url;
  }

  try {
    const headers = resolveAuthHeaders(url);
    const result = await window.imageStorage!.saveImage(url, category, filename, headers);

    if (result.success && result.localPath) {
      console.log(`Image saved locally: ${result.localPath}`);
      return result.localPath;
    } else {
      console.error('Failed to save image:', result.error);
      return url; // Fallback to original URL
    }
  } catch (error) {
    console.error('Error saving image:', error);
    return url; // Fallback to original URL
  }
}

/**
 * Resolve a local-image:// path to an actual file:// URL
 * Falls back to the original path if not a local-image path or not in Electron
 */
export async function resolveImagePath(path: string): Promise<string> {
  // If not a local-image path, return as-is
  if (!path.startsWith('local-image://')) {
    return path;
  }

  // If not in Electron, can't resolve local paths
  if (!isElectron()) {
    console.warn('Not running in Electron, cannot resolve local image path');
    return path;
  }

  try {
    const resolvedPath = await window.imageStorage!.getImagePath(path);
    return resolvedPath || path;
  } catch (error) {
    console.error('Error resolving image path:', error);
    return path;
  }
}

/**
 * Delete a locally stored image
 */
export async function deleteLocalImage(localPath: string): Promise<boolean> {
  if (!localPath.startsWith('local-image://')) {
    return false;
  }

  if (!isElectron()) {
    return false;
  }

  try {
    return await window.imageStorage!.deleteImage(localPath);
  } catch (error) {
    console.error('Error deleting image:', error);
    return false;
  }
}

/**
 * Read a local image as base64 (for AI API calls like video generation)
 * Works with local-image://, file://, or absolute paths
 * @returns base64 data URL (e.g., "data:image/png;base64,...")
 */
export async function readImageAsBase64(imagePath: string): Promise<string | null> {
  // If already a data URL, return as-is
  if (imagePath.startsWith('data:')) {
    return imagePath;
  }

  // If it's a remote URL, fetch and convert
  if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
    try {
      const response = await fetch(imagePath);
      const blob = await response.blob();
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
    } catch (error) {
      console.error('Error fetching remote image:', error);
      return null;
    }
  }

  // For local images, use Electron IPC
  if (!isElectron()) {
    console.warn('Not running in Electron, cannot read local image');
    return null;
  }

  try {
    const result = await window.imageStorage!.readAsBase64(imagePath);
    if (result.success && result.base64) {
      return result.base64;
    }
    console.error('Failed to read image:', result.error);
    return null;
  } catch (error) {
    console.error('Error reading image as base64:', error);
    return null;
  }
}

/**
 * Get the absolute file path for a local-image:// URL
 * Useful for local video generation tools like FFmpeg
 */
export async function getAbsoluteImagePath(localPath: string): Promise<string | null> {
  if (!localPath.startsWith('local-image://')) {
    // Already an absolute path or other format
    return localPath;
  }

  if (!isElectron()) {
    console.warn('Not running in Electron, cannot get absolute path');
    return null;
  }

  try {
    return await window.imageStorage!.getAbsolutePath(localPath);
  } catch (error) {
    console.error('Error getting absolute path:', error);
    return null;
  }
}

/**
 * Save a video from URL to local storage
 * @param url - The URL of the video to save
 * @param filename - Optional filename hint
 * @param apiKey - Optional API key for protected content endpoints (e.g. /v1/videos/{id}/content).
 *                 显式传入生成时使用的 Key 最可靠；省略则回退到功能绑定 Key 的反查。
 * @returns Local path (local-image://videos/...) or original URL if not in Electron
 */
export async function saveVideoToLocal(
  url: string,
  filename: string = 'video.mp4',
  apiKey?: string
): Promise<string> {
  // If not in Electron or already local, return as-is
  if (!isElectron() || url.startsWith('local-image://') || url.startsWith('data:')) {
    return url;
  }

  try {
    // 受鉴权保护的内容端点（/v1/videos/{id}/content）：主进程直连下载会 401，
    // 改在渲染进程带 Key 经 corsFetch 拉成 data URL，再交主进程解码落盘。
    let urlToSave = url;
    if (isProtectedVideoContentUrl(url)) {
      const dataUrl = await fetchProtectedAsDataUrl(url, 'video_generation', apiKey);
      if (dataUrl) {
        urlToSave = dataUrl;
      }
    }

    const headers = urlToSave === url
      ? (apiKey ? { Authorization: `Bearer ${apiKey}` } : resolveAuthHeaders(url, 'video_generation'))
      : undefined;
    const result = await window.imageStorage!.saveImage(urlToSave, 'videos', filename, headers);

    if (result.success && result.localPath) {
      console.log(`Video saved locally: ${result.localPath}`);
      return result.localPath;
    } else {
      console.error('Failed to save video:', result.error);
      return url;
    }
  } catch (error) {
    console.error('Error saving video:', error);
    return url;
  }
}
