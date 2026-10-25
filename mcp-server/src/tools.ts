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
import type { BridgeTransport } from './bridge.js';
import type { BridgeData, RedactedCapture } from '../../src/shared/bridge.js';
import type { MockStore, Rule } from '../../src/core/types.js';
import type { Command } from '../../src/core/command/types.js';
import { createRuleDraft, createResponseSpec } from '../../src/core/store/defaults.js';
import { findShadowedRules } from '../../src/core/store/validate.js';
import { presentCaptureDetail } from '../../src/core/mcp/responseDetail.js';
import type { ResponseSpec } from '../../src/core/types.js';

type Json = { content: { type: 'text'; text: string }[]; isError?: boolean };

/**
 * 一份响应的完整可配项 —— 和 UI 上能填的东西一一对应。
 *
 * 之前 create_mock 只暴露了 status/body/delay，headers 和 behavior 填不了，
 * 于是「模拟请求超时」「模拟断网」这类最常见的测试场景 AI 根本做不到。
 * 工具能表达的东西比 UI 少，AI 就只能让用户自己去点 —— 那 MCP 就白做了一半。
 */
const variantShape = {
  status: z.number().int().min(100).max(599).optional().describe('HTTP 状态码，默认 200'),
  body: z.string().describe('响应体字符串，含义由 body_type 决定'),
  body_type: z.enum(['static', 'mockjs', 'dynamic']).optional().describe('默认 static'),
  delay_ms: z.number().int().min(0).optional().describe('模拟慢网络'),
  headers: z
    .record(z.string(), z.string())
    .optional()
    .describe('自定义响应头。content-type 默认是 application/json，要改在这里覆盖'),
  behavior: z
    .enum(['normal', 'timeout', 'networkError'])
    .optional()
    .describe(
      'normal=正常返回；timeout=请求永远挂起（测加载态/超时处理）；' +
        'networkError=直接网络错误（测断网兜底）。后两种时 body 不会被使用',
    ),
  shell_template_id: z
    .string()
    .optional()
    .describe('响应外壳 id，见 list_shell_templates。填了 body 就只写业务数据'),
};

type VariantInput = {
  status?: number;
  body: string;
  body_type?: 'static' | 'mockjs' | 'dynamic';
  delay_ms?: number;
  headers?: Record<string, string>;
  behavior?: 'normal' | 'timeout' | 'networkError';
  shell_template_id?: string;
};

function toResponseSpec(v: VariantInput): ResponseSpec {
  return createResponseSpec({
    status: v.status ?? 200,
    body: v.body,
    bodyType: v.body_type ?? 'static',
    delayMs: v.delay_ms ?? 0,
    headers: v.headers ?? {},
    behavior: v.behavior ?? 'normal',
    shellTemplateId: v.shell_template_id ?? null,
  });
}

const text = (s: string): Json => ({ content: [{ type: 'text', text: s }] });
const json = (v: unknown): Json => text(JSON.stringify(v, null, 2));

