/**
 * `install` 子命令 —— 一键把本 server 写进各 AI 客户端的 MCP 配置。
 *
 * ── 它解决的两个真实痛点 ──────────────────────────────
 * 1. 路径：用户以前要自己 pwd、确认编译产物在哪一层 dist，
 *    再手填进配置。本命令运行时就知道自己在哪，直接写绝对路径。
 * 2. 配对码：以前每个客户端配置里都要贴一遍。这里**只贴一次**，
 *    写进所有检测到的客户端。
 *
 * ── 设计约束 ─────────────────────────────────────────
 * · 只用 Node 内置模块（它和 server 打进同一个零依赖单文件）
 * · stdout 随便写 —— install 不是 MCP 模式，没有协议通道要保护
 * · 写配置前一律备份（<文件>.mock-studio.bak），合并而不是覆盖
 * · 检测不到客户端不报错，如实列出「发现了哪些、没发现哪些」
 */

import { existsSync, mkdirSync, readFileSync, copyFileSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { DEFAULT_BRIDGE_PORT } from '../../src/core/types.js';

const SERVER_NAME = 'mock-studio';

// ═══════════════════════════════════════════════════════════
// 各客户端的配置文件位置与格式差异
// ═══════════════════════════════════════════════════════════

interface ClientTarget {
  id: string;
  label: string;
  configPath: string;
  /** 服务器列表在哪个键下：VS Code 用 servers，其他基本都是 mcpServers */
  serversKey: 'mcpServers' | 'servers';
  /** 依据文件还是父目录来判定「这个客户端装了」 */
  detectBy: 'file' | 'dir';
}

function vscodeUserDir(): string {
  if (platform() === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Code', 'User');
  }
  if (platform() === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Code', 'User');
  }
  return join(homedir(), '.config', 'Code', 'User');
}

function claudeDesktopDir(): string {
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Claude');
  if (platform() === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Claude');
  }
  return join(homedir(), '.config', 'Claude');
}

function knownClients(cwd: string): ClientTarget[] {
  return [
    {
      id: 'claude-project',
      label: `Claude Code（项目级 ${join(cwd, '.mcp.json')}）`,
      configPath: join(cwd, '.mcp.json'),
      serversKey: 'mcpServers',
      detectBy: 'file',
    },
    {
      id: 'claude-user',
      label: 'Claude Code（用户级 ~/.claude.json）',
      configPath: join(homedir(), '.claude.json'),
      serversKey: 'mcpServers',
      detectBy: 'file',
    },
    {
      id: 'cursor',
      label: 'Cursor（~/.cursor/mcp.json）',
      configPath: join(homedir(), '.cursor', 'mcp.json'),
      serversKey: 'mcpServers',
      detectBy: 'dir',
    },
    {
      id: 'vscode',
      label: 'VS Code（用户 mcp.json）',
      configPath: join(vscodeUserDir(), 'mcp.json'),
      serversKey: 'servers',
      detectBy: 'dir',
    },
    {
      id: 'windsurf',
      label: 'Windsurf（~/.codeium/windsurf/mcp_config.json）',
      configPath: join(homedir(), '.codeium', 'windsurf', 'mcp_config.json'),
      serversKey: 'mcpServers',
      detectBy: 'dir',
    },
    {
      id: 'claude-desktop',
      label: 'Claude Desktop（claude_desktop_config.json）',
      configPath: join(claudeDesktopDir(), 'claude_desktop_config.json'),
      serversKey: 'mcpServers',
      detectBy: 'dir',
    },
  ];
}

// ═══════════════════════════════════════════════════════════
// 参数解析（手写，不引依赖 —— 单文件约束）
// ═══════════════════════════════════════════════════════════

interface InstallOptions {
  token: string | null;
  port: number;
  yes: boolean;
  print: boolean;
  useNpx: boolean;
  includeProject: boolean;
  onlyClients: string[] | null;
  help: boolean;
}

function parseArgs(argv: string[]): InstallOptions {
  const opts: InstallOptions = {
    token: process.env.MOCK_STUDIO_TOKEN ?? null,
    port: Number(process.env.MOCK_STUDIO_PORT) || DEFAULT_BRIDGE_PORT,
    yes: false,
    print: false,
    useNpx: false,
    includeProject: false,
    onlyClients: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--token') opts.token = argv[++i] ?? null;
    else if (a.startsWith('--token=')) opts.token = a.slice('--token='.length);
    else if (a === '--port') opts.port = Number(argv[++i]) || opts.port;
    else if (a.startsWith('--port=')) opts.port = Number(a.slice('--port='.length)) || opts.port;
    else if (a === '--yes' || a === '-y') opts.yes = true;
    else if (a === '--print') opts.print = true;
    else if (a === '--npx') opts.useNpx = true;
    else if (a === '--project') opts.includeProject = true;
    else if (a === '--client') opts.onlyClients = (argv[++i] ?? '').split(',').filter(Boolean);
    else if (a.startsWith('--client=')) opts.onlyClients = a.slice('--client='.length).split(',').filter(Boolean);
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

const HELP = `mock-studio-mcp install —— 一键写入各 AI 客户端的 MCP 配置

用法：
  mock-studio-mcp install [--token <配对码>] [选项]

选项：
  --token <配对码>    扩展「MCP 桥」面板里的配对码；不传则交互式询问
  --port <端口>       桥端口，默认 ${DEFAULT_BRIDGE_PORT}（和扩展设置保持一致）
  --client <a,b>      只写指定客户端：claude-project, claude-user, cursor,
                      vscode, windsurf, claude-desktop
  --project           即使当前目录还没有 .mcp.json，也写入项目级配置
  --npx               配置写成 npx -y mock-studio-mcp 形式（npm 发布后用）
  --print             只打印将要写入的内容，不落盘
  --yes, -y           不再逐项确认
  --help, -h          显示本帮助
`;

// ═══════════════════════════════════════════════════════════
// 主流程
// ═══════════════════════════════════════════════════════════

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, (ans) => { rl.close(); res(ans.trim()); }));
}

