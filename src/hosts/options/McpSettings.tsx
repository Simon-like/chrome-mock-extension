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

import { useEffect, useRef, useState } from 'react';
import type { Settings } from '@core/types.js';
import { Switch } from '@ui/Switch.js';

/** 桥的连接状态，由 SW 报上来（见 background/mcpBridge.ts） */
export type BridgeStatus =
  | { state: 'off' }
  | { state: 'connecting'; port: number }
  | { state: 'connected'; port: number; silentMs: number }
  | { state: 'error'; port: number; reason: string };

interface Props {
  settings: Settings;
  /** 必须等设置真正落库后才能安装或复制配置；false 表示保留弹窗并显示错误 */
  onSave: (patch: Partial<Settings>) => Promise<boolean>;
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
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** 同步锁防止双击在 React 重渲染前触发两次保存和两次跳转 */
  const savingRef = useRef(false);

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

  const saveChanges = async (): Promise<boolean> => {
    if (savingRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    const p = Number(port);
    try {
      const ok = await onSave({
        mcpEnabled: enabled,
        mcpPort: Number.isFinite(p) && p > 0 && p < 65536 ? p : settings.mcpPort,
        mcpToken: token,
        aiReadEnabled: readEnabled,
        aiHostWhitelist: whitelist,
      });
      if (!ok) setSaveError('设置保存失败，请检查扩展后台连接后重试。');
      return ok;
    } catch (e) {
      setSaveError(`设置保存失败：${(e as Error).message}`);
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const save = async () => {
    if (await saveChanges()) onClose();
  };

  /** 所有安装与复制入口共用同一条“先落库，再出配置”的路径 */
  const saveAndRun = async (action: () => void | Promise<void>) => {
    if (savingRef.current || !(await saveChanges())) return;
    try {
      await action();
    } catch (e) {
      setSaveError(`设置已保存，但操作未完成：${(e as Error).message}`);
    }
  };

  const close = () => {
    if (!savingRef.current) onClose();
  };

  /** 开桥必须有配对码 —— 没有的话直接生成一个，不让用户面对一个「为什么连不上」的谜 */
  const toggleEnabled = (next: boolean) => {
    setEnabled(next);
    if (next && !token) setToken(generateToken());
  };

  /**
   * 接入配置一律用 npx 形态 —— 里面没有任何本地路径，
   * 配对码也已经内嵌，用户拿到就能用，不用再「核对路径再粘贴」。
   * 本地仓库版（未发布 npm）走 install 子命令，由它自己填绝对路径。
   */
  const npmEntry: Record<string, unknown> = {
    command: 'npx',
    args: ['-y', 'mock-studio-mcp'],
    env: {
      MOCK_STUDIO_TOKEN: token || '<先在上面生成配对码>',
      ...(port !== '8787' ? { MOCK_STUDIO_PORT: port } : {}),
    },
  };
  const manualConfig = JSON.stringify({ mcpServers: { 'mock-studio': npmEntry } }, null, 2);

  /** Cursor / VS Code 的一键安装 deeplink：点链接 → 客户端弹确认 → 完成 */
  const cursorDeeplink = `cursor://anysphere.cursor-deeplink/mcp/install?name=mock-studio&config=${btoa(
    JSON.stringify(npmEntry),
  )}`;
  const vscodeDeeplink = `vscode:mcp/install?${encodeURIComponent(
    JSON.stringify({ name: 'mock-studio', type: 'stdio', ...npmEntry }),
  )}`;

  /** Claude Code 的官方 CLI 写法 */
  const claudeCmd =
    `claude mcp add mock-studio` +
    ` -e MOCK_STUDIO_TOKEN=${token || '<配对码>'}` +
    (port !== '8787' ? ` -e MOCK_STUDIO_PORT=${port}` : '') +
    ` -- npx -y mock-studio-mcp`;

  /** 本地仓库版：安装器自己知道绝对路径，配对码只贴这一次，写进所有客户端 */
  const localInstallCmd =
    `node mcp-server/dist/bundle/mock-studio-mcp.mjs install` +
    ` --token ${token || '<配对码>'}` +
    (port !== '8787' ? ` --port ${port}` : '');

  return (
    <>
      <div className="modal__backdrop" onClick={close} />
      <div className="modal modal--wide">
        <div className="modal__head">
          <strong style={{ fontSize: 13 }}>MCP 桥 —— 让 AI 直接操作你的 mock</strong>
          <button onClick={close} disabled={saving}>关闭</button>
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
                  <button
                    className="tiny"
                    disabled={saving}
                    onClick={() => void saveAndRun(() => copy(token, 'token'))}
                  >
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

              {/* ── 接入 AI 客户端：能一键就不手贴 ── */}
              <div style={{ marginBottom: 14 }}>
                <label style={{ display: 'block', marginBottom: 6 }}>接入 AI 客户端</label>

                {/* 先保存再跳转，保证 deeplink 里的 token/port 已经在扩展侧生效 */}
                <div className="row" style={{ gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                  <button
                    className="installbtn"
                    disabled={saving}
                    onClick={() => void saveAndRun(() => window.location.assign(cursorDeeplink))}
                  >
                    保存并装进 Cursor
                  </button>
                  <button
                    className="installbtn"
                    disabled={saving}
                    onClick={() => void saveAndRun(() => window.location.assign(vscodeDeeplink))}
                  >
                    保存并装进 VS Code
                  </button>
                </div>
                <div className="faint" style={{ fontSize: 10.5, marginBottom: 12, lineHeight: 1.6 }}>
                  点按钮 → 先保存当前设置 → 对应客户端弹确认框（配对码已内嵌，无需再填）。
                  点了没反应说明没装该客户端，或它还没注册协议（先启动一次再点）。
                </div>

                {/* Claude Code：官方 CLI 一行命令 */}
                <label>Claude Code</label>
                <div className="row" style={{ gap: 6 }}>
                  <input
                    className="mono"
                    readOnly
                    value={claudeCmd}
                    onFocus={(e) => e.target.select()}
                    style={{ fontSize: 11 }}
                  />
                  <button
                    className="tiny"
                    disabled={saving}
                    onClick={() => void saveAndRun(() => copy(claudeCmd, 'claude'))}
                  >
                    {copied === 'claude' ? '已复制' : '保存并复制'}
                  </button>
                </div>

                {/* 本地仓库版 / 其他客户端：安装器一次写全部 */}
                <div style={{ marginTop: 12 }}>
                  <label>
                    从 GitHub 下载的本地版
                    <span className="faint" style={{ fontWeight: 400 }}>
                      {' '}
                      · 一条命令写进所有已安装的客户端，不用自己核对路径
                    </span>
                  </label>
                  <div className="row" style={{ gap: 6 }}>
                    <input
                      className="mono"
                      readOnly
                      value={localInstallCmd}
                      onFocus={(e) => e.target.select()}
                      style={{ fontSize: 11 }}
                    />
                    <button
                      className="tiny"
                      disabled={saving}
                      onClick={() => void saveAndRun(() => copy(localInstallCmd, 'local'))}
                    >
                      {copied === 'local' ? '已复制' : '保存并复制'}
                    </button>
                  </div>
                  <div className="faint" style={{ fontSize: 10.5, marginTop: 4, lineHeight: 1.6 }}>
                    在<b>仓库根目录</b>跑这条命令：自动检测 Claude Code / Cursor / VS Code /
                    Windsurf / Claude Desktop 并全部写入，写前自动备份原配置。
                  </div>
                </div>

                {/* 手动 JSON：给 deeplink 和 CLI 都不可用时兜底 */}
                <details style={{ marginTop: 12 }}>
                  <summary style={{ fontSize: 11.5, cursor: 'pointer', color: 'var(--muted)' }}>
                    手动复制 JSON 配置（其他客户端）
                  </summary>
                  <div className="row" style={{ justifyContent: 'flex-end', margin: '6px 0 4px' }}>
                    <button
                      className="tiny"
                      disabled={saving}
                      onClick={() => void saveAndRun(() => copy(manualConfig, 'config'))}
                    >
                      {copied === 'config' ? '已复制' : '保存并复制整段'}
                    </button>
                  </div>
                  <pre className="mono codeblock">{manualConfig}</pre>
                  <ol className="faint hintlist">
                    <li>
                      这段配置用 <code className="mono">npx -y mock-studio-mcp</code> 启动，
                      要求本包已发布到 npm；本地仓库版请用上面那条 install 命令
                    </li>
                    <li>
                      粘进客户端的 MCP 配置文件：Claude Code 是<b>打开会话那个目录</b>的
                      <code className="mono"> .mcp.json</code>，Cursor 是
                      <code className="mono"> ~/.cursor/mcp.json</code>
                    </li>
                    <li>
                      <b>重启客户端</b> —— MCP Server 是它拉起的子进程，不重启读不到新配置
                    </li>
                  </ol>
                </details>
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

        {saveError && (
          <div className="banner banner-bad" style={{ margin: '0 16px 10px', fontSize: 11 }}>
            {saveError}
          </div>
        )}
        <div className="modal__foot">
          <button onClick={close} disabled={saving}>取消</button>
          <button className="primary" onClick={() => void save()} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * 连接状态。
 *
 * 「已连接」不再是个一旦点亮就不灭的灯 —— 它带上了**距上次收到服务端消息多久**。
 * 服务端正常每 20 秒 PING 一次，所以静默超过 45 秒基本就是对端没了，
 * 这时显示「疑似断开」比继续显示绿色的「已连接」诚实得多。
 * （扩展侧的看门狗也会在同一时间窗内主动重连，这里只是把过程让用户看见。）
 */
function StatusPill({ status }: { status: BridgeStatus }) {
  if (status.state === 'connected') {
    const stale = status.silentMs > 45_000;
    return (
      <span className={stale ? 'warn' : 'ok'} style={{ fontSize: 11 }}>
        ● {stale ? '疑似断开，正在重连…' : '已连接'}
        <span className="faint" style={{ marginLeft: 6 }}>
          {formatSilent(status.silentMs)}
        </span>
      </span>
    );
  }
  const map = {
    off: { cls: 'muted', text: '未启用' },
    connecting: { cls: 'warn', text: '连接中…' },
    error: { cls: 'bad', text: '未连接' },
  } as const;
  const s = map[status.state];
  return (
    <span className={s.cls} style={{ fontSize: 11 }}>
      ● {s.text}
      {status.state === 'error' && (
        <span className="faint" style={{ marginLeft: 6 }}>
          {status.reason}
        </span>
      )}
    </span>
  );
}

function formatSilent(ms: number): string {
  const sec = Math.round(ms / 1000);
  return sec < 3 ? '刚刚有通信' : `${sec}s 前有通信`;
}