export function registerTools(server: McpServer, bridge: BridgeTransport): void {
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
    'get_page_context',
    {
      title: '一次看懂当前页面的 Mock 上下文',
      description:
        '处理「页面没数据 / mock 怎么没生效 / 帮我补接口」时优先调用。' +
        '只读取最后聚焦 Chrome 窗口里的活动标签页，不混入其他页面的请求。' +
        '一次返回页面信息、总开关、规则摘要、最近异常或未命中的请求，以及下一步建议，' +
        '避免每个 agent 先后调用 get_status、list_recent_requests、list_rules 才建立上下文。' +
        '为了控制上下文体积只带响应预览；需要完整结构再用 get_request_detail。',
      inputSchema: {
        url_filter: z.string().optional().describe('只关注 URL 或规则名含该关键词的上下文'),
        limit: z.number().int().min(1).max(20).optional().describe('最多返回多少条请求，默认 8'),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async (a) => {
      // 两个读取互不依赖，并发走本地桥；agent 只承担一次 MCP 往返。
      const [store, captureData] = await Promise.all([
        getState(),
        bridge.request({
          type: 'GET_CAPTURES',
          limit: 20,
          urlFilter: a.url_filter,
          activeTab: true,
        }) as Promise<Extract<BridgeData, { kind: 'captures' }>>,
      ]);

      const kw = a.url_filter?.trim().toLowerCase();
      const important = captureData.entries
        .filter((e) => !e.mocked || (e.status !== null && e.status >= 400))
        .slice(0, a.limit ?? 8);
      const relevantRules = store.rules
        .filter((r) =>
          kw
            ? r.name.toLowerCase().includes(kw) || r.match.url.toLowerCase().includes(kw)
            : important.some((e) => e.url.includes(r.match.url)),
        )
        .slice(0, 8);

      const recommendedNext: string[] = [];
      if (!store.enabled) recommendedNext.push('Mock 总开关已关闭：需要 mock 时调用 set_global_enabled。');
      if (captureData.readDisabled) {
        recommendedNext.push('读侧已关闭：请用户开启“允许 AI 读取请求记录”，或直接提供接口 URL。');
      } else if (!captureData.page) {
        recommendedNext.push('没有找到活动标签页：请用户先切到要调试的 Chrome 页面。');
      } else if (captureData.entries.length === 0) {
        recommendedNext.push('当前标签页没有近期请求：让用户刷新页面或重新触发操作。');
      } else {
        const broken = important.find((e) => !e.mocked && (e.status === null || e.status >= 400));
        if (broken) {
          recommendedNext.push(
            `先用 get_request_detail(id: "${broken.id}") 对齐字段，再决定 create_mock 或更新已有规则。`,
          );
        } else if (important.some((e) => !e.mocked)) {
          recommendedNext.push('存在未命中请求：确认它是否需要 Mock，再创建或收窄匹配条件。');
        } else {
          recommendedNext.push('近期关键请求已命中；如页面仍异常，查看具体请求详情和当前激活变体。');
        }
      }

      return json({
        page: captureData.page ?? null,
        status: {
          globalEnabled: store.enabled,
          enabledRuleCount: store.rules.filter((r) => r.enabled).length,
          totalRuleCount: store.rules.length,
          aiReadEnabled: store.settings.aiReadEnabled,
          captureEnabled: store.settings.captureEnabled,
        },
        requests: captureData.readDisabled ? [] : important.map(brief),
        relevantRules: relevantRules.map(ruleBrief),
        recommendedNext,
        note: '响应只含预览；用 get_request_detail 默认读取结构摘要，确需原文再选 sample/full。',
      });
    }),
  );

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
      title: '按需读取请求详情与响应结构',
      description:
        '按 id 取一条请求。默认 body_mode=schema，只返回 JSON 字段结构、数组首项和短示例，' +
        '避免完整响应体撑爆上下文。需要原始内容时显式用 sample 或 full；两者都按字节限制分段。' +
        'id 来自 get_page_context 或 list_recent_requests。',
      inputSchema: {
        id: z.string().describe('请求 id'),
        body_mode: z
          .enum(['schema', 'sample', 'full'])
          .optional()
          .describe('schema=结构摘要（默认）；sample=原始样本，默认 8KiB；full=原始分段，默认 16KiB'),
        max_bytes: z
          .number()
          .int()
          .min(1)
          .max(65536)
          .optional()
          .describe('sample/full 单次最多返回的 UTF-8 字节数，硬上限 64KiB'),
        cursor: z.string().optional().describe('上一次 sample/full 返回的 nextCursor，用于续读'),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async (a) => {
      const d = (await bridge.request({
        type: 'GET_CAPTURE_DETAIL',
        captureId: a.id,
      })) as Extract<BridgeData, { kind: 'captureDetail' }>;
      if (d.readDisabled) return text('读侧已被用户关闭。');
      if (!d.entry) return text(`没有找到 id 为 ${a.id} 的请求，它可能已经被环形缓冲挤掉了。`);
      return json(
        presentCaptureDetail(d.entry, {
          mode: a.body_mode ?? 'schema',
          maxBytes: a.max_bytes,
          cursor: a.cursor,
        }),
      );
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
        '- dynamic：body 是 JS 源码，如 (req) => ({ page: Number(req.query.page) })\n\n' +
        '**要测多种状态就一次性传 variants**（正常/空数据/报错…），' +
        '之后用 set_active_variant 一键切换 —— 比建多条规则再互相启停干净得多。\n' +
        '创建后会自动检查是否和已有规则冲突（遮蔽/重复），有问题会在返回里说明。',
      inputSchema: {
        name: z.string().describe('规则名，给人看的'),
        url: z.string().describe('匹配串。通常填 pathname，如 /api/goods/list'),
        url_mode: z.enum(['contains', 'wildcard', 'regex']).optional().describe('默认 contains'),
        methods: z
          .array(z.string())
          .optional()
          .describe('限定请求方法。**强烈建议填**，不填会匹配该 URL 的所有方法，容易误伤'),
        hosts: z
          .array(z.string())
          .optional()
          .describe('限定域名。**强烈建议填**，不填的话别的站点上同名路径也会被 mock'),
        kind: z.enum(['override', 'virtual']).optional().describe('默认 override'),
        ...variantShape,
        variants: z
          .array(z.object({ name: z.string().describe('变体名，如「空数据」「报错」'), ...variantShape }))
          .optional()
          .describe(
            '一次建多个变体。给了它就忽略上面那组扁平参数。' +
              '第一个是默认生效的，所以把最常用的那份放第一位',
          ),
      },
    },
    guard(async (a) => {
      const variants =
        a.variants && a.variants.length > 0
          ? a.variants.map((v) => ({ name: v.name, response: toResponseSpec(v) }))
          : [{ name: '默认', response: toResponseSpec(a) }];

      const before = await getState();
      const draft = createRuleDraft({
        name: a.name,
        kind: a.kind ?? 'override',
        match: {
          urlMode: a.url_mode ?? 'contains',
          url: a.url,
          methods: (a.methods ?? []) as never,
          hosts: a.hosts ?? [],
        },
        variants,
      });
      const r = await dispatch({ type: 'CREATE_RULE', payload: { draft } });

      const after = await getState();
      const notes = [
        ...duplicateNotes(before, a.url, a.methods),
        ...shadowNotes(after, r.createdId ?? ''),
        ...scopeNotes(a.methods, a.hosts),
      ];

      return text(
        `✅ 已创建规则「${a.name}」（id: ${r.createdId}）` +
          (variants.length > 1 ? `，含 ${variants.length} 个变体，默认生效「${variants[0]!.name}」` : '') +
          '。\n规则立即生效，但**页面已经发出的请求不会重来** —— 让用户刷新页面。' +
          (notes.length ? `\n\n${notes.join('\n')}` : ''),
      );
    }),
  );

  server.registerTool(
    'add_variant',
    {
      title: '给已有规则加一个变体',
      description:
        '在一条规则上追加一份响应（如「空数据」「报错」「超时」），原来的不会丢。\n' +
        '想测空态/错误态时用这个，而不是 update_mock —— update_mock 会**覆盖**当前那份数据。\n' +
        '加完用 set_active_variant 切过去。',
      inputSchema: {
        rule_id: z.string(),
        name: z.string().describe('变体名，如「空数据」「500 报错」'),
        activate: z
          .boolean()
          .optional()
          .describe('建完是否立刻切过去，默认 true。想先建着不影响页面就传 false'),
        ...variantShape,
      },
    },
    guard(async (a) => {
      const store = await getState();
      const rule = store.rules.find((x) => x.id === a.rule_id);
      if (!rule) return { ...text(`没有 id 为 ${a.rule_id} 的规则`), isError: true };

      await dispatch({
        type: 'CREATE_VARIANT',
        payload: {
          ruleId: a.rule_id,
          name: a.name,
          response: toResponseSpec(a),
          activate: a.activate ?? true,
        },
      });
      return text(
        `✅ 已给规则「${rule.name}」加上变体「${a.name}」` +
          (a.activate === false ? '（未切换，当前仍是原来那份）' : '，并已切为生效') +
          '。让用户刷新页面生效。',
      );
    }),
  );

  server.registerTool(
    'update_mock',
    {
      title: '改一条已有规则的响应',
      description:
        '改一条规则某个变体的响应（默认改当前生效的那个）。id 来自 list_rules。\n' +
        '⚠️ 它是**覆盖**，原来那份数据就没了。想保留原数据、另外加一份（比如再来个空态版本），' +
        '用 add_variant。\n' +
        '只传想改的字段，没传的保持原样。',
      inputSchema: {
        id: z.string(),
        variant_id: z
          .string()
          .optional()
          .describe('要改哪个变体，不填则改当前生效的那个。id 见 list_rules'),
        variant_name: z.string().optional().describe('顺便给变体改个名'),
        status: z.number().int().min(100).max(599).optional(),
        body: z.string().optional(),
        body_type: z.enum(['static', 'mockjs', 'dynamic']).optional(),
        delay_ms: z.number().int().min(0).optional(),
        headers: z.record(z.string(), z.string()).optional(),
        behavior: z.enum(['normal', 'timeout', 'networkError']).optional(),
        shell_template_id: z.string().optional(),
      },
    },
    guard(async (a) => {
      const store = await getState();
      const rule = store.rules.find((r) => r.id === a.id);
      if (!rule) return { ...text(`没有 id 为 ${a.id} 的规则`), isError: true };

      const target =
        (a.variant_id ? rule.variants.find((v) => v.id === a.variant_id) : undefined) ??
        rule.variants.find((v) => v.id === rule.activeVariantId) ??
        rule.variants[0]!;
      if (a.variant_id && target.id !== a.variant_id) {
        return { ...text(`规则「${rule.name}」下没有 id 为 ${a.variant_id} 的变体`), isError: true };
      }

      // 只覆盖显式传进来的字段，其余保持原样 —— 传了 body 就不该把 delay 也重置掉
      const patched = {
        ...target.response,
        ...(a.status !== undefined ? { status: a.status } : {}),
        ...(a.body !== undefined ? { body: a.body } : {}),
        ...(a.body_type !== undefined ? { bodyType: a.body_type } : {}),
        ...(a.delay_ms !== undefined ? { delayMs: a.delay_ms } : {}),
        ...(a.headers !== undefined ? { headers: a.headers } : {}),
        ...(a.behavior !== undefined ? { behavior: a.behavior } : {}),
        ...(a.shell_template_id !== undefined
          ? { shellTemplateId: a.shell_template_id || null }
          : {}),
      };

      await dispatch({
        type: 'UPDATE_VARIANT',
        payload: {
          ruleId: a.id,
          variantId: target.id,
          patch: {
            response: patched,
            ...(a.variant_name !== undefined ? { name: a.variant_name } : {}),
          },
        },
      });
      return text(
        `✅ 已更新规则「${rule.name}」的变体「${a.variant_name ?? target.name}」。让用户刷新页面生效。`,
      );
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
async function bridgeDispatch(bridge: BridgeTransport, command: Command) {
  const d = (await bridge.request({ type: 'DISPATCH', command })) as Extract<
    BridgeData,
    { kind: 'dispatch' }
  >;
  if (!d.result.ok) throw new Error(d.result.error ?? '命令被拒绝');
  return d.result;
}

// ═══════════════════════════════════════════════════════════
// 冲突检测
// ═══════════════════════════════════════════════════════════
//
// AI 建规则时看不到列表，很容易造出「建了但永远不生效」的规则 ——
// 而这种规则最难查：它就在那儿、开着、看起来没问题，就是不命中。
// 所以建完立刻回答三个问题：会不会被遮蔽、会不会遮蔽别人、条件是不是太宽。
//
// 检测逻辑直接复用 core 里 UI 用的那份（findShadowedRules），
// 不重写一套 —— 两套判定迟早会不一致，那比没有检测更糟。

/** 新规则是否被上面某条更宽泛的规则挡住了（或反过来挡住了别人） */
function shadowNotes(store: MockStore, newRuleId: string): string[] {
  if (!newRuleId) return [];
  const shadowed = findShadowedRules(store.rules);
  const nameOf = (id: string) => store.rules.find((r) => r.id === id)?.name ?? id;
  const out: string[] = [];

  const shadower = shadowed.get(newRuleId);
  if (shadower) {
    out.push(
      `⚠️ **这条规则可能永远不会命中** —— 它被上方的「${nameOf(shadower)}」遮蔽了。` +
        `列表顺序即优先级，先到先得。要么把这条往上挪，要么改窄「${nameOf(shadower)}」的匹配条件。`,
    );
  }
  const victims = [...shadowed.entries()]
    .filter(([id, by]) => by === newRuleId && id !== newRuleId)
    .map(([id]) => nameOf(id));
  if (victims.length > 0) {
    out.push(`⚠️ 这条规则会遮蔽已有规则：${victims.join('、')} —— 它们将不再生效。`);
  }
  return out;
}

/** 同一个 URL 已经有规则了 —— 多半该改而不是再建一条 */
function duplicateNotes(store: MockStore, url: string, methods?: string[]): string[] {
  const u = url.trim().toLowerCase();
  if (!u) return [];
  const dup = store.rules.filter((r) => {
    if (r.match.url.trim().toLowerCase() !== u) return false;
    // 方法不重叠就不算冲突（GET 一条、POST 一条是合理的）
    if (!methods || methods.length === 0 || r.match.methods.length === 0) return true;
    return r.match.methods.some((m) => methods.includes(m));
  });
  return dup.length === 0
    ? []
    : [
        `⚠️ 已经有匹配同一 URL 的规则：${dup.map((r) => `「${r.name}」`).join('、')}。` +
          `如果本意是改它的返回，应该用 update_mock 或 add_variant，而不是再建一条 —— ` +
          `两条都开着时只有靠前的那条生效。`,
      ];
}

/** 匹配条件太宽的提醒。不阻止，只是让 AI 知道自己刚做了什么 */
function scopeNotes(methods?: string[], hosts?: string[]): string[] {
  const missing: string[] = [];
  if (!methods || methods.length === 0) missing.push('请求方法');
  if (!hosts || hosts.length === 0) missing.push('域名');
  return missing.length === 0
    ? []
    : [
        `💡 没有限定${missing.join('和')}，这条规则会在更大范围内生效。` +
          `如果只想在某个站点/某个方法上 mock，补上会更安全。`,
      ];
}

/** 列表里给 AI 看的精简形态 —— 全量字段会把上下文撑爆，也没必要 */
function brief(e: RedactedCapture) {
  return {
    id: e.id,
    tabId: e.tabId,
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
