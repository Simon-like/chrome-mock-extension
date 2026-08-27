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
import WebSocket from 'ws';
import { createBridge, type BridgeTransport } from './bridge.js';
import { registerTools } from './tools.js';
import { registerPrompts } from './prompts.js';
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

  /**
   * 抢端口：抢到当 Hub，抢不到就连上去当 peer。
   * 于是**多个 AI 工具可以同时接同一个扩展** —— 不再是第二个直接退出。
   */
  let bridge: BridgeTransport;
  try {
    bridge = await createBridge({ port, token, serverVersion: VERSION, log, WsCtor: WebSocket });
  } catch (e) {
    log((e as Error).message);
    process.exit(1);
  }

  const server = new McpServer(
    { name: 'mock-studio', version: VERSION },
    {
      /**
       * 这段会在客户端连上时注入 AI 的上下文 —— **它取代了「给每个 agent 装 skill」**。
       *
       * 所以这里要写的不是「有哪些工具」（工具列表本来就自带描述），
       * 而是**什么时候该想起用它们**、以及**顺序**。
       * 触发词写得越具体，AI 越不容易在用户说「页面没数据」时
       * 跑去读代码猜接口，而不是直接看浏览器里真实发生了什么。
       */
      instructions:
        'Mock Studio 让你直接读写用户 Chrome 里的接口 mock，并能看到页面**实际发出**的请求。\n\n' +
        '【什么时候用】用户说这些话时，先用本工具集，不要去翻代码猜接口：\n' +
        '  「页面没数据 / 接口报错 / 这个接口挂了 / 帮我 mock 一下 / 造点假数据 /\n' +
        '   我要看空状态 / 测一下报错 / 后端还没做这个接口 / 翻页数据不变」\n\n' +
        '【标准顺序】\n' +
        '1. get_page_context —— 一次看总开关、关键请求、相关规则和建议。\n' +
        '   **不要让用户手抄 URL**，也不要先连续调用多个列表工具\n' +
        '2. get_request_detail —— 只在需要对齐完整字段结构时\n' +
        '3. create_mock / update_mock / add_variant —— 按上下文选择；接口本来不存在用 kind:"virtual"；\n' +
        '   要一批像真的数据用 body_type:"mockjs"；要随参数变用 "dynamic"\n' +
        '4. **告诉用户刷新页面** —— 已经发出去的请求不会重来\n\n' +
        '【常见需求对应哪个工具】\n' +
        '  测空态/报错/超时 → create_mock 传多个 variants，或 add_variant，再 set_active_variant 切\n' +
        '  模拟超时/断网 → behavior: "timeout" / "networkError"\n' +
        '  改已有 mock → update_mock（是覆盖）；想保留原数据则用 add_variant\n' +
        '  mock 没生效 → get_status 看总开关，list_rules 看规则是否被遮蔽\n\n' +
        '【要知道的边界】\n' +
        '  · 请求记录里的 token/cookie/邮箱/手机号已被强制打码，\n' +
        '    redacted 为 true 表示这条你看到的不是全貌\n' +
        '  · 建规则后会自动做冲突检测，返回里的 ⚠️ 要转达给用户，别忽略',
    },
  );

  registerTools(server, bridge);
  registerPrompts(server);

  await server.connect(new StdioServerTransport());
  log(`MCP 已就绪（角色：${bridge.role}）`);

  const shutdown = async () => {
    // 干净退出很重要：Hub 退出时要主动关掉 peer 连接，
    // 让它们立刻重新选举，而不是等 TCP 超时
    await bridge.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  log('启动失败：', e);
  process.exit(1);
});
