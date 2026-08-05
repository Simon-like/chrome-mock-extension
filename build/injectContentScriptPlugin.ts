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
 * 结论：manifest.config.ts 里不声明它，改由本插件补进 dist/manifest.json。
 *
 * ⚠️ build 和 dev 两种模式都要补 —— 早期版本只在 build 时生效，
 * 导致 `npm run dev` 产出的扩展完全不拦截请求，且没有任何报错，非常难查。
 */

import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

export interface InjectScriptOptions {
  /** dist 中的脚本文件名 */
  file: string;
  matches: string[];
  /**
   * 源文件路径（vite.inject.config.ts 的产物）。
   * dev 模式下需要它来持续同步 —— vite 只在启动时拷贝一次 publicDir，
   * 之后 watch 重建的产物不会自动进 dist。
   */
  sourceFile: string;
  /** 输出目录，默认 dist */
  outDir?: string;
}

interface ContentScriptEntry {
  js: string[];
  matches: string[];
  run_at: string;
  world: string;
  all_frames: boolean;
}

export function injectContentScriptPlugin(opts: InjectScriptOptions): Plugin {
  const entry = (): ContentScriptEntry => ({
    js: [opts.file],
    matches: opts.matches,
    run_at: 'document_start',
    world: 'MAIN',
    all_frames: true,
  });

  /** 幂等地把注入脚本塞进 manifest 最前面 */
  const patch = (manifestPath: string): 'patched' | 'already' | 'missing' => {
    if (!existsSync(manifestPath)) return 'missing';

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      content_scripts?: ContentScriptEntry[];
    };
    manifest.content_scripts = manifest.content_scripts ?? [];

    const exists = manifest.content_scripts.some(
      (cs) => cs.world === 'MAIN' && cs.js?.includes(opts.file),
    );
    if (exists) return 'already';

    // 放在最前：同一 run_at 下 Chrome 按声明顺序执行，
    // 引擎要尽可能早，排在中继站前面
    manifest.content_scripts.unshift(entry());
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    return 'patched';
  };

  let devTimer: ReturnType<typeof setInterval> | null = null;

  return {
    name: 'mock-studio:inject-content-script',
    // 必须在 CRXJS 写完 manifest 之后
    enforce: 'post',

    // ── 生产构建 ──────────────────────────────────────
    writeBundle(outputOptions) {
      const outDir = outputOptions.dir ?? opts.outDir ?? 'dist';
      const manifestPath = resolve(outDir, 'manifest.json');

      if (!existsSync(resolve(outDir, opts.file))) {
        this.error(
          `缺少注入脚本 ${opts.file}。请先运行 npm run build:inject —— ` +
            `没有它拦截引擎完全不会工作。`,
        );
        return;
      }
      if (patch(manifestPath) === 'missing') {
        this.warn(`未找到 ${manifestPath}，跳过注入脚本注册`);
      }
    },

    // ── dev 模式 ─────────────────────────────────────
    // CRXJS 在 dev 下会自行写 dist/manifest.json，且可能多次重写，
    // 所以用轮询保证它始终带着我们的注入脚本条目。
    configureServer(server) {
      const root = server.config.root;
      const outDir = opts.outDir ?? 'dist';
      const manifestPath = resolve(root, outDir, 'manifest.json');
      const destPath = resolve(root, outDir, opts.file);
      const srcPath = resolve(root, opts.sourceFile);

      let warnedMissingScript = false;
      let announced = false;
      let lastSyncedMtime = 0;

      devTimer = setInterval(() => {
        if (!existsSync(srcPath)) {
          if (!warnedMissingScript) {
            warnedMissingScript = true;
            server.config.logger.warn(
              `\n[mock-studio] 缺少 ${opts.sourceFile} —— 拦截引擎不会工作。\n` +
                `  请确认 dev:inject 的 watch 进程在跑（npm run dev 会自动带上）。\n`,
            );
          }
          return;
        }
        warnedMissingScript = false;

        // 关键：把 watch 重建出的产物同步进 dist。
        // 没有这一步，改了注入层代码 dist 里还是旧的，页面行为不会变，
        // 而且没有任何报错 —— 很难查。
        const mtime = statSync(srcPath).mtimeMs;
        if (mtime !== lastSyncedMtime) {
          copyFileSync(srcPath, destPath);
          lastSyncedMtime = mtime;
          if (announced) {
            server.config.logger.info(
              `[mock-studio] 注入脚本已更新 —— 刷新页面生效`,
              { timestamp: true },
            );
          }
        }

        const result = patch(manifestPath);
        if (result === 'patched' && !announced) {
          announced = true;
          server.config.logger.info(
            `[mock-studio] 已把 ${opts.file} 注册为 MAIN world content script`,
          );
        }
      }, 400);

      server.httpServer?.once('close', () => {
        if (devTimer) clearInterval(devTimer);
        devTimer = null;
      });
    },

    closeBundle() {
      if (devTimer) {
        clearInterval(devTimer);
        devTimer = null;
      }
    },
  };
}
