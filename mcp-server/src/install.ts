/**
 * `install` 子命令：把本 server 接入各 AI 客户端。
 *
 * 三种适配器共享同一套参数、预览和结果汇总：
 * - JSON：保留其他服务器和顶层字段，只替换 mock-studio。
 * - CLI：Codex 交给官方命令处理，不在零依赖 bundle 里重写 TOML 解析器。
 * - DSH YAML：只创建空配置或更新本安装器标记的块；复杂配置明确转手动。
 *
 * 所有文件写入都先备份，再通过同目录临时文件原子替换；任何目标失败都会
 * 反映到退出码，不会让脚本把部分失败当成成功。
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { spawnSync } from 'node:child_process';
import { DEFAULT_BRIDGE_PORT } from '../../src/core/types.js';

const SERVER_NAME = 'mock-studio';
const DSH_START = '# >>> mock-studio-mcp >>>';
const DSH_END = '# <<< mock-studio-mcp <<<';

interface BaseClientTarget {
  id: string;
  label: string;
  location: string;
  detectBy: 'file' | 'dir' | 'command';
  project?: boolean;
}

export interface JsonClientTarget extends BaseClientTarget {
  kind: 'json';
  configPath: string;
  serversKey: 'mcpServers' | 'servers';
}

export interface CommandClientTarget extends BaseClientTarget {
  kind: 'command';
  command: 'codex';
  /** 官方 CLI 会修改这个文件，执行前仍需备份。 */
  backupPath: string;
}

export interface DshClientTarget extends BaseClientTarget {
  kind: 'dsh';
  configPath: string;
}

export type ClientTarget = JsonClientTarget | CommandClientTarget | DshClientTarget;

type Platform = ReturnType<typeof platform>;

function vscodeUserDir(home: string, env: NodeJS.ProcessEnv, os: Platform): string {
  if (os === 'darwin') return join(home, 'Library', 'Application Support', 'Code', 'User');
  if (os === 'win32') {
    return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Code', 'User');
  }
  return join(home, '.config', 'Code', 'User');
}

function claudeDesktopDir(home: string, env: NodeJS.ProcessEnv, os: Platform): string {
  if (os === 'darwin') return join(home, 'Library', 'Application Support', 'Claude');
  if (os === 'win32') {
    return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Claude');
  }
  return join(home, '.config', 'Claude');
}

function jsonTarget(
  target: Omit<JsonClientTarget, 'kind' | 'location'>,
): JsonClientTarget {
  return { ...target, kind: 'json', location: target.configPath };
}

function dshTarget(
  target: Omit<DshClientTarget, 'kind' | 'location'>,
): DshClientTarget {
  return { ...target, kind: 'dsh', location: target.configPath };
}

