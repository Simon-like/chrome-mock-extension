/**
 * MCP 工具集
 *
 * ── 读侧才是杀手锏 ──────────────────────────────────
 * 写侧（生成 mock 规则）AI 本来就会做，剪贴板导入也能凑合。
 * 真正没有替代品的是**让 AI 看到页面实际发了哪些请求** ——
 * 现有的 mock 工具全是 GUI，AI 看不见里面发生了什么。
 *
 * 完整闭环：
 * ```
 * AI 写完前端代码，你打开页面，没数据。
 * 你：「页面没数据，帮我 mock 一下」
 *   list_recent_requests   → 看到页面在请求 /api/goods/list，返回 404
 *   get_request_detail     → 确认参数是 { page, size, keyword }
 *   create_mock            → 造一个贴合参数结构的分页响应
 * 你刷新页面 → 有数据了
 * ```
 * 全程你只说了一句话，没有手抄 URL，没有写 JSON。
 *
 * ── 写侧为什么这么薄 ────────────────────────────────
 * 每个写工具都只是「拼一个 Command 发过去」。因为扩展里所有状态变更
 * 本来就只有 `dispatch(command)` 一个入口（A3）—— 校验、副作用、广播
 * 全在那一条路上，这边不需要也不应该重写一遍。
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BridgeServer } from './bridge.js';
import type { BridgeData, RedactedCapture } from '../../src/shared/bridge.js';
import type { MockStore, Rule } from '../../src/core/types.js';
import type { Command } from '../../src/core/command/types.js';
import { createRuleDraft, createResponseSpec } from '../../src/core/store/defaults.js';

type Json = { content: { type: 'text'; text: string }[]; isError?: boolean };

const text = (s: string): Json => ({ content: [{ type: 'text', text: s }] });
const json = (v: unknown): Json => text(JSON.stringify(v, null, 2));

export function registerTools(server: McpServer, bridge: BridgeServer): void {
  /** 所有工具共用的错误处理：把异常变成 AI 看得懂的文本，而不是协议层错误 */
  const guard =
    <A extends object>(fn: (args: A) => Promise<Json>) =>
    async (args: A): Promise<Json> => {
      try {
        return await fn(args);
      } catch (e) {
        return { ...text(`❌ ${(e as Error).message}`), isError: true };
      }
    };

  const getState = async (): Promise<MockStore> => {
    const d = (await bridge.request({ type: 'GET_STATE' })) as Extract<
      BridgeData,
      { kind: 'state' }
    >;
    return d.store;
  };

  const dispatch = (command: Command) => bridgeDispatch(bridge, command);

  // ═══════════════════════════════════════════════════
  // 读侧
  // ═══════════════════════════════════════════════════

  server.registerTool(
    'list_recent_requests',
    {
      title: '列出页面最近发出的请求',
      description:
        '列出浏览器页面最近实际发出的网络请求（fetch / XHR），最新的在前。' +
        '这是判断「该 mock 什么」的第一步 —— 不用让用户手抄 URL。' +
        '返回的 URL 与响应体已强制脱敏（token/cookie 等被打码），redacted 为 true 表示本条有内容被隐去。',
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional().describe('返回条数，默认 30'),
        url_filter: z.string().optional().describe('只看 URL 含该子串的请求'),
        only_unmocked: z
          .boolean()
          .optional()
          .describe('只看【没有】被 mock 命中的请求 —— 找「缺哪个 mock」时用这个'),
        only_mocked: z.boolean().optional().describe('只看已被 mock 命中的请求'),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async (a) => {
      const d = (await bridge.request({
        type: 'GET_CAPTURES',
        limit: a.limit,
        urlFilter: a.url_filter,
        onlyMocked: a.only_mocked,
        onlyUnmocked: a.only_unmocked,
      })) as Extract<BridgeData, { kind: 'captures' }>;

      if (d.readDisabled) {
        return text(
          '读侧已被用户关闭（扩展设置页 → MCP → 允许 AI 读取请求记录）。' +
            '写侧工具仍然可用，但需要用户自己提供接口 URL。',
        );
      }
      if (d.entries.length === 0) {
        return text(
          '没有采集到请求。可能的原因：① 页面还没发过请求，让用户刷新一下；' +
            '② 扩展设置里关掉了请求采集；③ 域名白名单把这些请求过滤掉了。',
        );
      }
      return json({
        total: d.total,
        showing: d.entries.length,
        requests: d.entries.map(brief),
      });
    }),
  );

  server.registerTool(
    'get_request_detail',
    {
      title: '看某个请求的完整内容',
      description:
        '按 id 取一条请求的完整记录，含响应体 —— 用它确认真实的数据结构，' +
        '生成的 mock 才能贴合前端已经在用的字段。id 来自 list_recent_requests。',
      inputSchema: { id: z.string().describe('请求 id') },
      annotations: { readOnlyHint: true },
    },
    guard(async (a) => {
      const d = (await bridge.request({
        type: 'GET_CAPTURE_DETAIL',
        captureId: a.id,
      })) as Extract<BridgeData, { kind: 'captureDetail' }>;
      if (d.readDisabled) return text('读侧已被用户关闭。');
      if (!d.entry) return text(`没有找到 id 为 ${a.id} 的请求，它可能已经被环形缓冲挤掉了。`);
      return json(d.entry);
    }),
  );

  server.registerTool(
    'list_rules',
    {
      title: '列出现有的 mock 规则',
      description:
        '列出当前所有 mock 规则及其变体。改规则前先调它拿 id；' +
        '也用来回答「现在哪些接口被 mock 了」。',
      inputSchema: {
        url_filter: z.string().optional().describe('只看匹配串含该子串的规则'),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async (a) => {
      const store = await getState();
      let rules = store.rules;
      if (a.url_filter) {
        const kw = a.url_filter.toLowerCase();
        rules = rules.filter(
          (r) => r.match.url.toLowerCase().includes(kw) || r.name.toLowerCase().includes(kw),
        );
      }
      return json({
        globalEnabled: store.enabled,
        total: rules.length,
        rules: rules.map(ruleBrief),
      });
    }),
  );

  server.registerTool(
    'list_shell_templates',
    {
      title: '列出响应外壳模板',
      description:
        '列出可用的响应外壳（如 {status,message,data}）。' +
        '公司的接口一般有统一外壳，生成 mock 时把 shellTemplateId 选对，' +
        'body 里就只写业务数据，不用每条都手写一遍外壳。',
      annotations: { readOnlyHint: true },
    },
    guard(async () => {
      const store = await getState();
      return json(
        store.shellTemplates.map((t) => ({ id: t.id, name: t.name, template: t.template })),
      );
    }),
  );

  server.registerTool(
    'get_status',
    {
      title: '看 Mock Studio 当前状态',
      description: '总开关是否打开、有多少规则生效、读侧是否可用。排查「为什么 mock 没生效」时先看它。',
      annotations: { readOnlyHint: true },
    },
    guard(async () => {
      const store = await getState();
      const enabled = store.rules.filter((r) => r.enabled);
      return json({
        globalEnabled: store.enabled,
        ruleCount: store.rules.length,
        enabledRuleCount: enabled.length,
        virtualEndpointCount: enabled.filter((r) => r.kind === 'virtual').length,
        aiReadEnabled: store.settings.aiReadEnabled,
        aiHostWhitelist: store.settings.aiHostWhitelist,
        captureEnabled: store.settings.captureEnabled,
      });
    }),
  );

  // ═══════════════════════════════════════════════════
  // 写侧
  // ═══════════════════════════════════════════════════

  server.registerTool(
    'create_mock',
    {
      title: '新建一条 mock 规则',
      description:
        '新建一条 mock 规则。kind 选 override（接口真实存在，只改响应）' +
        '或 virtual（后端还没这个接口，凭空造一个 —— 不会 404、不触发 CORS 预检）。\n' +
        'body 是【字符串】不是对象。bodyType 决定怎么解释它：\n' +
        '- static：body 是一段 JSON\n' +
        '- mockjs：body 是数据模板，如 {"list|10":[{"id|+1":1,"name":"@cname"}]}\n' +
        '- dynamic：body 是 JS 源码，如 (req) => ({ page: Number(req.query.page) })',
      inputSchema: {
        name: z.string().describe('规则名，给人看的'),
        url: z.string().describe('匹配串。通常填 pathname，如 /api/goods/list'),
        url_mode: z.enum(['contains', 'wildcard', 'regex']).optional().describe('默认 contains'),
        methods: z.array(z.string()).optional().describe('限定请求方法，不填=全部'),
        hosts: z.array(z.string()).optional().describe('限定域名，不填=不限'),
        kind: z.enum(['override', 'virtual']).optional().describe('默认 override'),
        status: z.number().int().optional().describe('HTTP 状态码，默认 200'),
        body: z.string().describe('响应体字符串，含义由 body_type 决定'),
        body_type: z.enum(['static', 'mockjs', 'dynamic']).optional().describe('默认 static'),
        shell_template_id: z
          .string()
          .optional()
          .describe('响应外壳 id，见 list_shell_templates。填了 body 就只写业务数据'),
        delay_ms: z.number().int().min(0).optional().describe('模拟慢网络'),
      },
    },
    guard(async (a) => {
      const draft = createRuleDraft({
        name: a.name,
        kind: a.kind ?? 'override',
        match: {
          urlMode: a.url_mode ?? 'contains',
          url: a.url,
          methods: (a.methods ?? []) as never,
          hosts: a.hosts ?? [],
        },
        variants: [
          {
            name: '默认',
            response: createResponseSpec({
              status: a.status ?? 200,
              body: a.body,
              bodyType: a.body_type ?? 'static',
              shellTemplateId: a.shell_template_id ?? null,
              delayMs: a.delay_ms ?? 0,
            }),
          },
        ],
      });
      const r = await dispatch({ type: 'CREATE_RULE', payload: { draft } });
      return text(
        `✅ 已创建规则「${a.name}」（id: ${r.createdId}）。` +
          '规则立即生效，但**页面已经发出的请求不会重来** —— 让用户刷新页面。',
      );
    }),
  );

  server.registerTool(
    'update_mock',
    {
      title: '改一条已有规则的响应',
      description:
        '改一条规则【当前生效变体】的响应体 / 状态码 / 延迟。id 来自 list_rules。\n' +
        '注意它改的是现有变体，不会新建变体 —— 想保留原来那份数据、另外加一份' +
        '（比如再来个空态版本），应该让用户在扩展里新建变体，或者用 create_mock 另建一条规则。',
      inputSchema: {
        id: z.string(),
        body: z.string().optional(),
        body_type: z.enum(['static', 'mockjs', 'dynamic']).optional(),
        status: z.number().int().optional(),
        delay_ms: z.number().int().min(0).optional(),
      },
    },
    guard(async (a) => {
      const store = await getState();
      const rule = store.rules.find((r) => r.id === a.id);
      if (!rule) return { ...text(`没有 id 为 ${a.id} 的规则`), isError: true };

      const variantId = rule.activeVariantId;
      const cur = rule.variants.find((v) => v.id === variantId) ?? rule.variants[0]!;
      await dispatch({
        type: 'UPDATE_VARIANT',
        payload: {
          ruleId: a.id,
          variantId: cur.id,
          patch: {
            response: {
              ...cur.response,
              ...(a.body !== undefined ? { body: a.body } : {}),
              ...(a.body_type !== undefined ? { bodyType: a.body_type } : {}),
              ...(a.status !== undefined ? { status: a.status } : {}),
              ...(a.delay_ms !== undefined ? { delayMs: a.delay_ms } : {}),
            },
          },
        },
      });
      return text(`✅ 已更新规则「${rule.name}」的变体「${cur.name}」。让用户刷新页面生效。`);
    }),
  );

  server.registerTool(
    'toggle_mock',
    {
      title: '启用 / 停用一条规则',
      description:
        '让一条规则暂时不生效，但保留它。想「先看看真实接口返回什么」时用这个，' +
        '比删掉再重建省事得多。\n' +
        '⚠️ 如果这条是 virtual（后端还没有的接口），停用后请求会真的 404 —— 停之前提醒用户。',
      inputSchema: { id: z.string(), enabled: z.boolean() },
    },
    guard(async (a) => {
      await dispatch({ type: 'TOGGLE_RULE', payload: { id: a.id, enabled: a.enabled } });
      return text(`✅ 规则已${a.enabled ? '启用' : '停用'}。`);
    }),
  );

  server.registerTool(
    'delete_mock',
    {
      title: '删除一条规则',
      description:
        '删除一条 mock 规则。**不可撤销** —— 调用前先向用户确认，' +
        '只是想临时停掉的话用 toggle_mock。',
      inputSchema: { id: z.string() },
      annotations: { destructiveHint: true },
    },
    guard(async (a) => {
      const store = await getState();
      const rule = store.rules.find((r) => r.id === a.id);
      if (!rule) return { ...text(`没有 id 为 ${a.id} 的规则`), isError: true };
      await dispatch({ type: 'DELETE_RULE', payload: { id: a.id } });
      return text(`✅ 已删除规则「${rule.name}」。`);
    }),
  );

  server.registerTool(
    'set_active_variant',
    {
      title: '切换规则当前生效的变体',
      description:
        '一条规则可以有多份响应（正常/空数据/报错/慢…），这里切换哪一份生效。' +
        '测空态、测报错就靠它 —— 比改 body 快，也不会把原来的数据弄丢。变体 id 见 list_rules。',
      inputSchema: { rule_id: z.string(), variant_id: z.string() },
    },
    guard(async (a) => {
      await dispatch({
        type: 'SET_ACTIVE_VARIANT',
        payload: { ruleId: a.rule_id, variantId: a.variant_id },
      });
      return text('✅ 已切换变体。让用户刷新页面生效。');
    }),
  );

  server.registerTool(
    'set_global_enabled',
    {
      title: '切换 Mock 总开关',
      description:
        '一次性开关所有 mock。⚠️ 关掉后【虚拟接口会真的 404】—— ' +
        '如果有 virtual 规则在用，关之前提醒用户。',
      inputSchema: { enabled: z.boolean() },
    },
    guard(async (a) => {
      const store = await getState();
      const virtual = store.rules.filter((r) => r.enabled && r.kind === 'virtual').length;
      await dispatch({ type: 'SET_GLOBAL_ENABLED', payload: { enabled: a.enabled } });
      const warn =
        !a.enabled && virtual > 0
          ? `\n⚠️ 有 ${virtual} 个虚拟接口，关闭后这些请求会真的失败。`
          : '';
      return text(`✅ Mock 总开关已${a.enabled ? '打开' : '关闭'}。${warn}`);
    }),
  );
}

