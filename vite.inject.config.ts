/**
 * 注入脚本的独立构建配置
 *
 * 为什么不能走 CRXJS 的 content_scripts 流程：
 * CRXJS 会把 content script 包成一个 loader，内部用【动态 import()】加载真正的代码：
 *
 *   (async () => { const { onExecute } = await import("./index.ts-xxx.js"); ... })()
 *
 * 动态 import 是异步的 —— 这会把 hook 的安装时机推迟到模块加载完成之后。
 * 而我们的第一条铁律是「必须在页面任何脚本之前完成 hook」（E1，见 04 文档 §2）。
 * 一旦推迟，页面早期的请求就会漏拦，且时序随机、难以复现。
 *
 * 所以注入脚本必须单独打成【同步执行的 IIFE】，产物放进 public/ 让 vite 原样拷贝，
 * CRXJS 不会去改它。
 *
 * 用法：npm run build 会先跑这个配置，再跑主构建。
 */

import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@core': resolve(__dirname, 'src/core'),
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
  // outDir 就是 publicDir，不关掉 vite 会警告「public directory feature may not work correctly」
  publicDir: false,
  build: {
    // 输出到 public/，主构建会把它原样拷进 dist。
    // dev 模式下 vite 只在启动时拷贝一次 public/，所以由
    // build/injectContentScriptPlugin.ts 负责持续同步到 dist/。
    outDir: 'public',
    emptyOutDir: false,
    // 关掉 modulepreload polyfill 等注入，保持产物干净
    modulePreload: false,
    target: 'es2022',
    minify: false,
    lib: {
      entry: resolve(__dirname, 'src/hosts/inject/index.ts'),
      name: 'MockStudioInject',
      // IIFE：同步执行，无 import，无 await
      formats: ['iife'],
      fileName: () => 'inject.js',
    },
  },
});