export function knownClients(
  cwd: string,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  os: Platform = platform(),
): ClientTarget[] {
  const dshHome = env.DSH_HOME || join(home, '.dsh');
  const codexHome = env.CODEX_HOME || join(home, '.codex');
  return [
    jsonTarget({
      id: 'claude-project',
      label: 'Claude Code（项目级）',
      configPath: join(cwd, '.mcp.json'),
      serversKey: 'mcpServers',
      detectBy: 'file',
      project: true,
    }),
    jsonTarget({
      id: 'claude-user',
      label: 'Claude Code（用户级）',
      configPath: join(home, '.claude.json'),
      serversKey: 'mcpServers',
      detectBy: 'file',
    }),
    {
      id: 'codex',
      label: 'Codex（CLI / IDE，用户级）',
      kind: 'command',
      command: 'codex',
      location: join(codexHome, 'config.toml'),
      backupPath: join(codexHome, 'config.toml'),
      detectBy: 'command',
    },
    jsonTarget({
      id: 'kimi-code-project',
      label: 'Kimi Code（项目级）',
      configPath: join(cwd, '.kimi-code', 'mcp.json'),
      serversKey: 'mcpServers',
      detectBy: 'file',
      project: true,
    }),
    jsonTarget({
      id: 'kimi-code',
      label: 'Kimi Code（用户级）',
      configPath: join(env.KIMI_CODE_HOME || join(home, '.kimi-code'), 'mcp.json'),
      serversKey: 'mcpServers',
      detectBy: 'dir',
    }),
    jsonTarget({
      id: 'kimi-legacy',
      label: 'Kimi CLI 旧版（用户级）',
      configPath: join(home, '.kimi', 'mcp.json'),
      serversKey: 'mcpServers',
      detectBy: 'dir',
    }),
    jsonTarget({
      id: 'cursor',
      label: 'Cursor（用户级）',
      configPath: join(home, '.cursor', 'mcp.json'),
      serversKey: 'mcpServers',
      detectBy: 'dir',
    }),
    jsonTarget({
      id: 'vscode',
      label: 'VS Code（用户级）',
      configPath: join(vscodeUserDir(home, env, os), 'mcp.json'),
      serversKey: 'servers',
      detectBy: 'dir',
    }),
    jsonTarget({
      id: 'windsurf',
      label: 'Windsurf（用户级）',
      configPath: join(home, '.codeium', 'windsurf', 'mcp_config.json'),
      serversKey: 'mcpServers',
      detectBy: 'dir',
    }),
    jsonTarget({
      id: 'claude-desktop',
      label: 'Claude Desktop（用户级）',
      configPath: join(claudeDesktopDir(home, env, os), 'claude_desktop_config.json'),
      serversKey: 'mcpServers',
      detectBy: 'dir',
    }),
    dshTarget({
      id: 'dsh-web',
      label: 'DSH（web profile）',
      configPath: join(dshHome, 'profiles', 'web', 'cordis.patch.yml'),
      detectBy: 'dir',
    }),
    dshTarget({
      id: 'dsh-desktop',
      label: 'DSH（desktop profile）',
      configPath: join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml'),
      detectBy: 'dir',
    }),
  ];
}

export interface InstallOptions {
  token: string | null;
  port: number;
  yes: boolean;
  print: boolean;
  useNpx: boolean;
  includeProject: boolean;
  onlyClients: string[] | null;
  help: boolean;
}

function parsePort(value: string | undefined): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`无效端口：${value ?? '(缺失)'}，应为 1–65535 的整数。`);
  }
  return port;
}

export function parseInstallArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): InstallOptions {
  const opts: InstallOptions = {
    token: env.MOCK_STUDIO_TOKEN ?? null,
    port: env.MOCK_STUDIO_PORT ? parsePort(env.MOCK_STUDIO_PORT) : DEFAULT_BRIDGE_PORT,
    yes: false,
    print: false,
    useNpx: false,
    includeProject: false,
    onlyClients: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--token' || a === '--port' || a === '--client') {
      const value = argv[++i];
      if (!value) throw new Error(`${a} 缺少参数。`);
      if (a === '--token') opts.token = value;
      else if (a === '--port') opts.port = parsePort(value);
      else opts.onlyClients = [...(opts.onlyClients ?? []), ...value.split(',').filter(Boolean)];
    } else if (a.startsWith('--token=')) {
      opts.token = a.slice('--token='.length);
      if (!opts.token) throw new Error('--token 不能为空。');
    } else if (a.startsWith('--port=')) {
      opts.port = parsePort(a.slice('--port='.length));
    } else if (a.startsWith('--client=')) {
      const clients = a.slice('--client='.length).split(',').filter(Boolean);
      if (clients.length === 0) throw new Error('--client 不能为空。');
      opts.onlyClients = [...(opts.onlyClients ?? []), ...clients];
    } else if (a === '--yes' || a === '-y') opts.yes = true;
    else if (a === '--print') opts.print = true;
    else if (a === '--npx') opts.useNpx = true;
    else if (a === '--project') opts.includeProject = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`未知参数：${a}`);
  }
  return opts;
}