// ═══════════════════════════════════════════════════════════

/**
 * 所有写工具的唯一出口：拼一个 Command 发给扩展。
 *
 * 直接标注成 `Command` —— 之前想从 BridgeServer['request'] 的参数里
 * 反推这个类型，绕了一大圈还推成了 never。类型能直接写清楚时就别推导。
 */
async function bridgeDispatch(bridge: BridgeServer, command: Command) {
  const d = (await bridge.request({ type: 'DISPATCH', command })) as Extract<
    BridgeData,
    { kind: 'dispatch' }
  >;
  if (!d.result.ok) throw new Error(d.result.error ?? '命令被拒绝');
  return d.result;
}

/** 列表里给 AI 看的精简形态 —— 全量字段会把上下文撑爆，也没必要 */
function brief(e: RedactedCapture) {
  return {
    id: e.id,
    method: e.method,
    url: e.url,
    status: e.status,
    mocked: e.mocked,
    ruleName: e.ruleName,
    redacted: e.redacted,
    bodyPreview: e.body ? e.body.slice(0, 200) : null,
  };
}

function ruleBrief(r: Rule) {
  return {
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    kind: r.kind,
    match: r.match,
    hitCount: r.meta.hitCount,
    activeVariantId: r.activeVariantId,
    variants: r.variants.map((v) => ({
      id: v.id,
      name: v.name,
      status: v.response.status,
      bodyType: v.response.bodyType,
    })),
  };
}
