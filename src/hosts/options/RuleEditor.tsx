/**
 * 规则编辑器
 *
 * 这里【没有业务逻辑】—— 校验来自 core/store/validate，保存是 dispatch 一个 Command。
 * UI 只负责收集输入和展示反馈。这正是分层的目的：MCP 走同一套 core，无需重写。
 *
 * 变体是本编辑器的核心结构：上半部分是规则级配置（名称、匹配条件），
 * 下半部分是变体级配置（状态码、延迟、响应体），中间用标签页切换。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { validateRule } from '@core/store/validate.js';
import { createResponseSpec, createRuleDraft } from '@core/store/defaults.js';
import {
  HTTP_METHODS,
  type BodyType,
  type Group,
  type HttpMethod,
  type Project,
  type ResponseSpec,
  type Rule,
  type RuleDraft,
  type ShellTemplate,
} from '@core/types.js';
import { CodeEditor } from '@ui/CodeEditor.js';

interface Props {
  /** 编辑现有规则时传入 */
  initial?: Rule;
  /** 以一份预填草稿开始（Capture-to-Mock 用这个）。与 initial 互斥 */
  initialDraft?: RuleDraft;
  /** 草稿入口的明确语义，避免把「新建虚拟接口」误写成「从请求创建」 */
  title?: string;
  projects?: Project[];
  groups?: Group[];
  shellTemplates: ShellTemplate[];
  /** 返回是否保存成功 */
  onSave: (draft: RuleDraft) => Promise<boolean> | boolean;
  onClose: () => void;
}

