/**
 * 代码编辑器（JSON / JavaScript）
 *
 * 用 CodeMirror 6 替代原来的 <textarea>。原来的问题：
 *   - 不能折叠对象，一个几百行的接口响应根本看不过来
 *   - 没有语法高亮，括号配不上对
 *   - 没有行号，报错说「第 47 行」也定位不到
 *
 * 依赖全部本地打包，扩展里不允许加载远程代码。
 *
 * ── 关于 JS 模式的语法校验 ──────────────────────────
 * MV3 扩展页面里 `eval` / `new Function` 是**平台强制禁用**的，改不了。
 * 所以这里不可能靠「试着编译一下」来验语法。
 * 改用 CodeMirror 的 Lezer 语法树：解析器遇到语法错误会插入 error 节点，
 * 数一数就知道有没有错、错在哪一行 —— 不求值，纯静态分析。
 */

import { useEffect, useRef, useState } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, type Extension } from '@codemirror/state';
import { json, jsonParseLinter } from '@codemirror/lang-json';
import { javascript } from '@codemirror/lang-javascript';
import { foldAll, syntaxTree, unfoldAll } from '@codemirror/language';
import { linter, lintGutter } from '@codemirror/lint';

export type CodeLanguage = 'json' | 'js';

interface Props {
  value: string;
  onChange: (v: string) => void;
  /** 默认 json */
  language?: CodeLanguage;
  /** 编辑器高度，默认撑满父容器 */
  height?: string;
  /** JS 模式下工具栏右侧的额外按钮（如「插入模板」） */
  actions?: React.ReactNode;
}

interface Status {
  ok: boolean;
  message: string;
}

export function CodeEditor({
  value,
  onChange,
  language = 'json',
  height = '100%',
  actions,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  /** 用来区分「外部传入的新值」和「用户自己敲的」，避免回写覆盖光标 */
  const localValueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const [status, setStatus] = useState<Status>({ ok: true, message: '' });

  useEffect(() => {
    if (!hostRef.current) return;

    const isJs = language === 'js';

    const extensions: Extension[] = [
      basicSetup,
      isJs ? javascript() : json(),
      lintGutter(),
      // JSON 有现成的 linter；JS 的错误由下面的 updateListener 从语法树里读
      ...(isJs ? [] : [linter(jsonParseLinter())]),
      EditorView.lineWrapping,
      EditorView.theme({
        '&': { height: '100%', fontSize: '12px' },
        '.cm-scroller': {
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          lineHeight: '1.55',
        },
        '&.cm-focused': { outline: 'none' },
      }),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        const text = update.state.doc.toString();
        localValueRef.current = text;
        onChangeRef.current(text);
        setStatus(check(text, language, update.state));
      }),
    ];

    const state = EditorState.create({ doc: value, extensions });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    setStatus(check(value, language, view.state));

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // language 变了要整个重建（扩展集不同）。value 只初始化一次，后续走下面的 effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language]);

  // 外部值变化时同步进编辑器（如 Capture-to-Mock 填入、场景预设、插入模板）
  useEffect(() => {
    const view = viewRef.current;
    if (!view || value === localValueRef.current) return;
    localValueRef.current = value;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    setStatus(check(value, language, view.state));
  }, [value, language]);

  const replaceAll = (text: string) => {
    const view = viewRef.current;
    if (!view) return;
    localValueRef.current = text;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    onChangeRef.current(text);
    setStatus(check(text, language, view.state));
  };

  const format = () => {
    try {
      replaceAll(JSON.stringify(JSON.parse(localValueRef.current), null, 2));
    } catch {
      /* 非法 JSON 无法格式化，状态栏已经在提示了 */
    }
  };

  const compact = () => {
    try {
      replaceAll(JSON.stringify(JSON.parse(localValueRef.current)));
    } catch {
      /* 同上 */
    }
  };

  return (
    <div className="json-editor" style={{ height }}>
      <div className="json-editor__toolbar">
        {/* 格式化/压缩是 JSON 专属：JS 源码没有安全的重排办法
            （没打包 prettier，手写缩进器会把用户代码改坏） */}
        {language === 'json' && (
          <>
            <button type="button" onClick={format} title="格式化并缩进">
              格式化
            </button>
            <button type="button" onClick={compact} title="压缩成一行">
              压缩
            </button>
            <span className="json-editor__divider" />
          </>
        )}
        <button
          type="button"
          onClick={() => viewRef.current && foldAll(viewRef.current)}
          title="折叠所有对象与数组"
        >
          全部折叠
        </button>
        <button
          type="button"
          onClick={() => viewRef.current && unfoldAll(viewRef.current)}
          title="展开所有"
        >
          全部展开
        </button>

        {actions}

        <span style={{ flex: 1 }} />

        <span className={status.ok ? 'muted' : 'bad'} style={{ fontSize: 11 }}>
          {status.message}
        </span>
      </div>

      <div ref={hostRef} className="json-editor__host" />
    </div>
  );
}

function check(text: string, language: CodeLanguage, state: EditorState): Status {
  return language === 'js' ? checkJs(text, state) : checkJson(text);
}

/**
 * 从 Lezer 语法树里数 error 节点。
 *
 * 注意 syntaxTree() 返回的是【已解析的部分】—— CodeMirror 的解析有时间预算，
 * 超大文档可能只解析了视口附近。对 mock 脚本这种量级足够了，
 * 而且宁可漏报也不能误报：误报会让人以为自己写错了，去改本来正确的代码。
 */
function checkJs(text: string, state: EditorState): Status {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, message: '空 —— 动态响应至少要返回点什么' };

  const tree = syntaxTree(state);
  let firstErrorAt = -1;
  tree.iterate({
    enter: (node) => {
      if (firstErrorAt >= 0) return false;
      if (node.type.isError) {
        firstErrorAt = node.from;
        return false;
      }
      return true;
    },
  });

  if (firstErrorAt >= 0) {
    const line = state.doc.lineAt(Math.min(firstErrorAt, state.doc.length)).number;
    return { ok: false, message: `语法错误 · 第 ${line} 行` };
  }

  // 语法没问题，再看看有没有「忘了返回」这个最常见的失误
  if (!/\breturn\b/.test(trimmed) && !/=>/.test(trimmed)) {
    return { ok: false, message: '看不到 return 或箭头函数 —— 大概率不会返回任何数据' };
  }

  return { ok: true, message: '语法正常' };
}

function checkJson(text: string): Status {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, message: '空' };

  // 只在看起来是 JSON 时校验 —— 允许 mock 一段 HTML 或纯文本
  if (!/^[[{]/.test(trimmed)) {
    return { ok: true, message: '非 JSON 内容' };
  }

  try {
    const parsed = JSON.parse(trimmed);
    return { ok: true, message: describe(parsed) };
  } catch (e) {
    return { ok: false, message: `JSON 错误：${(e as Error).message}` };
  }
}

/** 给个一眼能看懂的摘要，比如「数组 · 20 项」 */
function describe(v: unknown): string {
  if (Array.isArray(v)) return `数组 · ${v.length} 项`;
  if (v && typeof v === 'object') {
    const keys = Object.keys(v as object);
    return `对象 · ${keys.length} 个字段`;
  }
  return typeof v;
}
