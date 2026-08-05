import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json' with { type: 'json' };

export default defineManifest({
  manifest_version: 3,
  name: 'Mock Studio',
  version: pkg.version,
  description: 'AI 可编程的本地 Mock 运行时',

  // WebSocket 保活需要 116+（V2 的 MCP 长连），提前声明避免将来改
  minimum_chrome_version: '116',

  permissions: ['storage', 'scripting', 'tabs'],

  // MVP 阶段先全量，上架前改为 optional_host_permissions（见设计文档 05 §11 Q15）
  host_permissions: ['<all_urls>'],

  background: {
    service_worker: 'src/hosts/background/index.ts',
    type: 'module',
  },

  /**
   * 注意：MAIN world 的拦截引擎【不在这里声明】。
   *
   * 它必须同步执行才能保证在页面任何脚本之前完成 hook（E1），而 CRXJS 会把
   * content script 包成 loader 并用动态 import() 异步加载，破坏时序。
   * 所以它由 vite.inject.config.ts 单独打成 IIFE，构建后由
   * build/injectContentScriptPlugin.ts 补进 dist/manifest.json。
   *
   * 改注入层代码后要重跑 `npm run build:inject`（npm run build 已包含）。
   */
  content_scripts: [
    {
      // 中继站
      matches: ['<all_urls>'],
      js: ['src/hosts/content/index.ts'],
      run_at: 'document_start',
      world: 'ISOLATED',
      all_frames: true,
    },
  ],

  action: {
    default_popup: 'src/hosts/popup/index.html',
    default_title: 'Mock Studio',
  },

  options_page: 'src/hosts/options/index.html',
  devtools_page: 'src/hosts/devtools/index.html',

  commands: {
    'toggle-global': {
      suggested_key: { default: 'Alt+M' },
      description: '切换 Mock 总开关',
    },
  },
});