const HELP = `mock-studio-mcp install —— 接入各 AI 客户端的 MCP 配置

用法：
  npx -y mock-studio-mcp install --token <配对码> [选项]

选项：
  --token <配对码>    扩展「MCP 桥」面板里的配对码；不传则交互式询问
  --port <端口>       桥端口，默认 ${DEFAULT_BRIDGE_PORT}（和扩展设置保持一致）
  --client <a,b>      只接入指定客户端，可重复传入：
                      claude-project, claude-user, codex,
                      kimi-code-project, kimi-code, kimi-legacy,
                      cursor, vscode, windsurf, claude-desktop,
                      dsh-web, dsh-desktop
  --project           同时写入 Claude Code / Kimi Code 项目级配置
  --npx               配置写成 npx -y mock-studio-mcp 形式（npx 缓存中自动启用）
  --print             预览合并结果或官方 CLI 命令，不写文件、不执行命令
  --yes, -y           不再逐项确认
  --help, -h          显示本帮助

说明：
  · JSON 配置只替换 mock-studio，保留其他服务器与顶层字段。
  · 已有配置先备份为 *.mock-studio.<时间戳>.bak，再原子写入。
  · DSH 仅自动创建空配置或更新本安装器标记的 YAML 块，不覆盖复杂配置。
`;

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, (ans) => { rl.close(); res(ans.trim()); }));
}

function detect(target: ClientTarget): boolean {
  if (target.kind === 'command') {
    const result = spawnSync(target.command, ['--version'], { shell: false, stdio: 'ignore' });
    return !result.error && result.status === 0;
  }
  const installed = target.detectBy === 'file'
    ? existsSync(target.configPath)
    : existsSync(dirname(target.configPath));
  if (!installed || target.kind !== 'dsh' || !existsSync(target.configPath)) return installed;
  // 自动模式不让一个复杂 DSH profile 拖累其他客户端；显式 --client 仍会给出完整错误。
  try {
    mergeDshConfig(
      { command: '', args: [], env: { MOCK_STUDIO_TOKEN: '' } },
      readFileSync(target.configPath, 'utf8'),
    );
    return true;
  } catch {
    return false;
  }
}

/** 合并 JSON：非法结构直接失败，绝不按空配置覆盖。 */
export function mergeJsonConfig(
  target: JsonClientTarget,
  entry: Record<string, unknown>,
  raw: string | null,
): Record<string, unknown> {
  let config: Record<string, unknown> = {};
  if (raw?.trim()) {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${target.configPath} 顶层必须是 JSON 对象。`);
    }
    config = parsed as Record<string, unknown>;
  }
  const existing = config[target.serversKey];
  if (existing !== undefined && (!existing || typeof existing !== 'object' || Array.isArray(existing))) {
    throw new Error(`${target.configPath} 的 ${target.serversKey} 必须是对象。`);
  }
  const servers = existing ? { ...(existing as Record<string, unknown>) } : {};
  servers[SERVER_NAME] = target.serversKey === 'servers' ? { type: 'stdio', ...entry } : entry;
  config[target.serversKey] = servers;
  return config;
}

function yamlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function dshBlock(entry: Record<string, unknown>): string {
  const env = entry.env as Record<string, string>;
  return [
    DSH_START,
    '- insert:',
    '    - id: mcp-mock-studio',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: mock-studio',
    '        transport: stdio',
    `        command: ${yamlString(String(entry.command))}`,
    `        args: [${(entry.args as string[]).map(yamlString).join(', ')}]`,
    '        env:',
    `          MOCK_STUDIO_TOKEN: ${yamlString(env.MOCK_STUDIO_TOKEN!)}`,
    ...(env.MOCK_STUDIO_PORT
      ? [`          MOCK_STUDIO_PORT: ${yamlString(env.MOCK_STUDIO_PORT)}`]
      : []),
    DSH_END,
    '',
  ].join('\n');
}

/** DSH 不用半个 YAML 解析器猜结构：空文件可建，只更新自己标记的块。 */
export function mergeDshConfig(entry: Record<string, unknown>, raw: string | null): string {
  const block = dshBlock(entry);
  if (!raw?.trim() || raw.trim() === '[]') return block;
  const start = raw.indexOf(DSH_START);
  const end = raw.indexOf(DSH_END);
  const hasUniqueMarkers =
    start >= 0 && end > start &&
    raw.indexOf(DSH_START, start + 1) < 0 &&
    raw.indexOf(DSH_END, end + 1) < 0;
  if (!hasUniqueMarkers) {
    throw new Error(
      '已有 DSH YAML 不是本安装器管理的配置。为避免破坏组合配置，未修改；' +
        '请手动合并 mock-studio 条目，或先备份并移开该文件后重试。',
    );
  }
  return raw.slice(0, start) + block + raw.slice(end + DSH_END.length).replace(/^\n/, '');
}

export function codexCommand(entry: Record<string, unknown>): { command: string; args: string[] } {
  const env = entry.env as Record<string, string>;
  return {
    command: 'codex',
    args: [
      'mcp', 'add', SERVER_NAME,
      '--env', `MOCK_STUDIO_TOKEN=${env.MOCK_STUDIO_TOKEN}`,
      ...(env.MOCK_STUDIO_PORT ? ['--env', `MOCK_STUDIO_PORT=${env.MOCK_STUDIO_PORT}`] : []),
      '--', String(entry.command), ...(entry.args as string[]),
    ],
  };
}

export function formatCommand(command: string, args: string[]): string {
  const quote = (value: string) => /^[A-Za-z0-9_./:=@+-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'"'"'`)}'`;
  return [command, ...args].map(quote).join(' ');
}

