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
    const state = { store: makeStore(), captures: makeCaptures(), dispatched: [], seq: 0, pings: 0, ws };

    const timer = setTimeout(() => rejectConn(new Error('握手超时')), 4000);

    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          type: 'HELLO',
          protocolVersion: 2,
          role: 'extension',
          token,
          clientVersion: '0.1.0',
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
        case 'DISPATCH': {
          state.dispatched.push(msg.command);
          // 真的落库，否则「建完再读一次 state」的冲突检测永远看不到新规则
          let createdId;
          if (msg.command.type === 'CREATE_RULE') {
            const d = msg.command.payload.draft;
            createdId = `new-rule-${++state.seq}`;
            state.store.rules.push({
              ...d,
              id: createdId,
              variants: d.variants.map((v, i) => ({ ...v, id: `${createdId}-v${i}` })),
              activeVariantId: `${createdId}-v0`,
              meta: { createdAt: 0, updatedAt: 0, source: 'manual', hitCount: 0, lastHitAt: null },
            });
          }
          return reply({ kind: 'dispatch', result: { ok: true, createdId } });
        }
        case 'PING':
          state.pings++;
          return reply({ kind: 'pong' });
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
      state.closedCode = code;
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
    'get_page_context',
    'get_status',
    'list_recent_requests',
    'list_rules',
    'list_shell_templates',
    'set_active_variant',
    'set_global_enabled',
    'toggle_mock',
    'update_mock',
    'add_variant',
  ];
  const missing = expected.filter((n) => !names.includes(n));
  const extra = names.filter((n) => !expected.includes(n));
  check(
    '工具集与预期一致',
    missing.length === 0 && extra.length === 0,
    `缺少 [${missing}] 多出 [${extra}]`,
  );
  check('每个工具都有描述 —— AI 靠它决定什么时候用', tools.every((t) => (t.description ?? '').length > 20));

  // ── 让 AI「知道该用这套工具」的三层保险 ────────────
  // 这三层就是「不用给每个 agent 装 skill」的依据，必须验证真的送到了客户端
  const instr = client.getInstructions?.() ?? '';
  check('instructions 送到了客户端（取代 skill 的那一层）', instr.length > 100, `长度 ${instr.length}`);
  check(
    'instructions 里写了触发词，而不只是工具清单',
    instr.includes('页面没数据') && instr.includes('get_page_context'),
  );
  check('instructions 说明了脱敏边界', instr.includes('redacted'));

  const { prompts } = await client.listPrompts();
  const pnames = prompts.map((p) => p.name).sort();
  check(
    'prompts 已注册（不认 instructions 的客户端靠它兜底）',
    pnames.join(',') === 'add_test_states,fix_missing_data,why_not_working',
    pnames.join(','),
  );
  const got = await client.getPrompt({ name: 'fix_missing_data', arguments: {} });
  check(
    'prompt 展开成可直接执行的操作指引',
    got.messages[0].content.text.includes('list_recent_requests'),
  );

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

  const pageContext = await client.callTool({ name: 'get_page_context', arguments: {} });
  const pageContextJson = JSON.parse(pageContext.content[0].text);
  check(
    'get_page_context 一次给出状态、关键请求和下一步',
    pageContextJson.status.globalEnabled === true &&
      pageContextJson.requests[0].status === 404 &&
      pageContextJson.recommendedNext[0].includes('get_request_detail'),
  );

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

  // ── 规则能力补全 ────────────────────────────────────
  const multi = await client.callTool({
    name: 'create_mock',
    arguments: {
      name: '订单详情',
      url: '/api/order/detail',
      methods: ['GET'],
      hosts: ['shop.example.com'],
      body: '{}',
      variants: [
        { name: '正常', body: '{"id":1}' },
        { name: '空数据', body: '{"list":[]}' },
        { name: '超时', body: '{}', behavior: 'timeout' },
        { name: '报错', body: '{"msg":"err"}', status: 500, headers: { 'x-trace': 'abc' } },
      ],
    },
  });
  check('一次能建多个变体', multi.content[0].text.includes('4 个变体'));
  const multiCmd = ext.dispatched.at(-1);
  check('默认生效的是第一个变体', multiCmd?.payload.draft.activeVariantIndex === 0);
  check(
    'behavior 传达到规则（测超时/断网靠它）',
    multiCmd?.payload.draft.variants[2].response.behavior === 'timeout',
  );
  check(
    '自定义响应头传达到规则',
    multiCmd?.payload.draft.variants[3].response.headers['x-trace'] === 'abc',
  );

  const av = await client.callTool({
    name: 'add_variant',
    arguments: { rule_id: 'rule-1', name: '慢 3 秒', body: '{}', delay_ms: 3000 },
  });
  check('add_variant 可以给已有规则追加变体', av.content[0].text.includes('慢 3 秒'));
  check('add_variant 走的是 CREATE_VARIANT 命令', ext.dispatched.at(-1)?.type === 'CREATE_VARIANT');

  // ── 冲突检测 ────────────────────────────────────────
  const dup = await client.callTool({
    name: 'create_mock',
    arguments: {
      name: '商品列表（重复）',
      url: '/api/goods/list',
      methods: ['GET'],
      hosts: ['shop.example.com'],
      body: '{}',
    },
  });
  check('同 URL 重复建规则会被提示', dup.content[0].text.includes('已经有匹配同一 URL 的规则'));
  check('并建议改用 update_mock', dup.content[0].text.includes('update_mock'));

  const wide = await client.callTool({
    name: 'create_mock',
    arguments: { name: '没限定范围', url: '/api/anything', body: '{}' },
  });
  check('没限定方法/域名时给出提醒', wide.content[0].text.includes('没有限定'));

  const clean = await client.callTool({
    name: 'create_mock',
    arguments: {
      name: '干净的规则',
      url: '/api/brand-new-endpoint',
      methods: ['POST'],
      hosts: ['shop.example.com'],
      body: '{}',
    },
  });
  check('无冲突时不啰嗦', !clean.content[0].text.includes('⚠️') && !clean.content[0].text.includes('💡'));

  // ── 破坏性操作的提示 ────────────────────────────────
  // 前面用 kind:"virtual" 建过规则，关总开关会让它真的 404 —— 必须提醒
  const off = await client.callTool({ name: 'set_global_enabled', arguments: { enabled: false } });
  check('关总开关时提醒虚拟接口会真的失败', off.content[0].text.includes('虚拟接口'), off.content[0].text);

  const bad = await client.callTool({ name: 'delete_mock', arguments: { id: 'nope' } });
  check('删不存在的规则给出明确错误', bad.isError === true);

  // ═══════════════════════════════════════════════════
  // 多个 AI 工具共用一个扩展
  // ═══════════════════════════════════════════════════
  console.log('\n▶ 第二个 MCP 客户端接入同一个扩展\n');

  const t2 = new StdioClientTransport({
    command: 'node',
    args: [SERVER],
    env: { ...process.env, MOCK_STUDIO_TOKEN: TOKEN, MOCK_STUDIO_PORT: String(PORT) },
    stderr: 'pipe',
  });
  const client2 = new Client({ name: 'e2e-2', version: '0' });
  await client2.connect(t2);

  // 第一版这里会直接 EADDRINUSE 退出；现在应该作为 peer 接进来
  const s2 = await client2.callTool({ name: 'get_status', arguments: {} });
  check(
    '第二个客户端能起来（不再撞端口退出）',
    !s2.content[0].text.startsWith('❌'),
    s2.content[0].text.slice(0, 120),
  );
  // 两个客户端同一时刻问同一件事，应该看到同一份状态 —— 它们背后是同一个扩展
  const s1again = await client.callTool({ name: 'get_status', arguments: {} });
  check(
    '两个客户端读到的是【同一个扩展】的数据',
    JSON.parse(s2.content[0].text).ruleCount === JSON.parse(s1again.content[0].text).ruleCount,
    `peer=${JSON.parse(s2.content[0].text).ruleCount} hub=${JSON.parse(s1again.content[0].text).ruleCount}`,
  );

  const before2 = ext.dispatched.length;
  const w2 = await client2.callTool({
    name: 'create_mock',
    arguments: {
      name: '来自第二个客户端',
      url: '/api/from-peer',
      methods: ['GET'],
      hosts: ['shop.example.com'],
      body: '{}',
    },
  });
  check('第二个客户端也能写规则', w2.content[0].text.includes('已创建规则'));
  check('写操作确实落到了同一个扩展', ext.dispatched.length === before2 + 1);

  // ── 死连接清理 ────────────────────────────────────
  console.log('\n▶ 连接生命周期\n');
  const ext2 = await fakeExtension({ port: PORT, token: TOKEN });
  await sleep(300);
  check('新扩展连接会顶掉旧的（旧的收到 4004）', ext.closedCode === 4004, `实际 ${ext.closedCode}`);

  const s3 = await client.callTool({ name: 'get_status', arguments: {} });
  check('顶替后第一个客户端仍然可用', !s3.content[0].text.startsWith('❌'));

  ext2.ws.close();
  await client2.close();
  await t2.close();
  ext.ws.close();
  await client.close();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
