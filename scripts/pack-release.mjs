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
  `# 安装 Mock Studio v${version}

1. 下载并解压 \`${zipName}\`。
2. 用 Chrome 116 或更新版本打开 \`chrome://extensions\`，开启 **开发者模式**。
3. 点 **加载已解压的扩展程序**，选择包含 \`manifest.json\` 的目录。
4. 首次安装会打开带上手提示的规则管理页。刷新要调试的网页，再打开开发者工具的 **Mock** 面板。

在 **Mock** 面板里选择一条请求，点 **转为 Mock**，修改响应并保存。重新触发该请求即可查看效果。

## 可选 · 接入 AI

在规则管理页打开 **MCP**，启用后复制配对码。使用 Node.js 18 或更新版本运行同一个 Release 提供的 MCP 文件：

\`\`\`bash
node /path/to/${mcpName} install --token '<配对码>'
\`\`\`

按安装器提示确认目标客户端，再重启客户端或新建会话。安装后保留 MCP 文件的位置，客户端会通过该路径启动它。
`,
);

console.log(`\n✓ release/${zipName}`);
console.log(`✓ release/${mcpName}`);
console.log(`✓ release/INSTALL.md`);