function detect(t: ClientTarget): boolean {
  return t.detectBy === 'file'
    ? existsSync(t.configPath)
    : existsSync(dirname(t.configPath));
}

export async function runInstall(argv: string[]): Promise<void> {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(HELP);
    return;
  }

  const bundlePath = fileURLToPath(import.meta.url);
  // 从 npx 缓存目录跑的时候，配置里写缓存路径是陷阱 —— 下次 npx 可能换目录。
  // 检测到就自动切成 npx 形式。
  const inNpxCache = /[\\/]_npx[\\/]/.test(bundlePath);
  const useNpx = opts.useNpx || inNpxCache;

  // ── 配对码：只问这一次 ──
  let token = opts.token;
  if (!token) {
    if (!process.stdin.isTTY) {
      console.error(
        '缺少配对码。请用 --token <配对码> 传入。\n' +
          '配对码在 Chrome 扩展 Mock Studio → 规则管理页右上角「MCP」面板里复制。',
      );
      process.exit(1);
    }
    token = await prompt('请粘贴扩展「MCP 桥」面板里的配对码: ');
    if (!token) {
      console.error('配对码为空，已取消。');
      process.exit(1);
    }
  }

  // ── 要写的服务器配置 ──
  const entry: Record<string, unknown> = useNpx
    ? { command: 'npx', args: ['-y', 'mock-studio-mcp'] }
    : { command: 'node', args: [bundlePath] };
  entry.env = {
    MOCK_STUDIO_TOKEN: token,
    ...(opts.port !== DEFAULT_BRIDGE_PORT ? { MOCK_STUDIO_PORT: String(opts.port) } : {}),
  };

  // ── 选目标 ──
  let targets = knownClients(process.cwd()).filter((t) => {
    if (opts.onlyClients) return opts.onlyClients.includes(t.id);
    if (t.id === 'claude-project') return opts.includeProject || existsSync(t.configPath);
    return detect(t);
  });

  if (targets.length === 0) {
    console.log('没有检测到任何已安装的 AI 客户端配置。\n');
    console.log('可以手动把下面这段加到你客户端的 MCP 配置里：\n');
    console.log(JSON.stringify({ mcpServers: { [SERVER_NAME]: entry } }, null, 2));
    return;
  }

  console.log(`\n将写入 ${SERVER_NAME} 到以下 ${targets.length} 个客户端：`);
  for (const t of targets) console.log(`  · ${t.label}`);
  console.log(
    `\n服务器入口：${
      useNpx ? 'npx -y mock-studio-mcp' : `node ${bundlePath}`
    }${opts.port !== DEFAULT_BRIDGE_PORT ? `（端口 ${opts.port}）` : ''}\n`,
  );

  if (opts.print) {
    for (const t of targets) {
      // 预览也要基于真实文件内容合并，否则用户看到的和实际写入的不一致
      const raw = existsSync(t.configPath) ? readFileSync(t.configPath, 'utf8') : null;
      const merged = mergeConfig(t, entry, raw);
      console.log(`── ${t.configPath}\n${JSON.stringify(merged, null, 2)}\n`);
    }
    console.log('（--print 模式，未落盘）');
    return;
  }

  if (!opts.yes && process.stdin.isTTY) {
    const ans = await prompt('确认写入？[Y/n] ');
    if (ans && ans.toLowerCase() !== 'y' && ans.toLowerCase() !== 'yes') {
      console.log('已取消。');
      return;
    }
  }

  // ── 落盘：备份 → 合并 → 写 ──
  let written = 0;
  for (const t of targets) {
    try {
      const existed = existsSync(t.configPath);
      const raw = existed ? readFileSync(t.configPath, 'utf8') : null;
      const merged = mergeConfig(t, entry, raw);
      mkdirSync(dirname(t.configPath), { recursive: true });
      if (existed) {
        copyFileSync(t.configPath, `${t.configPath}.mock-studio.bak`);
      }
      writeFileSync(t.configPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
      console.log(`✓ ${t.label}${existed ? '（原配置已备份为 .mock-studio.bak）' : ''}`);
      written++;
    } catch (e) {
      console.error(`✗ ${t.label} 写入失败：${(e as Error).message}`);
    }
  }

  console.log(
    `\n完成（${written}/${targets.length}）。**重启对应的 AI 客户端**后生效 ——\n` +
      'MCP Server 是客户端拉起的子进程，不重启读不到新配置。',
  );
}

/** 合并配置：保留其他服务器和其他顶层键，只替换/新增 mock-studio 这一项 */
function mergeConfig(
  target: ClientTarget,
  entry: Record<string, unknown>,
  raw: string | null,
): Record<string, unknown> {
  let config: Record<string, unknown> = {};
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>;
      }
    } catch {
      console.error(`  ⚠ ${target.configPath} 不是合法 JSON，将基于空配置合并（原文件已备份）`);
    }
  }
  const servers =
    config[target.serversKey] && typeof config[target.serversKey] === 'object'
      ? { ...(config[target.serversKey] as Record<string, unknown>) }
      : {};
  // VS Code 要求显式声明 stdio 类型
  servers[SERVER_NAME] =
    target.serversKey === 'servers' ? { type: 'stdio', ...entry } : entry;
  config[target.serversKey] = servers;
  return config;
}
