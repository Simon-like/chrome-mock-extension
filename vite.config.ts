import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import { resolve } from 'node:path';
import manifest from './manifest.config.js';
import { injectContentScriptPlugin } from './build/injectContentScriptPlugin.js';

export default defineConfig({
  plugins: [
    react(),
    crx({ manifest }),
    // 把单独打好的 IIFE 注入脚本补进 manifest（见该文件顶部注释）
    injectContentScriptPlugin({ file: 'inject.js', matches: ['<all_urls>'] }),
  ],
  resolve: {
    alias: {
      '@core': resolve(__dirname, 'src/core'),
      '@shared': resolve(__dirname, 'src/shared'),
      '@ui': resolve(__dirname, 'src/ui'),
    },
  },
  build: {
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'src/hosts/popup/index.html'),
        options: resolve(__dirname, 'src/hosts/options/index.html'),
        devtools: resolve(__dirname, 'src/hosts/devtools/index.html'),
        // 面板 UI 不被 manifest 直接引用（是 devtools.ts 在运行时 create 的），
        // CRXJS 扫不到，必须显式声明为入口，否则打不出来
        devtoolsPanel: resolve(__dirname, 'src/hosts/devtools/panel.html'),
      },
    },
  },
  server: { port: 5173, strictPort: true },
  test: {
    // 默认 node 环境（core 测试不需要 DOM）。
    // 注入层测试用文件顶部的 @vitest-environment 注释单独切到 happy-dom。
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
