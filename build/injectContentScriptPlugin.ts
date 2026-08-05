/**
 * 构建插件：把 MAIN world 注入脚本写回 manifest
 *
 * 为什么要绕这一圈：
 *
 * 1. 注入脚本必须【同步】执行完 hook，才能保证在页面任何脚本之前生效（E1）。
 *    CRXJS 会把 content script 包成 loader 并用动态 import() 加载，是异步的，
 *    会破坏这个时序保证。
 *
 * 2. 所以注入脚本走 vite.inject.config.ts 单独打成 IIFE，产物落在 public/inject.js，
 *    由 vite 原样拷进 dist。
 *
 * 3. 但只要在 manifest.config.ts 的 content_scripts 里写了 'inject.js'，
 *    CRXJS 就会把它当成源码入口去解析，然后报 "Could not resolve entry module"。
 *
 * 结论：manifest.config.ts 里不声明它，构建结束后由本插件补进 dist/manifest.json。
 * 这样既保留了声明式注册（时序最优），也避开了 CRXJS 的转换。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

export interface InjectScriptOptions {
  /** dist 中的脚本文件名 */
  file: string;
  matches: string[];
}

export function injectContentScriptPlugin(opts: InjectScriptOptions): Plugin {
  return {
    name: 'mock-studio:inject-content-script',
    // 必须在 CRXJS 写完 manifest 之后
    enforce: 'post',
    apply: 'build',

    writeBundle(outputOptions) {
      const outDir = outputOptions.dir ?? 'dist';
      const manifestPath = resolve(outDir, 'manifest.json');

      if (!existsSync(manifestPath)) {
        this.warn(`未找到 ${manifestPath}，跳过注入脚本注册`);
        return;
      }

      const scriptPath = resolve(outDir, opts.file);
      if (!existsSync(scriptPath)) {
        this.error(
          `缺少注入脚本 ${opts.file}。请先运行 npm run build:inject —— ` +
            `没有它拦截引擎完全不会工作。`,
        );
        return;
      }

      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      manifest.content_scripts = manifest.content_scripts ?? [];

      // 放在数组最前面：同一 run_at 下 Chrome 按声明顺序执行，
      // 引擎要尽可能早，排在中继站前面
      manifest.content_scripts.unshift({
        js: [opts.file],
        matches: opts.matches,
        run_at: 'document_start',
        world: 'MAIN',
        all_frames: true,
      });

      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    },
  };
}
