/**
 * 端到端冒烟测试 —— 跑的是**编译产物**，不是源码
 *
 * 为什么要有这个：单测能测脱敏、能测 reducer，但测不了
 * 「MCP 客户端 → stdio → 本进程 → WebSocket → 扩展」这条链真的通不通。
 * 而这条链恰恰是最容易出问题的地方（握手、Origin、协议版本、请求应答配对）。
 *
 * 这里用一个**假扩展**（一个带正确 Origin 和配对码的 WS client）冒充 Chrome 侧，
 * 于是不用真开浏览器就能验证整条链路，也能验证安全校验真的会拒绝。
 *
 * 跑：node e2e.mjs
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(HERE, 'dist/mcp-server/src/index.js');
const TOKEN = 'e2e-token-123456';
const PORT = 8791;

let passed = 0;
let failed = 0;

function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

/** 假扩展：冒充 Chrome 扩展的 Service Worker */
function fakeExtension({ port, token, origin = 'chrome-extension://abcdefghijklmnop' }) {
  return new Promise((resolveConn, rejectConn) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { origin } });
    const state = { store: makeStore(), captures: makeCaptures(), dispatched: [], ws };

    const timer = setTimeout(() => rejectConn(new Error('握手超时')), 4000);

    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          type: 'HELLO',
          protocolVersion: 1,
          token,
          extensionVersion: '0.1.0',
        }),
      );
    });

    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));

      if (msg.type === 'WELCOME') {
        clearTimeout(timer);
        resolveConn(state);
        return;
      }
      if (msg.type === 'REJECT') {
        clearTimeout(timer);
        rejectConn(new Error(msg.reason));
        return;
      }
      if (!msg.id) return;

      // 模拟扩展侧的应答。真实实现见 src/hosts/background/mcpBridge.ts
      const reply = (data) => ws.send(JSON.stringify({ id: msg.id, ok: true, data }));
      switch (msg.type) {
        case 'GET_STATE':
          return reply({ kind: 'state', store: state.store });
        case 'GET_CAPTURES': {
          let list = state.captures;
          if (msg.onlyUnmocked) list = list.filter((e) => !e.mocked);
          return reply({ kind: 'captures', entries: list, total: list.length });
        }
        case 'GET_CAPTURE_DETAIL':
          return reply({
            kind: 'captureDetail',
            entry: state.captures.find((e) => e.id === msg.captureId) ?? null,
          });
        case 'DISPATCH':
          state.dispatched.push(msg.command);
          return reply({ kind: 'dispatch', result: { ok: true, createdId: 'new-rule-1' } });
        default:
          return reply({ kind: 'pong' });
      }
    });

    ws.on('error', (e) => {
      clearTimeout(timer);
      rejectConn(e);
    });
    ws.on('close', (code, reason) => {
      clearTimeout(timer);
      rejectConn(new Error(`连接被关闭 code=${code} reason=${String(reason)}`));
    });
  });
}

function makeStore() {
  return {
    schemaVersion: 2,
    enabled: true,
    projects: [],
    groups: [],
    rules: [
      {
        id: 'rule-1',
        name: '商品列表',
        enabled: true,
        kind: 'override',
        groupId: null,
        projectId: null,
        match: { urlMode: 'contains', url: '/api/goods/list', methods: ['GET'], hosts: [] },
        variants: [
          { id: 'v1', name: '默认', response: { status: 200, bodyType: 'static', body: '{}' } },
          { id: 'v2', name: '空数据', response: { status: 200, bodyType: 'static', body: '[]' } },
        ],
        activeVariantId: 'v1',
        meta: { createdAt: 0, updatedAt: 0, source: 'manual', hitCount: 7, lastHitAt: 0 },
      },
    ],
    shellTemplates: [{ id: 'shell-raw', name: '裸数据', builtin: true, template: '__DATA__' }],
    settings: {
      captureEnabled: true,
      captureMaxCount: 200,
      pageSize: 15,
      aiReadEnabled: true,
      aiHostWhitelist: [],
      mcpEnabled: true,
      mcpPort: PORT,
      mcpToken: TOKEN,
    },
    activeProjectId: null,
  };
}

/**
 * 注意这里的 url/body 是**已经脱敏过的** —— 真实链路里脱敏发生在扩展侧
 * （数据离开扩展之前），所以假扩展也照着那个契约给数据。
 */
function makeCaptures() {
  return [
    {
      id: 'c1',
      at: Date.now(),
      url: 'https://shop.example.com/api/goods/list?page=1&token=[REDACTED]',
      method: 'GET',
      api: 'fetch',
      mocked: false,
      ruleId: null,
      ruleName: null,
      status: 404,
      body: '{"message":"Not Found"}',
      truncated: false,
      durationMs: 23,
      redacted: true,
    },
    {
      id: 'c2',
      at: Date.now(),
      url: 'https://shop.example.com/api/user/profile',
      method: 'GET',
      api: 'xhr',
      mocked: true,
      ruleId: 'rule-1',
      ruleName: '商品列表',
      status: 200,
      body: '{"id":1}',
      truncated: false,
      durationMs: 3,
      redacted: false,
    },
  ];
}

