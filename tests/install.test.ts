import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  codexCommand,
  formatCommand,
  knownClients,
  mergeDshConfig,
  mergeJsonConfig,
  parseInstallArgs,
  writeTextAtomic,
  type JsonClientTarget,
} from '../mcp-server/src/install.js';

const entry = {
  command: 'npx',
  args: ['-y', 'mock-studio-mcp'],
  env: { MOCK_STUDIO_TOKEN: 'secret', MOCK_STUDIO_PORT: '9999' },
};

function jsonTarget(overrides: Partial<JsonClientTarget> = {}): JsonClientTarget {
  return {
    id: 'kimi-code',
    label: 'Kimi Code',
    kind: 'json',
    location: '/tmp/mcp.json',
    configPath: '/tmp/mcp.json',
    serversKey: 'mcpServers',
    detectBy: 'dir',
    ...overrides,
  };
}

describe('MCP 客户端发现与参数', () => {
  it('识别 Codex、Kimi 两代和 DSH 的官方配置位置', () => {
    const clients = knownClients('/work', '/home/test', {
      CODEX_HOME: '/custom/codex',
      KIMI_CODE_HOME: '/custom/kimi',
      DSH_HOME: '/custom/dsh',
    }, 'linux');
    const byId = new Map(clients.map((client) => [client.id, client]));

    expect(byId.get('codex')).toMatchObject({ kind: 'command', backupPath: '/custom/codex/config.toml' });
    expect(byId.get('kimi-code')).toMatchObject({ configPath: '/custom/kimi/mcp.json' });
    expect(byId.get('kimi-code-project')).toMatchObject({ configPath: '/work/.kimi-code/mcp.json' });
    expect(byId.get('kimi-legacy')).toMatchObject({ configPath: '/home/test/.kimi/mcp.json' });
    expect(byId.get('dsh-web')).toMatchObject({
      kind: 'dsh',
      configPath: '/custom/dsh/profiles/web/cordis.patch.yml',
    });
  });

  it('拒绝未知参数、空客户端和非法端口', () => {
    expect(() => parseInstallArgs(['--wat'], {})).toThrow('未知参数');
    expect(() => parseInstallArgs(['--client='], {})).toThrow('--client 不能为空');
    expect(() => parseInstallArgs(['--port', '0'], {})).toThrow('无效端口');
    expect(() => parseInstallArgs([], { MOCK_STUDIO_PORT: 'abc' })).toThrow('无效端口');
  });

  it('支持重复指定客户端并严格解析端口', () => {
    const options = parseInstallArgs(['--client', 'codex,kimi-code', '--client=dsh-web', '--port=9000'], {});
    expect(options.onlyClients).toEqual(['codex', 'kimi-code', 'dsh-web']);
    expect(options.port).toBe(9000);
  });
});

describe('JSON 配置合并', () => {
  it('保留其他顶层字段和服务器，只更新 mock-studio', () => {
    const merged = mergeJsonConfig(jsonTarget(), entry, JSON.stringify({
      theme: 'dark',
      mcpServers: { other: { command: 'other' }, 'mock-studio': { command: 'old' } },
    }));
    expect(merged).toEqual({
      theme: 'dark',
      mcpServers: { other: { command: 'other' }, 'mock-studio': entry },
    });
  });

  it('为 VS Code 补 stdio 类型', () => {
    const merged = mergeJsonConfig(jsonTarget({ serversKey: 'servers' }), entry, null);
    expect(merged.servers).toEqual({ 'mock-studio': { type: 'stdio', ...entry } });
  });

  it.each([
    ['非法 JSON', '{broken'],
    ['数组顶层', '[]'],
    ['字符串顶层', '"text"'],
    ['非法服务器列表', '{"mcpServers":[]}'],
  ])('%s 时直接失败，不按空配置合并', (_name, raw) => {
    expect(() => mergeJsonConfig(jsonTarget(), entry, raw)).toThrow();
  });
});

describe('DSH 原生 YAML 适配', () => {
  it('为空配置创建官方 mcp-client insert 块', () => {
    const yaml = mergeDshConfig(entry, '[]\n');
    expect(yaml).toContain("- insert:\n    - id: mcp-mock-studio");
    expect(yaml).toContain("name: '@deepseek-ai/dsh-mcp-client'");
    expect(yaml).toContain("MOCK_STUDIO_TOKEN: 'secret'");
    expect(yaml).toContain("MOCK_STUDIO_PORT: '9999'");
  });

  it('重复安装只替换自己的标记块并保留其他内容', () => {
    const first = mergeDshConfig(entry, null);
    const withOtherConfig = `# before\n${first}# after\n`;
    const updated = mergeDshConfig({ ...entry, env: { MOCK_STUDIO_TOKEN: 'new' } }, withOtherConfig);
    expect(updated).toContain('# before');
    expect(updated).toContain('# after');
    expect(updated).toContain("MOCK_STUDIO_TOKEN: 'new'");
    expect(updated).not.toContain("MOCK_STUDIO_TOKEN: 'secret'");
  });

  it('转义 YAML 单引号，拒绝覆盖不认识的已有配置', () => {
    const quoted = mergeDshConfig({
      ...entry,
      env: { MOCK_STUDIO_TOKEN: "it's secret" },
    }, null);
    expect(quoted).toContain("MOCK_STUDIO_TOKEN: 'it''s secret'");
    expect(() => mergeDshConfig(entry, '- insert:\n    - id: other\n')).toThrow('未修改');
  });
});

describe('Codex 官方命令与文件写入', () => {
  it('把 token 和服务器入口作为独立参数传递', () => {
    const command = codexCommand(entry);
    expect(command).toEqual({
      command: 'codex',
      args: [
        'mcp', 'add', 'mock-studio',
        '--env', 'MOCK_STUDIO_TOKEN=secret',
        '--env', 'MOCK_STUDIO_PORT=9999',
        '--', 'npx', '-y', 'mock-studio-mcp',
      ],
    });
  });

  it('预览命令会引用包含空格或 shell 字符的值', () => {
    const preview = formatCommand('codex', ['mcp', 'add', 'a b;echo nope']);
    expect(preview).toBe("codex mcp add 'a b;echo nope'");
  });

  it('原子写入替换内容且不留下临时文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mock-studio-install-'));
    const path = join(dir, 'mcp.json');
    writeFileSync(path, 'old', 'utf8');
    writeTextAtomic(path, 'new\n');
    expect(readFileSync(path, 'utf8')).toBe('new\n');
    expect(readdirSync(dir)).toEqual(['mcp.json']);
  });
});
