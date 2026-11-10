/**
 * Release 打包 —— 一条命令产出 GitHub Release 要挂的两个产物。
 *
 *   node scripts/pack-release.mjs [--skip-build]
 *
 * 产物（release/ 目录下）：
 *   mock-studio-extension-v<版本>.zip   解压后在 chrome://extensions 加载即可
 *   mock-studio-mcp-v<版本>.mjs         MCP Server 零依赖单文件
 *
 * 为什么打 zip 而不是让用户 clone 后自己 build：
 *   这个项目的用户是「想立刻用 mock 的前端」，不是「想研究构建系统的人」。
 *   Release 里挂 zip 是未上架 Chrome Web Store 前摩擦最低的分发方式。
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_BUILD = process.argv.includes('--skip-build');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
const outDir = join(ROOT, 'release');

function run(cmd, args, cwd = ROOT) {
  console.log(`\n$ ${cmd} ${args.join(' ')}  (${cwd})`);
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}

if (!SKIP_BUILD) {
  run('npm', ['run', 'build']);
  run('npm', ['run', 'build'], join(ROOT, 'mcp-server'));
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// ── 扩展 zip ──
// zip 里必须有一层顶层目录，解压后直接「加载已解压的扩展程序」选中它即可
const zipName = `mock-studio-extension-v${version}.zip`;
const staging = join(outDir, '.staging', `mock-studio-v${version}`);
rmSync(join(outDir, '.staging'), { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
execFileSync('cp', ['-R', join(ROOT, 'dist') + '/', staging]);
execFileSync('zip', ['-qr', join(ROOT, 'release', zipName), `mock-studio-v${version}`], {
  cwd: join(outDir, '.staging'),
});

// ── MCP 单文件 ──
const mcpName = `mock-studio-mcp-v${version}.mjs`;
copyFileSync(
  join(ROOT, 'mcp-server', 'dist', 'bundle', 'mock-studio-mcp.mjs'),
  join(outDir, mcpName),
);

rmSync(join(outDir, '.staging'), { recursive: true, force: true });

// ── 校验产物真的能用：单文件至少要能跑 install --help ──
execFileSync('node', [join(outDir, mcpName), 'install', '--help'], { stdio: 'pipe' });

writeFileSync(
  join(outDir, 'INSTALL.md'),
  `# Mock Studio v${version} 安装包

## 1. 装扩展（30 秒）

解压 \`${zipName}\`，打开 \`chrome://extensions\` → 右上角开「开发者模式」→
「加载已解压的扩展程序」→ 选中解压出来的目录。

## 2. 接 MCP（让 AI 直接操作，1 分钟）

方式 A（推荐）：扩展装好后会自动打开引导页；或在规则管理页点右上角
**MCP** → 启用 → 用面板里的「一键装进 Cursor / VS Code」或 Claude Code 命令。

方式 B（命令行）：在任意目录跑

\`\`\`bash
node ${mcpName} install
\`\`\`

按提示粘贴一次扩展里的配对码，会自动写进所有已安装的 AI 客户端
（Claude Code / Cursor / VS Code / Windsurf / Claude Desktop），写前自动备份。

## 3. 验证

对你的 AI 说：「页面没数据，帮我 mock 一下」。
`,
);

console.log(`\n✓ release/${zipName}`);
console.log(`✓ release/${mcpName}`);
console.log(`✓ release/INSTALL.md`);
console.log(`\n挂到 GitHub Release：`);
console.log(
  `  gh release create v${version} release/${zipName} release/${mcpName} release/INSTALL.md --title "v${version}" --notes "见 INSTALL.md"`,
);
