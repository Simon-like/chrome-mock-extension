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

  /** 所有复制出来的配置都使用 npm 入口，不依赖用户的仓库路径。 */
  const shownToken = token || '<配对码>';
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

  const portArgs = port !== '8787' ? ` --port ${port}` : '';
  const installCmd = (client?: string) =>
    `npx -y mock-studio-mcp install --token ${shownToken}${portArgs}` +
    (client ? ` --client ${client}` : '');
  const claudeCmd =
    `claude mcp add mock-studio -e MOCK_STUDIO_TOKEN=${shownToken}` +
    (port !== '8787' ? ` -e MOCK_STUDIO_PORT=${port}` : '') +
    ` -- npx -y mock-studio-mcp`;
  const codexCmd =
    `codex mcp add mock-studio --env MOCK_STUDIO_TOKEN=${shownToken}` +
    (port !== '8787' ? ` --env MOCK_STUDIO_PORT=${port}` : '') +
    ` -- npx -y mock-studio-mcp`;
  const kimiLegacyCmd =
    `kimi mcp add --transport stdio mock-studio --env MOCK_STUDIO_TOKEN=${shownToken}` +
    (port !== '8787' ? ` --env MOCK_STUDIO_PORT=${port}` : '') +
    ` -- npx -y mock-studio-mcp`;
  const localInstallCmd =
    `node mcp-server/dist/bundle/mock-studio-mcp.mjs install --token ${shownToken}${portArgs}`;

  const copyCommand = (command: string, key: string) =>
    saveAndRun(() => copy(command, key));

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
            让 Claude Code、Codex、Kimi、Cursor、DSH 等客户端里的 AI 看到页面实际请求并直接写 mock 规则。
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

              {/* ── 接入 AI 客户端 ── */}
              <div style={{ marginBottom: 14 }}>
                <CommandCopyRow
                  label="通用安装（推荐）"
                  command={installCmd()}
                  copyKey="install"
                  copied={copied}
                  saving={saving}
                  onCopy={() => copyCommand(installCmd(), 'install')}
                />
                <div className="faint" style={{ fontSize: 10.5, margin: '4px 0 12px', lineHeight: 1.6 }}>
                  保存并复制后，在任意终端运行。自动检测 Claude Code、Codex、Kimi、Cursor、
                  VS Code、Windsurf、Claude Desktop 和 DSH；已有配置会先备份。
                </div>

                <label style={{ display: 'block', marginBottom: 6 }}>或选择指定客户端</label>
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
                  这两个按钮会打开客户端确认框；其他客户端使用下面的命令，不会自动启动程序。
                </div>

                <CommandCopyRow label="Claude Code" command={claudeCmd} copyKey="claude"
                  copied={copied} saving={saving} onCopy={() => copyCommand(claudeCmd, 'claude')} />
                <CommandCopyRow label="Codex" command={codexCmd} copyKey="codex"
                  copied={copied} saving={saving} onCopy={() => copyCommand(codexCmd, 'codex')} />
                <CommandCopyRow label="Kimi Code" command={installCmd('kimi-code')} copyKey="kimi-code"
                  copied={copied} saving={saving}
                  onCopy={() => copyCommand(installCmd('kimi-code'), 'kimi-code')} />
                <div className="faint" style={{ fontSize: 10.5, margin: '4px 0 8px' }}>
                  Kimi Code 配置后新建会话生效，可在 TUI 用 /mcp 检查连接。
                </div>

                <details style={{ marginTop: 10 }}>
                  <summary style={{ fontSize: 11.5, cursor: 'pointer', color: 'var(--muted)' }}>
                    更多客户端（Kimi 旧版、DSH）
                  </summary>
                  <div style={{ marginTop: 8 }}>
                    <CommandCopyRow label="Kimi CLI 旧版" command={kimiLegacyCmd} copyKey="kimi-legacy"
                      copied={copied} saving={saving}
                      onCopy={() => copyCommand(kimiLegacyCmd, 'kimi-legacy')} />
                    <CommandCopyRow label="DSH · web" command={installCmd('dsh-web')} copyKey="dsh-web"
                      copied={copied} saving={saving}
                      onCopy={() => copyCommand(installCmd('dsh-web'), 'dsh-web')} />
                    <CommandCopyRow label="DSH · desktop" command={installCmd('dsh-desktop')}
                      copyKey="dsh-desktop" copied={copied} saving={saving}
                      onCopy={() => copyCommand(installCmd('dsh-desktop'), 'dsh-desktop')} />
                    <div className="faint" style={{ fontSize: 10.5, margin: '4px 0 8px', lineHeight: 1.6 }}>
                      DSH 使用原生 cordis.patch.yml。安装器只创建空配置或更新自己标记的配置块；
                      已有其他 YAML 内容时会停止并给出手动合并提示，不会强行覆盖。
                    </div>
                  </div>
                </details>

                <details style={{ marginTop: 10 }}>
                  <summary style={{ fontSize: 11.5, cursor: 'pointer', color: 'var(--muted)' }}>
                    本地开发版与手动配置
                  </summary>
                  <div style={{ marginTop: 8 }}>
                    <CommandCopyRow label="GitHub 源码版（在仓库根目录运行）" command={localInstallCmd}
                      copyKey="local" copied={copied} saving={saving}
                      onCopy={() => copyCommand(localInstallCmd, 'local')} />
                    <div className="row" style={{ justifyContent: 'flex-end', margin: '10px 0 4px' }}>
                      <button className="tiny" disabled={saving}
                        onClick={() => void saveAndRun(() => copy(manualConfig, 'config'))}>
                        {copied === 'config' ? '已复制' : '保存并复制手动 JSON'}
                      </button>
                    </div>
                    <pre className="mono codeblock">{manualConfig}</pre>
                    <div className="faint" style={{ fontSize: 10.5, lineHeight: 1.6 }}>
                      手动 JSON 适用于支持 mcpServers 的客户端。Kimi Code 用户级配置是
                      ~/.kimi-code/mcp.json；DSH 不使用这种格式，请用上面的 DSH 命令。
                    </div>
                  </div>
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

interface CommandCopyRowProps {
  label: string;
  command: string;
  copyKey: string;
  copied: string | null;
  saving: boolean;
  onCopy: () => void | Promise<void>;
}

/** 所有命令入口共用“保存成功才复制”的行为，避免新 token 尚未生效就跳转。 */
function CommandCopyRow({
  label,
  command,
  copyKey,
  copied,
  saving,
  onCopy,
}: CommandCopyRowProps) {
  return (
    <div style={{ marginTop: 8 }}>
      <label>{label}</label>
      <div className="row" style={{ gap: 6 }}>
        <input
          className="mono"
          readOnly
          value={command}
          onFocus={(event) => event.target.select()}
          style={{ fontSize: 11 }}
        />
        <button className="tiny" disabled={saving} onClick={() => void onCopy()}>
          {copied === copyKey ? '已复制' : '保存并复制'}
        </button>
      </div>
    </div>
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
