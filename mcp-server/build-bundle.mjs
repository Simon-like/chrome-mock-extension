/**
 * 把 MCP Server 打成【零依赖单文件】—— 安装体验的根基。
 *
 * 为什么要单文件：
 *   tsc 的产物是一整个目录树（还带着 dist/mcp-server/src 这层因为 rootDir
 *   产生的嵌套），用户要把它填进 MCP 客户端配置时，路径又长又容易填错。
 *   单文件之后：
 *     · 本地版  —— 配置里只有一个稳定路径：dist/bundle/mock-studio-mcp.mjs
 *     · npm 版  —— 发布后配置里连路径都没有：npx -y mock-studio-mcp
 *
 * 产物同时是 `install` 子命令的载体（node mock-studio-mcp.mjs install），
 * 所以必须自包含，不能留任何运行时依赖。
 */

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [resolve(HERE, 'src/index.ts')],
  outfile: resolve(HERE, 'dist/bundle/mock-studio-mcp.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  // shebang 必须是产物第一行；ws 等 CJS 依赖打成 ESM 后内部 require() 不存在，
  // 用 createRequire 垫回去（esbuild 官方推荐做法）
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __mkRequire } from 'node:module'; const require = __mkRequire(import.meta.url);",
  },
  // 把 ws / zod / MCP SDK / src/core / src/shared 全部打进去，不留 external
  minify: false,
  sourcemap: false,
  // stdout 是 MCP 协议专用通道，构建警告也不能污染它（这里打到的是构建进程，无碍）
  logLevel: 'info',
});

console.log('✓ dist/bundle/mock-studio-mcp.mjs（零依赖单文件）');
