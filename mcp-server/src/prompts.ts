/**
 * MCP Prompts —— 给「不认 instructions 的客户端」和「想直接点一下的用户」用
 *
 * ── 为什么需要它 ────────────────────────────────────
 * 让 AI 知道该用这套工具，有三层保险，从自动到手动：
 *
 *   1. `instructions`（server 上的那段）—— 客户端连上时注入上下文。
 *      **最省事，但不是所有客户端都实现**
 *   2. 工具描述 —— 一定会被 AI 看到，但只解释「这个工具干什么」，
 *      不解释「你现在该不该用它」
 *   3. **Prompts（本文件）** —— 客户端一般会显示成可点的条目/斜杠命令。
 *      用户点一下就等于把完整的操作指引塞给 AI，不依赖任何自动注入
 *
 * 所以第 3 层是兜底：哪怕客户端把前两层都忽略了，用户还有一个能点的入口。
 * 这也是「不用给每个 agent 装 skill」的底气所在。
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/** 拼一条用户消息 —— prompt 的产物就是「替用户说的那句话」 */
function userText(text: string) {
  return {
    messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }],
  };
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'fix_missing_data',
    {
      title: '页面没数据 → 找出缺哪个 mock 并补上',
      description:
        '最常用的入口。会先看页面实际发了哪些请求、哪些没被 mock，' +
        '再照着真实结构补上 mock。不需要你提供 URL。',
      argsSchema: {
        hint: z
          .string()
          .optional()
          .describe('可选：哪个模块/哪块内容没出来，用来缩小范围'),
      },
    },
    ({ hint }) =>
      userText(
        '页面没数据，帮我查一下缺哪个 mock 并补上。请按这个顺序做：\n' +
          '1. list_recent_requests（only_unmocked: true）看页面实际在请求什么，' +
          '找出失败的或返回空的那条 —— 不要问我要 URL\n' +
          '2. 用 get_request_detail 看它的真实响应，确认字段结构\n' +
          '3. 用 create_mock 补上，字段要贴合前端已经在用的那套\n' +
          '4. 做完提醒我刷新页面\n' +
          (hint ? `\n补充线索：${hint}` : ''),
      ),
  );

  server.registerPrompt(
    'add_test_states',
    {
      title: '给某个接口加测试状态（空数据 / 报错 / 超时）',
      description:
        '给接口补上几个变体，之后一键切换就能测空态、错误态、加载态，' +
        '不用改代码也不用反复改 mock 内容。',
      argsSchema: {
        api: z.string().describe('接口关键字，如 /api/goods/list 或「商品列表」'),
        states: z
          .string()
          .optional()
          .describe('要哪些状态，默认「空数据、报错、超时」'),
      },
    },
    ({ api, states }) =>
      userText(
        `给「${api}」这个接口加上测试状态：${states || '空数据、报错、超时'}。\n` +
          '要求：\n' +
          '- 先 list_rules 看它有没有已存在的规则\n' +
          '- 已有规则就用 add_variant 追加（**不要用 update_mock，那会覆盖掉原来的数据**）；' +
          '没有就 create_mock 一次性传多个 variants\n' +
          '- 空数据变体要**保持和正常变体一样的结构**，只把数组清空、数字归零 —— ' +
          '直接给 {} 会让前端解构报错\n' +
          '- 超时用 behavior: "timeout"\n' +
          '- 做完告诉我怎么切换',
      ),
  );

  server.registerPrompt(
    'why_not_working',
    {
      title: 'mock 怎么没生效 → 排查',
      description: '按「总开关 → 规则是否命中 → 是否被遮蔽 → 页面是否刷新」的顺序查一遍。',
    },
    () =>
      userText(
        'mock 好像没生效，帮我排查。按这个顺序：\n' +
          '1. get_status —— 总开关开着吗？有几条规则在生效？\n' +
          '2. list_rules —— 目标规则在不在、开没开、匹配条件对不对\n' +
          '3. list_recent_requests —— 页面实际请求的 URL 和规则的匹配串对得上吗？' +
          'mocked 字段是 true 还是 false？\n' +
          '4. 如果规则存在但没命中，检查是不是被上面某条更宽泛的规则遮蔽了' +
          '（列表顺序即优先级，先到先得）\n' +
          '把结论按「问题出在哪 + 怎么改」告诉我。注意最常见的原因其实是页面没刷新。',
      ),
  );
}
