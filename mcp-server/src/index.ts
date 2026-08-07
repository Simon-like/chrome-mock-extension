#!/usr/bin/env node
/**
 * Mock Studio MCP Server
 *
 * ```
 *   Claude Code / Cursor
 *         ↕  stdio（MCP 协议）
 *   本进程                        ← 同时是 WebSocket server
 *         ↕  WebSocket（127.0.0.1）
 *   Chrome 扩展 Service Worker
 * ```
 *
 * ⚠️ **stdout 属于 MCP 协议，不许往里写任何东西**。
 * 一行 console.log 就会把 JSON-RPC 流冲坏，且症状是「客户端说服务器坏了」，
 * 极难往回查。所有日志一律走 stderr。
 *
 * 配置（都通过环境变量）：
 *   MOCK_STUDIO_TOKEN  配对码，必填。在扩展设置页复制
 *   MOCK_STUDIO_PORT   WebSocket 端口，默认 8787，要和扩展设置一致
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BridgeServer } from './bridge.js';
import { registerTools } from './tools.js';
import { DEFAULT_BRIDGE_PORT } from '../../src/core/types.js';

const VERSION = '0.1.0';

/** 日志一律 stderr —— stdout 是 MCP 协议专用的 */
function log(...args: unknown[]): void {
  console.error('[mock-studio-mcp]', ...args);
}

async function main(): Promise<void> {
  const token = process.env.MOCK_STUDIO_TOKEN ?? '';
  const port = Number(process.env.MOCK_STUDIO_PORT) || DEFAULT_BRIDGE_PORT;

  if (!token) {
    log(
      '缺少 MOCK_STUDIO_TOKEN。\n' +
        '  打开 Chrome 扩展 Mock Studio 的设置页 → MCP 桥 → 复制配对码，\n' +
        '  填进 MCP 客户端配置的 env.MOCK_STUDIO_TOKEN。\n' +
        '  没有配对码的话，本机任何进程都能连上来改你的 mock 规则。',
    );
    process.exit(1);
  }

  const bridge = new BridgeServer(port, token, VERSION);
  try {
    await bridge.start();
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'EADDRINUSE') {
      log(
        `端口 ${port} 已被占用。多半是另一个 mock-studio-mcp 还在跑（MCP 客户端有时会留下旧进程）。\n` +
          `  换个端口：设置 MOCK_STUDIO_PORT，并把扩展设置页里的端口改成一样的。`,
      );
    } else {
      log(`WebSocket 服务启动失败：${err.message}`);
    }
    process.exit(1);
  }
  log(`WebSocket 已监听 127.0.0.1:${port}，等待扩展连接…`);

  const server = new McpServer(
    { name: 'mock-studio', version: VERSION },
    {
      instructions:
        'Mock Studio 让你直接操作用户浏览器里的接口 mock。\n' +
        '用户说「页面没数据」「帮我 mock 一下这个接口」时：\n' +
        '1. 先 list_recent_requests（only_unmocked: true）看页面实际在请求什么 —— 不要让用户手抄 URL\n' +
        '2. 需要真实数据结构就 get_request_detail\n' +
        '3. 再 create_mock。接口本来不存在就用 kind: "virtual"\n' +
        '4. 告诉用户刷新页面（已经发出去的请求不会重来）\n' +
        '注意：请求记录里的 token/cookie 已被强制打码，redacted 为 true 表示你看到的不是全貌。',
    },
  );

  registerTools(server, bridge);

  await server.connect(new StdioServerTransport());
  log('MCP 已就绪');

  const shutdown = async () => {
    await bridge.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  log('启动失败：', e);
  process.exit(1);
});