export function RuleEditor({
  initial,
  initialDraft,
  title: titleOverride,
  projects,
  groups,
  shellTemplates,
  onSave,
  onClose,
}: Props) {
  const [draft, setDraft] = useState<RuleDraft>(
    () => initialDraft ?? (initial ? toDraft(initial) : createRuleDraft()),
  );
  const [activeIdx, setActiveIdx] = useState(() => draft.activeVariantIndex ?? 0);
  const [renamingVariant, setRenamingVariant] = useState(false);

  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => void (flashTimer.current && clearTimeout(flashTimer.current)), []);

  const issues = useMemo(() => validateRule(draft as never), [draft]);
  const errors = issues.filter((i) => i.level === 'error');
  const warnings = issues.filter((i) => i.level === 'warning');

  const serialized = JSON.stringify({ ...draft, activeVariantIndex: activeIdx });
  const dirty = savedSnapshot === null || savedSnapshot !== serialized;

  const variant = draft.variants[activeIdx] ?? draft.variants[0]!;

  const patch = (p: Partial<RuleDraft>) => setDraft((d) => ({ ...d, ...p }));
  const patchMatch = (p: Partial<RuleDraft['match']>) =>
    setDraft((d) => ({ ...d, match: { ...d.match, ...p } }));

  /** 只改当前变体的响应，其他变体不受影响 */
  const patchResponse = (p: Partial<ResponseSpec>) =>
    setDraft((d) => ({
      ...d,
      variants: d.variants.map((v, i) =>
        i === activeIdx ? { ...v, response: { ...v.response, ...p } } : v,
      ),
    }));

  const bodyType = variant.response.bodyType;
  const isDynamic = bodyType === 'dynamic';
  const isMockjs = bodyType === 'mockjs';

  /**
   * 切换响应体类型。
   *
   * 关键在于**不能直接把 body 扔掉** —— 那是用户敲了半天的东西。
   * 但三种 body 互不兼容（JSON / 带规则的 JSON / JS 源码），留着又会让
   * 编辑器里躺着一坨错误。折中：只在 body 还是「一眼可丢弃」的初始值时
   * 才自动换成对应的起手模板，否则原样保留，让用户自己决定怎么改。
   */
  const switchBodyType = (next: BodyType) => {
    if (bodyType === next) return;
    const cur = variant.response.body.trim();
    const disposable =
      cur === '' ||
      cur === '{}' ||
      cur === DYNAMIC_SNIPPETS[0]!.code.trim() ||
      cur === MOCKJS_SNIPPETS[0]!.code.trim();
    patchResponse({
      bodyType: next,
      ...(disposable ? { body: STARTER_BODY[next] } : {}),
    });
  };

  const renameVariant = (name: string) =>
    setDraft((d) => ({
      ...d,
      variants: d.variants.map((v, i) => (i === activeIdx ? { ...v, name } : v)),
    }));

  const addVariant = (name: string, response?: Partial<ResponseSpec>) => {
    setDraft((d) => ({
      ...d,
      variants: [
        ...d.variants,
        {
          name,
          // 缺省复制当前变体 —— 多数时候是想「基于现在这份改一点」
          response: response
            ? createResponseSpec({ ...d.variants[activeIdx]?.response, ...response })
            : createResponseSpec({ ...d.variants[activeIdx]?.response }),
        },
      ],
    }));
    setActiveIdx(draft.variants.length);
  };

  const deleteVariant = (idx: number) => {
    // 至少保留一个 —— 没有变体的规则没有任何响应可返回
    if (draft.variants.length <= 1) return;
    setDraft((d) => ({ ...d, variants: d.variants.filter((_, i) => i !== idx) }));
    setActiveIdx((cur) => (cur >= idx && cur > 0 ? cur - 1 : cur));
  };

  const toggleMethod = (m: HttpMethod) => {
    const cur = draft.match.methods;
    patchMatch({ methods: cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m] });
  };

  /**
   * 保存后【不关闭编辑器】。
   * 保存即隐藏会让人不确定有没有存上，容易反复点保存。
   */
  const handleSave = async () => {
    if (errors.length > 0 || saving || !dirty) return;
    setSaving(true);
    const ok = await onSave({ ...draft, activeVariantIndex: activeIdx });
    setSaving(false);
    if (!ok) return;

    setSavedSnapshot(serialized);
    setFlash('已保存');
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 2000);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        void handleSave();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const title = titleOverride ?? (initial ? '编辑规则' : initialDraft ? '从请求创建 Mock' : '新建规则');
  /**
   * 只列当前项目下的分组。
   * 之前的写法会把所有全局分组也列进来，导致下拉里出现别的项目的分组，
   * 选了之后规则会被 MOVE_RULE 拽到那个项目去，很难排查。
   */
  const groupsOfProject = groups?.filter((g) => g.projectId === (draft.projectId ?? null));

  return (
    <div className="editor">
      {/* 头部固定，长表单滚动时保存按钮始终可见 */}
      <div className="editor__head">
        <div className="row" style={{ gap: 9, minWidth: 0 }}>
          <strong style={{ fontSize: 13 }}>{title}</strong>
          {flash && <span className="ok" style={{ fontSize: 11 }}>✓ {flash}</span>}
          {!flash && dirty && savedSnapshot !== null && (
            <span className="faint" style={{ fontSize: 11 }}>有未保存的改动</span>
          )}
        </div>
        <div className="row" style={{ gap: 7 }}>
          <button onClick={onClose}>关闭</button>
          <button
            className="primary"
            disabled={errors.length > 0 || saving || !dirty}
            onClick={handleSave}
            title="⌘S / Ctrl+S"
          >
            {saving ? '保存中…' : !dirty && savedSnapshot !== null ? '已保存' : '保存'}
          </button>
        </div>
      </div>

      <div className="editor__body">
        {/* ── 规则级配置 ── */}
        <div className="row" style={{ gap: 10, alignItems: 'flex-start', marginBottom: 13 }}>
          <div className="grow">
            <label>规则名</label>
            <input value={draft.name} onChange={(e) => patch({ name: e.target.value })} />
          </div>
        </div>

        {(projects?.length || groups?.length) && (
          <div className="row" style={{ gap: 10, alignItems: 'flex-start', marginBottom: 13 }}>
            {projects && projects.length > 0 && (
              <div className="grow">
                <label>所属项目</label>
                <select
                  value={draft.projectId ?? ''}
                  onChange={(e) => patch({ projectId: e.target.value || null, groupId: null })}
                >
                  <option value="">未归档</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
            )}
            {groupsOfProject && groupsOfProject.length > 0 && (
              <div className="grow">
                <label>所属分组</label>
                <select
                  value={draft.groupId ?? ''}
                  onChange={(e) => patch({ groupId: e.target.value || null })}
                >
                  <option value="">未分组</option>
                  {groupsOfProject.map((g) => (
                    <option key={g.id} value={g.id}>{g.name}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
        )}

        <div style={{ marginBottom: 13 }}>
          <label>类型</label>
          <div className="row" style={{ gap: 9, alignItems: 'stretch' }}>
            <KindOption
              checked={draft.kind === 'override'}
              onSelect={() => patch({ kind: 'override' })}
              title="覆盖已有接口"
              desc="接口真实存在，只改响应。停用后回到真实数据"
            />
            <KindOption
              checked={draft.kind === 'virtual'}
              onSelect={() => patch({ kind: 'virtual' })}
              title="新建虚拟接口"
              desc="后端还没有这个接口。停用后请求会真的失败"
            />
          </div>
        </div>

        <div style={{ marginBottom: 13 }}>
          <label>URL 匹配</label>
          <div className="row" style={{ gap: 7 }}>
            <select
              value={draft.match.urlMode}
              onChange={(e) =>
                patchMatch({ urlMode: e.target.value as RuleDraft['match']['urlMode'] })
              }
              style={{ width: 96, flexShrink: 0 }}
            >
              <option value="contains">包含</option>
              <option value="wildcard">通配符</option>
              <option value="regex">正则</option>
            </select>
            <input
              className="mono"
              placeholder={placeholderFor(draft.match.urlMode)}
              value={draft.match.url}
              onChange={(e) => patchMatch({ url: e.target.value })}
            />
          </div>
        </div>

        <div style={{ marginBottom: 16 }}>
          <label>
            请求方法
            {draft.match.methods.length === 0 && (
              <span className="faint" style={{ fontWeight: 400 }}> · 未选 = 匹配全部</span>
            )}
          </label>
          <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
            {HTTP_METHODS.map((m) => (
              <button
                key={m}
                className={draft.match.methods.includes(m) ? 'primary tiny' : 'tiny'}
                onClick={() => toggleMethod(m)}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        {/* ── 变体级配置 ── */}
        <div className="editor__divider">
          <span>变体</span>
          <span className="faint" style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
            同一接口的多份响应，切换即换数据源
          </span>
        </div>

        <div className="vtabs">
          {draft.variants.map((v, i) => (
            <span key={i} className={`vtab${i === activeIdx ? ' vtab--on' : ''}`}>
              <button
                onClick={() => {
                  setActiveIdx(i);
                  setRenamingVariant(false);
                }}
              >
                {v.name || `变体 ${i + 1}`}
              </button>
              {draft.variants.length > 1 && (
                <button
                  className="vtab__x"
                  title="删除该变体"
                  onClick={() => deleteVariant(i)}
                >
                  ×
                </button>
              )}
            </span>
          ))}
          <button
            className="vtab__add"
            title="基于当前变体新增"
            onClick={() => addVariant(`变体 ${draft.variants.length + 1}`)}
          >
            ＋
          </button>
        </div>

        <div className="row" style={{ gap: 9, alignItems: 'flex-start', marginBottom: 12 }}>
          <div style={{ width: 128, flexShrink: 0 }}>
            <label>变体名</label>
            <input
              value={variant.name}
              onFocus={() => setRenamingVariant(true)}
              onBlur={() => setRenamingVariant(false)}
              onChange={(e) => renameVariant(e.target.value)}
              style={renamingVariant ? { borderColor: 'var(--accent)' } : undefined}
            />
          </div>
          <div style={{ width: 82, flexShrink: 0 }}>
            <label>状态码</label>
            <input
              type="number"
              value={variant.response.status}
              onChange={(e) => patchResponse({ status: Number(e.target.value) })}
            />
          </div>
          <div style={{ width: 92, flexShrink: 0 }}>
            <label>延迟 ms</label>
            <input
              type="number"
              value={variant.response.delayMs}
              onChange={(e) => patchResponse({ delayMs: Number(e.target.value) })}
            />
          </div>
          <div className="grow">
            <label>响应外壳</label>
            <select
              value={variant.response.shellTemplateId ?? ''}
              onChange={(e) => patchResponse({ shellTemplateId: e.target.value || null })}
            >
              <option value="">继承分组 / 项目默认</option>
              {shellTemplates.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
            <label style={{ margin: 0 }}>
              {variant.response.shellTemplateId
                ? '响应数据（填入外壳的 __DATA__ 位置）'
                : '响应体'}
            </label>
            <div className="row" style={{ gap: 4 }}>
              <span className="faint" style={{ fontSize: 10.5 }}>新建变体：</span>
              {SCENARIO_PRESETS.map((p) => (
                <button
                  key={p.label}
                  className="tiny ghost"
                  onClick={() => addVariant(p.label, p.response)}
                  title={`以「${p.label}」新建一个变体`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* 类型切换。放在编辑器正上方，因为它决定了下面那个框里该写什么 */}
          <div className="bodytype">
            {BODY_TYPE_TABS.map((t) => (
              <button
                key={t.value}
                className={bodyType === t.value ? 'bodytype__on' : ''}
                onClick={() => switchBodyType(t.value)}
                title={t.hint}
              >
                {t.label}
              </button>
            ))}
            <span className="grow" />
            {isDynamic && (
              <span className="faint" style={{ fontSize: 10.5 }}>
                可用 <code className="mono">req.query</code> ·{' '}
                <code className="mono">req.path</code> ·{' '}
                <code className="mono">req.method</code>
              </span>
            )}
            {isMockjs && (
              <span className="faint" style={{ fontSize: 10.5 }}>
                <code className="mono">"键|数量"</code> 控制条数 ·{' '}
                <code className="mono">@占位符</code> 造假数据
              </span>
            )}
          </div>

          <CodeEditor
            key={`${activeIdx}-${draft.variants.length}-${bodyType}`}
            language={isDynamic ? 'js' : 'json'}
            value={variant.response.body}
            onChange={(body) => patchResponse({ body })}
            height="min(46vh, 520px)"
            actions={
              isDynamic || isMockjs ? (
                <>
                  <span className="json-editor__divider" />
                  {(isDynamic ? DYNAMIC_SNIPPETS : MOCKJS_SNIPPETS).map((s) => (
                    <button
                      key={s.label}
                      type="button"
                      title={s.hint}
                      onClick={() => patchResponse({ body: s.code })}
                    >
                      {s.label}
                    </button>
                  ))}
                </>
              ) : undefined
            }
          />

          {isDynamic && (
            <div className="faint" style={{ fontSize: 10.5, marginTop: 5, lineHeight: 1.6 }}>
              这里无法预览 —— MV3 扩展页面禁用了 <code className="mono">eval</code>，
              代码只能在页面里跑。保存后到页面上发一次请求即可验证：
              执行出错会在 DevTools 的 Mock 面板标红，页面控制台也会提示。
            </div>
          )}
          {isMockjs && (
            <div className="faint" style={{ fontSize: 10.5, marginTop: 5, lineHeight: 1.6 }}>
              模板是纯数据、不需要 <code className="mono">eval</code>，
              在 CSP 严格的站点上也能用（动态 JS 在那种站点会失效）。
              数据每次请求重新生成，所以刷新页面看到的值会变。
              支持的写法见 <code className="mono">docs/reference/mock-template-syntax.md</code>。
            </div>
          )}
        </div>

        {errors.map((i, n) => (
          <div key={`e${n}`} className="banner banner-bad" style={{ marginTop: 7 }}>✗ {i.message}</div>
        ))}
        {warnings.map((i, n) => (
          <div key={`w${n}`} className="banner banner-warn" style={{ marginTop: 7 }}>⚠ {i.message}</div>
        ))}
      </div>
    </div>
  );
}

/**
 * 场景预设 —— 现在是「新建一个变体」而不是覆盖当前 body。
 * 这样原来的数据不会丢，用户可以在两者间来回切。
 *
 * 带 body 的预设必须显式写 bodyType: 'static' —— 新变体是从当前变体复制的，
 * 当前若是动态变体，不写就会得到「bodyType 是 dynamic，body 却是一段 JSON」，
 * 运行时编译必然失败。「慢 3 秒」只改延迟不动 body，所以不能写。
 */
const SCENARIO_PRESETS: { label: string; response: Partial<ResponseSpec> }[] = [
  {
    label: '空数据',
    response: { status: 200, bodyType: 'static', body: '{\n  "list": [],\n  "total": 0\n}' },
  },
  {
    label: '500',
    response: {
      status: 500,
      bodyType: 'static',
      body: '{\n  "message": "Internal Server Error"\n}',
    },
  },
  {
    label: '401',
    response: { status: 401, bodyType: 'static', body: '{\n  "message": "登录已过期"\n}' },
  },
  { label: '慢 3 秒', response: { delayMs: 3000 } },
];

const BODY_TYPE_TABS: { value: BodyType; label: string; hint: string }[] = [
  { value: 'static', label: '静态 JSON', hint: '直接写死一份 JSON' },
  {
    value: 'mockjs',
    label: 'Mock 模板',
    hint: '一行模板造一批假数据 —— 不需要 eval，CSP 严格的站点也能用',
  },
  {
    value: 'dynamic',
    label: '动态 JS',
    hint: '写一段 JS，按请求参数现算 —— 翻页、按 id 查详情、搜索都靠它',
  },
];

/** 切到某个类型且原 body 可丢弃时，用什么起手 */
const STARTER_BODY: Record<BodyType, string> = {
  static: '{}',
  get mockjs() {
    return MOCKJS_SNIPPETS[0]!.code;
  },
  get dynamic() {
    return DYNAMIC_SNIPPETS[0]!.code;
  },
};

/**
 * Mock 模板示例。
 *
 * 第一条是切过来时的默认值 —— 刻意用最典型的列表场景，
 * 让用户一眼看懂 `"键|数量"` 和 `@占位符` 这两件事怎么配合。
 */
const MOCKJS_SNIPPETS: { label: string; hint: string; code: string }[] = [
  {
    label: '列表',
    hint: '一行造 10 条，id 自动递增',
    code: `{
  "list|10": [{
    "id|+1": 1001,
    "name": "@ctitle(2,4)",
    "price|10-999.2": 1,
    "stock|0-200": 1,
    "owner": "@cname",
    "status": "@pick(待付款,已发货,已完成)",
    "createdAt": "@datetime"
  }],
  "total|40-60": 1,
  "page": 1
}`,
  },
  {
    label: '详情',
    hint: '单个对象，字段类型齐全',
    code: `{
  "id": "@id",
  "title": "@ctitle(3,6)",
  "author": "@cname",
  "cover": "@url",
  "tags|1-3": ["@cword"],
  "views|100-99999": 1,
  "score|1-5.1": 1,
  "published": "@boolean",
  "updatedAt": "@datetime"
}`,
  },
  {
    label: '用户',
    hint: '常见的用户信息字段',
    code: `{
  "id": "@guid",
  "name": "@cname",
  "email": "@email",
  "phone": "@phone",
  "avatar": "@url",
  "city": "@city",
  "province": "@province",
  "ip": "@ip",
  "registeredAt": "@date"
}`,
  },
];

/**
 * 动态响应的代码模板。
 *
 * 第一条是切到动态模式时的默认值，也刻意是最典型的痛点场景（翻页）——
 * 用户一眼就能看懂「原来能这么用」，比一段空函数强。
 */
const DYNAMIC_SNIPPETS: { label: string; hint: string; code: string }[] = [
  {
    label: '分页',
    hint: '按 page / size 生成对应页的数据',
    code: `(req) => {
  const page = Number(req.query.page) || 1;
  const size = Number(req.query.size) || 10;
  return {
    list: Array.from({ length: size }, (_, i) => ({
      id: (page - 1) * size + i + 1,
      name: \`商品 \${(page - 1) * size + i + 1}\`,
    })),
    total: 48,
  };
}`,
  },
  {
    label: '按 id 查详情',
    hint: '从路径末段取 id，回不同的数据',
    code: `(req) => {
  const id = req.path.split('/').pop();
  return { id, name: \`商品 \${id}\`, price: Number(id) * 10 };
}`,
  },
  {
    label: '按关键词搜索',
    hint: '让搜索词真的影响结果',
    code: `(req) => {
  const kw = req.query.keyword || '';
  const all = ['苹果', '香蕉', '橘子', '葡萄'];
  const list = all.filter((n) => n.includes(kw));
  return { list, total: list.length };
}`,
  },
];

function KindOption({
  checked,
  onSelect,
  title,
  desc,
}: {
  checked: boolean;
  onSelect: () => void;
  title: string;
  desc: string;
}) {
  return (
    <div
      onClick={onSelect}
      style={{
        flex: 1,
        padding: '8px 10px',
        border: `1px solid ${checked ? 'var(--accent)' : 'var(--border-strong)'}`,
        borderRadius: 'var(--radius-sm)',
        cursor: 'pointer',
        background: checked ? 'var(--accent-soft)' : 'transparent',
        transition: 'border-color .12s, background .12s',
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 2 }}>{title}</div>
      <div className="muted" style={{ fontSize: 10.5, lineHeight: 1.45 }}>{desc}</div>
    </div>
  );
}

function placeholderFor(mode: RuleDraft['match']['urlMode']): string {
  switch (mode) {
    case 'contains':
      return '/api/goods/list';
    case 'wildcard':
      return '/api/*/list';
    case 'regex':
      return '/api/goods/\\d+';
  }
}

function toDraft(rule: Rule): RuleDraft {
  const { id: _id, meta, variants, activeVariantId, ...rest } = rule;
  return {
    ...rest,
    variants: variants.map((v) => ({ id: v.id, name: v.name, response: v.response })),
    activeVariantIndex: Math.max(0, variants.findIndex((v) => v.id === activeVariantId)),
    meta: { source: meta.source },
  };
}
