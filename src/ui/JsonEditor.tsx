/**
 * JSON 编辑器
 *
 * 用 CodeMirror 6 替代原来的 <textarea>。原来的问题：
 *   - 不能折叠对象，一个几百行的接口响应根本看不过来
 *   - 没有语法高亮，括号配不上对
 *   - 没有行号，报错说「第 47 行」也定位不到
 *
 * 依赖全部本地打包，扩展里不允许加载远程代码。
 */

import { useEffect, useRef, useState } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, type Extension } from '@codemirror/state';
import { json, jsonParseLinter } from '@codemirror/lang-json';
import { foldAll, unfoldAll } from '@codemirror/language';
import { linter, lintGutter } from '@codemirror/lint';

interface Props {
  value: string;
  onChange: (v: string) => void;
  /** 编辑器高度，默认撑满父容器 */
  height?: string;
  placeholder?: string;
}

export function JsonEditor({ value, onChange, height = '100%' }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  /** 用来区分「外部传入的新值」和「用户自己敲的」，避免回写覆盖光标 */
  const localValueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const [status, setStatus] = useState<{ ok: boolean; message: string }>({
    ok: true,
    message: '',
  });

  useEffect(() => {
    if (!hostRef.current) return;

    const extensions: Extension[] = [
      basicSetup,
      json(),
      lintGutter(),
      linter(jsonParseLinter()),
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
        setStatus(checkJson(text));
      }),
    ];

    const view = new EditorView({
      state: EditorState.create({ doc: value, extensions }),
      parent: hostRef.current,
    });
    viewRef.current = view;
    setStatus(checkJson(value));

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // 只初始化一次；后续同步走下面那个 effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 外部值变化时同步进编辑器（如 Capture-to-Mock 填入、场景预设）
  useEffect(() => {
    const view = viewRef.current;
    if (!view || value === localValueRef.current) return;
    localValueRef.current = value;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
    });
    setStatus(checkJson(value));
  }, [value]);

  const replaceAll = (text: string) => {
    const view = viewRef.current;
    if (!view) return;
    localValueRef.current = text;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    onChangeRef.current(text);
    setStatus(checkJson(text));
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
        <button type="button" onClick={format} title="格式化并缩进">
          格式化
        </button>
        <button type="button" onClick={compact} title="压缩成一行">
          压缩
        </button>
        <span className="json-editor__divider" />
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

        <span style={{ flex: 1 }} />

        <span className={status.ok ? 'muted' : 'bad'} style={{ fontSize: 11 }}>
          {status.message}
        </span>
      </div>

      <div ref={hostRef} className="json-editor__host" />
    </div>
  );
}

function checkJson(text: string): { ok: boolean; message: string } {
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