async function main() {
  console.log('\n▶ 启动 MCP Server 并用真实 MCP 客户端连接\n');

  transport = new StdioClientTransport({
    command: 'node',
    args: [SERVER],
    env: { ...process.env, MOCK_STUDIO_TOKEN: TOKEN, MOCK_STUDIO_PORT: String(PORT) },
    stderr: 'pipe',
  });
  client = new Client({ name: 'e2e', version: '0' });
  await client.connect(transport);

  // ── 工具清单 ──────────────────────────────────────
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  // 断言具体集合而不是个数：加减工具时能直接看出差了哪个，数字对不上只会让人再数一遍
  const expected = [
    'create_mock',
    'delete_mock',
    'get_request_detail',
    'get_status',
    'list_recent_requests',
    'list_rules',
    'list_shell_templates',
    'set_active_variant',
    'set_global_enabled',
    'toggle_mock',
    'update_mock',
  ];
  const missing = expected.filter((n) => !names.includes(n));
  const extra = names.filter((n) => !expected.includes(n));
  check(
    '工具集与预期一致',
    missing.length === 0 && extra.length === 0,
    `缺少 [${missing}] 多出 [${extra}]`,
  );
  check('每个工具都有描述 —— AI 靠它决定什么时候用', tools.every((t) => (t.description ?? '').length > 20));

  // ── 未连接时的报错要能照着做 ────────────────────────
  const before = await client.callTool({ name: 'get_status', arguments: {} });
  check('扩展没连上时报错可操作', before.content[0].text.includes('扩展还没连上来'), before.content[0].text);

  // ── 安全：错误的配对码 ──────────────────────────────
  await fakeExtension({ port: PORT, token: 'wrong-token' })
    .then(() => check('错误配对码被拒绝', false, '居然连上了'))
    .catch((e) => check('错误配对码被拒绝', /配对码/.test(e.message), e.message));

  // ── 安全：网页 Origin ──────────────────────────────
  await fakeExtension({ port: PORT, token: TOKEN, origin: 'https://evil.example.com' })
    .then(() => check('网页 Origin 被拒绝', false, '居然连上了'))
    .catch((e) => check('网页 Origin 被拒绝', /Origin/.test(e.message), e.message));

  // ── 正常连接 ───────────────────────────────────────
  const ext = await fakeExtension({ port: PORT, token: TOKEN });
  check('正确配对码 + 扩展 Origin 可以连上', true);

  // ── 读侧 ───────────────────────────────────────────
  const status = await client.callTool({ name: 'get_status', arguments: {} });
  const statusJson = JSON.parse(status.content[0].text);
  check('get_status 读到真实状态', statusJson.ruleCount === 1 && statusJson.globalEnabled === true);

  const recent = await client.callTool({
    name: 'list_recent_requests',
    arguments: { only_unmocked: true },
  });
  const recentJson = JSON.parse(recent.content[0].text);
  check('list_recent_requests 只返回未被 mock 的', recentJson.requests.length === 1);
  check('返回的是 404 那条 —— 正是「缺哪个 mock」的答案', recentJson.requests[0].status === 404);
  check(
    '脱敏标记透传到 AI',
    recentJson.requests[0].redacted === true && recentJson.requests[0].url.includes('[REDACTED]'),
  );

  const detail = await client.callTool({ name: 'get_request_detail', arguments: { id: 'c1' } });
  check('get_request_detail 拿到完整响应体', detail.content[0].text.includes('Not Found'));

  const rules = await client.callTool({ name: 'list_rules', arguments: {} });
  check('list_rules 带出变体列表', JSON.parse(rules.content[0].text).rules[0].variants.length === 2);

  // ── 写侧：闭环的最后一步 ────────────────────────────
  const created = await client.callTool({
    name: 'create_mock',
    arguments: {
      name: '商品列表',
      url: '/api/goods/list',
      kind: 'virtual',
      body: '{"list|3":[{"id|+1":1,"name":"@cname"}]}',
      body_type: 'mockjs',
    },
  });
  check('create_mock 成功并提示刷新页面', created.content[0].text.includes('刷新页面'));

  const cmd = ext.dispatched.at(-1);
  check('落到扩展的是一条 CREATE_RULE 命令（A3）', cmd?.type === 'CREATE_RULE');
  check('kind / bodyType 正确传达', cmd?.payload.draft.kind === 'virtual' &&
    cmd?.payload.draft.variants[0].response.bodyType === 'mockjs');

  const variant = await client.callTool({
    name: 'set_active_variant',
    arguments: { rule_id: 'rule-1', variant_id: 'v2' },
  });
  check('set_active_variant 可用', variant.content[0].text.includes('已切换变体'));

  // ── 破坏性操作的提示 ────────────────────────────────
  const off = await client.callTool({ name: 'set_global_enabled', arguments: { enabled: false } });
  check('关总开关时不提虚拟接口（当前没有生效的 virtual 规则）', !off.content[0].text.includes('⚠️'));

  const bad = await client.callTool({ name: 'delete_mock', arguments: { id: 'nope' } });
  check('删不存在的规则给出明确错误', bad.isError === true);

  ext.ws.close();
  await client.close();
}

/**
 * 收尾一定要执行到。
 *
 * 第一版在断言失败时直接 process.exit(1)，子进程没被杀掉，
 * 端口就一直被占着 —— 下一次跑直接起不来，报的还是个跟本次改动无关的错。
 * 自己的测试脚本先把自己坑一次，正好说明 EADDRINUSE 那条提示是有必要的。
 */
let client;
let transport;

async function cleanup() {
  try {
    await client?.close();
  } catch {
    /* 已经关了 */
  }
  try {
    await transport?.close();
  } catch {
    /* 同上 */
  }
}

main()
  .catch((e) => {
    console.error('\n💥 e2e 崩了：', e);
    failed++;
  })
  .finally(async () => {
    await cleanup();
    console.log(`\n${failed === 0 ? '✅' : '❌'} 通过 ${passed} / 失败 ${failed}\n`);
    process.exit(failed === 0 ? 0 : 1);
  });
