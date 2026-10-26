/** 安装器黑盒验证：只操作临时 HOME，绝不碰真实客户端配置。 */
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = resolve(HERE, 'dist/bundle/mock-studio-mcp.mjs');
let passed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'mock-studio-install-e2e-'));
  const home = join(root, 'home');
  const cwd = join(root, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { root, home, cwd };
}

function run(box, args, extraEnv = {}) {
  return spawnSync(process.execPath, [BUNDLE, 'install', ...args], {
    cwd: box.cwd,
    env: { ...process.env, HOME: box.home, ...extraEnv },
    encoding: 'utf8',
  });
}

function backups(path) {
  const dir = dirname(path);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.includes('.mock-studio.') && name.endsWith('.bak'));
}

test('Kimi Code 精确安装保留其他配置并生成时间戳备份', () => {
  const box = sandbox();
  const path = join(box.home, '.kimi-code', 'mcp.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ other: true, mcpServers: { keep: { command: 'keep' } } }));
  const result = run(box, ['--client', 'kimi-code', '--token', 'secret', '--yes']);
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(config.other, true);
  assert.deepEqual(config.mcpServers.keep, { command: 'keep' });
  assert.equal(config.mcpServers['mock-studio'].env.MOCK_STUDIO_TOKEN, 'secret');
  assert.equal(backups(path).length, 1);
  assert.equal(readdirSync(dirname(path)).some((name) => name.endsWith('.tmp')), false);
});

test('非法 JSON 在预览和安装中都失败且原文件不变', () => {
  const box = sandbox();
  const path = join(box.home, '.kimi-code', 'mcp.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '{broken');
  for (const extra of [['--print'], ['--yes']]) {
    const result = run(box, ['--client', 'kimi-code', '--token', 'new', ...extra]);
    assert.equal(result.status, 1);
    assert.equal(readFileSync(path, 'utf8'), '{broken');
    assert.equal(backups(path).length, 0);
  }
});

test('多目标部分失败返回非零，同时保留成功目标', () => {
  const box = sandbox();
  const cursor = join(box.home, '.cursor', 'mcp.json');
  mkdirSync(dirname(cursor), { recursive: true });
  writeFileSync(cursor, '{broken');
  const result = run(box, ['--client', 'kimi-code,cursor', '--token', 'secret', '--yes']);
  assert.equal(result.status, 1);
  assert.equal(readFileSync(cursor, 'utf8'), '{broken');
  const kimi = JSON.parse(readFileSync(join(box.home, '.kimi-code', 'mcp.json'), 'utf8'));
  assert.equal(kimi.mcpServers['mock-studio'].env.MOCK_STUDIO_TOKEN, 'secret');
  assert.match(result.stderr, /部分目标未接入/);
});

test('未知客户端和非法端口给出明确错误', () => {
  const box = sandbox();
  const unknown = run(box, ['--client', 'not-a-client', '--token', 'secret', '--yes']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /可用 ID/);
  const port = run(box, ['--client', 'kimi-code', '--token', 'secret', '--port', 'nope']);
  assert.equal(port.status, 1);
  assert.match(port.stderr, /无效端口/);
});

test('--project 同时创建 Claude Code 与 Kimi Code 项目配置', () => {
  const box = sandbox();
  const result = run(box, ['--project', '--token', 'secret', '--yes']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(box.cwd, '.mcp.json')), true);
  assert.equal(existsSync(join(box.cwd, '.kimi-code', 'mcp.json')), true);
});

test('DSH 创建并更新自己的 YAML 块，拒绝覆盖复杂配置', () => {
  const box = sandbox();
  const path = join(box.home, '.dsh', 'profiles', 'web', 'cordis.patch.yml');
  let result = run(box, ['--client', 'dsh-web', '--token', 'secret', '--yes']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(path, 'utf8'), /@deepseek-ai\/dsh-mcp-client/);
  result = run(box, ['--client', 'dsh-web', '--token', 'updated', '--yes']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(path, 'utf8'), /MOCK_STUDIO_TOKEN: 'updated'/);
  assert.equal(backups(path).length, 1);

  writeFileSync(path, '- insert:\n    - id: other\n');
  result = run(box, ['--client', 'dsh-web', '--token', 'nope', '--yes']);
  assert.equal(result.status, 1);
  assert.equal(readFileSync(path, 'utf8'), '- insert:\n    - id: other\n');
});

test('自动检测跳过复杂 DSH，不影响其他客户端', () => {
  const box = sandbox();
  const dsh = join(box.home, '.dsh', 'profiles', 'web', 'cordis.patch.yml');
  mkdirSync(dirname(dsh), { recursive: true });
  mkdirSync(join(box.home, '.cursor'), { recursive: true });
  writeFileSync(dsh, '- insert:\n    - id: other\n');
  const result = run(box, ['--token', 'secret', '--yes']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(dsh, 'utf8'), '- insert:\n    - id: other\n');
  assert.equal(existsSync(join(box.home, '.cursor', 'mcp.json')), true);
  assert.match(result.stdout, /跳过 DSH/);
});

test('Codex 通过官方 CLI 独立参数执行并备份 TOML', () => {
  const box = sandbox();
  const bin = join(box.root, 'bin');
  const capture = join(box.root, 'codex-args.json');
  const codexHome = join(box.root, 'codex-home');
  mkdirSync(bin);
  mkdirSync(codexHome);
  const config = join(codexHome, 'config.toml');
  writeFileSync(config, '# keep this config\n');
  const fake = join(bin, 'codex');
  writeFileSync(fake, `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nif (process.argv[2] !== '--version') writeFileSync(process.env.CODEX_CAPTURE, JSON.stringify(process.argv.slice(2)));\n`);
  chmodSync(fake, 0o755);
  const env = { PATH: `${bin}:${process.env.PATH}`, CODEX_HOME: codexHome, CODEX_CAPTURE: capture };
  const token = 'abc;touch SHOULD_NOT_EXIST';
  const result = run(box, ['--client', 'codex', '--token', token, '--port', '9999', '--yes'], env);
  assert.equal(result.status, 0, result.stderr);
  const args = JSON.parse(readFileSync(capture, 'utf8'));
  assert.deepEqual(args, [
    'mcp', 'add', 'mock-studio',
    '--env', `MOCK_STUDIO_TOKEN=${token}`,
    '--env', 'MOCK_STUDIO_PORT=9999',
    '--', 'node', BUNDLE,
  ]);
  assert.equal(existsSync(join(box.cwd, 'SHOULD_NOT_EXIST')), false);
  assert.equal(backups(config).length, 1);
  assert.equal(readFileSync(config, 'utf8'), '# keep this config\n');
});

test('Codex 预览不执行命令也不创建备份', () => {
  const box = sandbox();
  const bin = join(box.root, 'bin');
  const capture = join(box.root, 'codex-args.json');
  const codexHome = join(box.root, 'codex-home');
  mkdirSync(bin);
  mkdirSync(codexHome);
  const config = join(codexHome, 'config.toml');
  writeFileSync(config, 'model = "test"\n');
  const fake = join(bin, 'codex');
  writeFileSync(fake, `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.CODEX_CAPTURE, 'executed');\n`);
  chmodSync(fake, 0o755);
  const result = run(box, ['--client', 'codex', '--token', 'secret', '--print'], {
    PATH: `${bin}:${process.env.PATH}`,
    CODEX_HOME: codexHome,
    CODEX_CAPTURE: capture,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /codex mcp add mock-studio/);
  assert.equal(existsSync(capture), false);
  assert.equal(backups(config).length, 0);
});

console.log(`\n${passed} 项安装器 e2e 全部通过（临时 HOME）。`);
