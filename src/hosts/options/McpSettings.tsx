/**
 * MCP 桥设置弹层
 *
 * 这个面板承担一件事：让「配对码」这个安全机制**用得起来**。
 * 配对码本身在扩展里生成，用户要把它复制到 MCP 客户端的配置里 ——
 * 中间任何一点摩擦（找不到、复制不动、不知道填哪）都会让人
 * 干脆去掉校验图省事，那安全设计就白做了。
 *
 * 所以这里给的是「可以直接粘贴的整段 JSON 配置」，而不是让用户
 * 自己拼环境变量。
 */

import { useEffect, useState } from 'react';
import type { Settings } from '@core/types.js';
import { Switch } from '@ui/Switch.js';

/** 桥的连接状态，由 SW 报上来（见 background/mcpBridge.ts） */
export type BridgeStatus =
  | { state: 'off' }
  | { state: 'connecting'; port: number }
  | { state: 'connected'; port: number }
  | { state: 'error'; port: number; reason: string };

interface Props {
  settings: Settings;
  onSave: (patch: Partial<Settings>) => void;
  onClose: () => void;
}

/** 配对码：足够长到猜不出来，又短到能一眼看完、手抄不出错 */
function generateToken(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function McpSettings({ settings, onSave, onClose }: Props) {
  const [enabled, setEnabled] = useState(settings.mcpEnabled);
  const [port, setPort] = useState(String(settings.mcpPort));
  const [token, setToken] = useState(settings.mcpToken);
  const [readEnabled, setReadEnabled] = useState(settings.aiReadEnabled);
  const [whitelistText, setWhitelistText] = useState(settings.aiHostWhitelist.join('\n'));
  const [status, setStatus] = useState<BridgeStatus>({ state: 'off' });
  const [copied, setCopied] = useState<string | null>(null);

  const whitelist = whitelistText
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  // 连接状态要能看到变化，否则用户改完设置只能盯着一个静止的「未连接」猜
  useEffect(() => {
    let alive = true;
    const poll = () => {
      chrome.runtime.sendMessage({ type: 'GET_BRIDGE_STATUS' }, (res) => {
        // SW 可能正在重启，拿不到就当没变，别把界面刷成报错
        if (chrome.runtime.lastError || !alive || !res?.status) return;
        setStatus(res.status as BridgeStatus);
      });
    };
    poll();
    const t = setInterval(poll, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 1800);
    } catch {
      /* 剪贴板不可用时用户还能手选，不必打断 */
    }
  };

  const save = () => {
    const p = Number(port);
    onSave({
      mcpEnabled: enabled,
      mcpPort: Number.isFinite(p) && p > 0 && p < 65536 ? p : settings.mcpPort,
      mcpToken: token,
      aiReadEnabled: readEnabled,
      aiHostWhitelist: whitelist,
    });
    onClose();
  };

  /** 开桥必须有配对码 —— 没有的话直接生成一个，不让用户面对一个「为什么连不上」的谜 */
  const toggleEnabled = (next: boolean) => {
    setEnabled(next);
    if (next && !token) setToken(generateToken());
  };

  const clientConfig = JSON.stringify(
    {
      mcpServers: {
        'mock-studio': {
          command: 'node',
          args: ['<绝对路径>/chrome-mock-extension/mcp-server/dist/mcp-server/src/index.js'],
          env: { MOCK_STUDIO_TOKEN: token || '<先在上面生成配对码>', MOCK_STUDIO_PORT: port },
        },
      },
    },
    null,
    2,
  );

  return (
    <>
      <div className="modal__backdrop" onClick={onClose} />
      <div className="modal modal--wide">
        <div className="modal__head">
          <strong style={{ fontSize: 13 }}>MCP 桥 —— 让 AI 直接操作你的 mock</strong>
          <button onClick={onClose}>关闭</button>
        </div>

        <div className="modal__body">
          {/* ── 总开关与状态 ── */}
          <div className="row" style={{ gap: 9, marginBottom: 6 }}>
            <Switch checked={enabled} onChange={toggleEnabled} label="启用 MCP 桥" />
            <span style={{ fontSize: 12.5, fontWeight: 500 }}>启用 MCP 桥</span>
            <span className="grow" />
            <StatusPill status={status} />
          </div>
          <div className="faint" style={{ fontSize: 10.5, marginBottom: 14, lineHeight: 1.6 }}>
            开启后扩展会连本机的 MCP Server（一个 Node 进程），
            让 Claude Code / Cursor 里的 AI 能看到页面实际发了哪些请求、并直接写 mock 规则。
            数据全程不出本机。
          </div>

          {enabled && (
            <>
              {/* ── 配对码 ── */}
              <div style={{ marginBottom: 14 }}>
                <label>
                  配对码
                  <span className="faint" style={{ fontWeight: 400 }}>
                    {' '}
                    · 挡住本机上的其他进程，必须和 MCP Server 一致
                  </span>
                </label>
                <div className="row" style={{ gap: 6 }}>
                  <input className="mono" value={token} readOnly style={{ fontSize: 11.5 }} />
                  <button className="tiny" onClick={() => copy(token, 'token')}>
                    {copied === 'token' ? '已复制' : '复制'}
                  </button>
                  <button
                    className="tiny"
                    title="重新生成后要同步改 MCP 客户端配置，否则连不上"
                    onClick={() => setToken(generateToken())}
                  >
                    重新生成
                  </button>
                </div>
              </div>

              {/* ── 端口 ── */}
              <div style={{ marginBottom: 14 }}>
                <label>
                  端口
                  <span className="faint" style={{ fontWeight: 400 }}> · 被占用时才需要改</span>
                </label>
                <input
                  type="number"
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  style={{ width: 120 }}
                />
              </div>

              {/* ── 可直接粘贴的客户端配置 ── */}
              <div style={{ marginBottom: 14 }}>
                <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
                  <label style={{ margin: 0 }}>MCP 客户端配置</label>
                  <button className="tiny" onClick={() => copy(clientConfig, 'config')}>
                    {copied === 'config' ? '已复制' : '复制整段'}
                  </button>
                </div>
                <pre className="mono codeblock">{clientConfig}</pre>
                <div className="faint" style={{ fontSize: 10.5, marginTop: 4, lineHeight: 1.6 }}>
                  粘进 Claude Code 的 <code className="mono">.mcp.json</code>（或 Cursor 的
                  MCP 配置），把 <code className="mono">&lt;绝对路径&gt;</code> 换成本仓库的真实路径。
                  首次使用前要先在 <code className="mono">mcp-server/</code> 里跑一次{' '}
                  <code className="mono">npm install && npm run build</code>。
                </div>
              </div>

              {/* ── 读侧 ── */}
              <div className="modal__sep" />

              <div className="row" style={{ gap: 9, marginBottom: 6 }}>
                <Switch checked={readEnabled} onChange={setReadEnabled} label="允许 AI 读取请求记录" />
                <span style={{ fontSize: 12.5, fontWeight: 500 }}>允许 AI 读取请求记录</span>
              </div>
              <div className="faint" style={{ fontSize: 10.5, marginBottom: 12, lineHeight: 1.6 }}>
                这是 MCP 最有价值的部分 —— AI 能看到页面在请求什么、返回了什么，
                不用你手抄 URL。关掉后写侧仍可用，但 AI 得靠你告诉它接口地址。
                <br />
                <strong>无论开关如何，出去的数据一律强制脱敏</strong>：
                token / cookie / 密码等字段会被打码，这一条不可关闭。
              </div>

              {readEnabled && (
                <div style={{ marginBottom: 6 }}>
                  <label>
                    域名白名单
                    <span className="faint" style={{ fontWeight: 400 }}> · 留空 = 不限</span>
                  </label>
                  <textarea
                    className="mono"
                    rows={3}
                    placeholder={'每行一个，支持通配\ndev2.glink.jd.com\n*.jd.com'}
                    value={whitelistText}
                    onChange={(e) => setWhitelistText(e.target.value)}
                  />
                  {whitelist.length === 0 && (
                    <div className="banner banner-warn" style={{ marginTop: 6, fontSize: 11 }}>
                      ⚠ 当前不限域名 —— <b>你在任何网站上的请求记录都可能被 AI 读到</b>
                      （已脱敏，但 URL 路径和业务数据仍然可见）。
                      建议填上你实际在调试的域名。
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        <div className="modal__foot">
          <button onClick={onClose}>取消</button>
          <button className="primary" onClick={save}>保存</button>
        </div>
      </div>
    </>
  );
}

function StatusPill({ status }: { status: BridgeStatus }) {
  const map = {
    off: { cls: 'muted', text: '未启用' },
    connecting: { cls: 'warn', text: '连接中…' },
    connected: { cls: 'ok', text: '已连接' },
    error: { cls: 'bad', text: '未连接' },
  } as const;
  const s = map[status.state];
  return (
    <span
      className={s.cls}
      style={{ fontSize: 11 }}
      title={status.state === 'error' ? status.reason : undefined}
    >
      ● {s.text}
      {status.state === 'error' && (
        <span className="faint" style={{ marginLeft: 6 }}>
          {status.reason}
        </span>
      )}
    </span>
  );
}