function backupFile(path: string): string | null {
  if (!existsSync(path)) return null;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${path}.mock-studio.${timestamp}.bak`;
  copyFileSync(path, backup);
  return backup;
}

export function writeTextAtomic(path: string, content: string): void {
  const temp = join(
    dirname(path),
    `.${basename(path)}.mock-studio-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`,
  );
  const mode = existsSync(path) ? statSync(path).mode : 0o600;
  try {
    writeFileSync(temp, content, { encoding: 'utf8', mode, flag: 'wx' });
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function previewTarget(target: ClientTarget, entry: Record<string, unknown>): string {
  if (target.kind === 'command') {
    const command = codexCommand(entry);
    return formatCommand(command.command, command.args);
  }
  const raw = existsSync(target.configPath) ? readFileSync(target.configPath, 'utf8') : null;
  return target.kind === 'json'
    ? JSON.stringify(mergeJsonConfig(target, entry, raw), null, 2) + '\n'
    : mergeDshConfig(entry, raw);
}

function activationHint(target: ClientTarget): string {
  if (target.id.startsWith('kimi-code')) return '新建 Kimi Code 会话后生效（已打开的会话不会加载新增配置）。';
  if (target.kind === 'dsh') return `重启 DSH ${target.id === 'dsh-web' ? 'web' : 'desktop'} profile 后生效。`;
  return '重启对应客户端后生效。';
}

export async function runInstall(argv: string[]): Promise<void> {
  let opts: InstallOptions;
  try {
    opts = parseInstallArgs(argv);
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${HELP}`);
    process.exitCode = 1;
    return;
  }
  if (opts.help) {
    console.log(HELP);
    return;
  }

  const clients = knownClients(process.cwd());
  if (opts.onlyClients) {
    const valid = new Set(clients.map((client) => client.id));
    const unknown = opts.onlyClients.filter((id) => !valid.has(id));
    if (unknown.length > 0) {
      console.error(`未知客户端：${unknown.join(', ')}\n可用 ID：${[...valid].join(', ')}`);
      process.exitCode = 1;
      return;
    }
  }

  const bundlePath = fileURLToPath(import.meta.url);
  // npx 缓存路径可能随版本改变，不能写进长期配置。
  const useNpx = opts.useNpx || /[\\/]_npx[\\/]/.test(bundlePath);

  let token = opts.token;
  if (!token) {
    if (!process.stdin.isTTY) {
      console.error(
        '缺少配对码。请用 --token <配对码> 传入。\n' +
          '配对码在 Chrome 扩展 Mock Studio → 规则管理页右上角「MCP」面板里复制。',
      );
      process.exitCode = 1;
      return;
    }
    token = await prompt('请粘贴扩展「MCP 桥」面板里的配对码: ');
    if (!token) {
      console.error('配对码为空，已取消。');
      process.exitCode = 1;
      return;
    }
  }

  const entry: Record<string, unknown> = useNpx
    ? { command: 'npx', args: ['-y', 'mock-studio-mcp'] }
    : { command: 'node', args: [bundlePath] };
  entry.env = {
    MOCK_STUDIO_TOKEN: token,
    ...(opts.port !== DEFAULT_BRIDGE_PORT ? { MOCK_STUDIO_PORT: String(opts.port) } : {}),
  };

  const targets = clients.filter((target) => {
    if (opts.onlyClients) return opts.onlyClients.includes(target.id);
    if (target.kind !== 'command' && target.project) {
      return opts.includeProject || existsSync(target.configPath);
    }
    return detect(target);
  });
  const skippedDsh = opts.onlyClients ? [] : clients.filter((target) =>
    target.kind === 'dsh' && existsSync(dirname(target.configPath)) && !detect(target));
  for (const target of skippedDsh) {
    console.log(`↷ 跳过 ${target.label}：已有复杂 YAML，未自动改动；可 --client ${target.id} 查看手动合并提示。`);
  }

  if (targets.length === 0) {
    console.log('没有检测到任何已安装的 AI 客户端配置。\n');
    console.log('可用 --client <ID> 明确创建配置，或用 --help 查看全部客户端。');
    console.log('也可以手动把下面这段加到支持 mcpServers 的客户端配置里：\n');
    console.log(JSON.stringify({ mcpServers: { [SERVER_NAME]: entry } }, null, 2));
    return;
  }

  console.log(`\n将接入 ${SERVER_NAME} 到以下 ${targets.length} 个客户端：`);
  for (const target of targets) console.log(`  · ${target.label}（${target.location}）`);
  console.log(
    `\n服务器入口：${useNpx ? 'npx -y mock-studio-mcp' : `node ${bundlePath}`}` +
      `${opts.port !== DEFAULT_BRIDGE_PORT ? `（端口 ${opts.port}）` : ''}\n`,
  );

  if (opts.print) {
    let failed = 0;
    for (const target of targets) {
      try {
        console.log(`── ${target.label}\n${previewTarget(target, entry)}\n`);
      } catch (error) {
        failed++;
        console.error(`✗ ${target.label} 预览失败：${(error as Error).message}`);
      }
    }
    console.log('（--print 模式，未写文件、未执行客户端命令）');
    if (failed > 0) process.exitCode = 1;
    return;
  }

  if (!opts.yes && process.stdin.isTTY) {
    const ans = await prompt('确认接入？[Y/n] ');
    if (ans && ans.toLowerCase() !== 'y' && ans.toLowerCase() !== 'yes') {
      console.log('已取消。');
      return;
    }
  }

  let written = 0;
  const succeeded: ClientTarget[] = [];
  for (const target of targets) {
    try {
      if (target.kind === 'command') {
        const backup = backupFile(target.backupPath);
        const command = codexCommand(entry);
        const result = spawnSync(command.command, command.args, { shell: false, stdio: 'inherit' });
        if (result.error) throw result.error;
        if (result.status !== 0) throw new Error(`官方命令退出码 ${result.status ?? '未知'}。`);
        console.log(`✓ ${target.label}${backup ? `（已备份 ${backup}）` : ''}`);
      } else {
        const raw = existsSync(target.configPath) ? readFileSync(target.configPath, 'utf8') : null;
        // 先完成解析与合并，再备份和写盘；坏配置不会进入写入阶段。
        const content = target.kind === 'json'
          ? JSON.stringify(mergeJsonConfig(target, entry, raw), null, 2) + '\n'
          : mergeDshConfig(entry, raw);
        mkdirSync(dirname(target.configPath), { recursive: true });
        const backup = backupFile(target.configPath);
        writeTextAtomic(target.configPath, content);
        console.log(`✓ ${target.label}${backup ? `（已备份 ${backup}）` : ''}`);
      }
      written++;
      succeeded.push(target);
    } catch (error) {
      console.error(`✗ ${target.label} 接入失败：${(error as Error).message}`);
    }
  }

  console.log(`\n完成（${written}/${targets.length}）。`);
  for (const target of succeeded) console.log(`  · ${target.label}：${activationHint(target)}`);
  if (written !== targets.length) {
    console.error('部分目标未接入，已保留其他目标的成功结果；请根据上面的错误修复后重试。');
    process.exitCode = 1;
  }
}
