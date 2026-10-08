#!/usr/bin/env node
/*
 * 备份当前（0.2.0）源码快照 —— 方便 0.3 开发失败时回退。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 为什么不直接用 git tag
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `git status` 显示 **275 个文件未提交** —— 整个 0.2 周期（这一整轮）
 * 全在工作区里没提交过。打个 tag 只能记下「提交点」，
 * 而 0.2 的绝大部分改动并不在任何一个提交里。
 *
 * 所以这里做的是**独立于 git 的完整源码快照**：
 * 即使之后 git 被 reset/checkout 搞乱了，这个快照仍然完好。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 备份什么 / 不备份什么
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 备份（源码本体，4.1MB）：
 *   src / tests / scripts / build / docs / .gitignore / package.json
 *   / tsconfig.json / electron-builder.yml / electron.vite.config.ts
 *   / vitest.config.ts / pnpm-lock.yaml / pnpm-workspace.yaml
 *   / LICENSE / RELEASE.md
 *
 * 不备份（可再生 / 巨大 / 含用户数据）：
 *   node_modules/  装一下就有（且几百 MB）
 *   out/ dist/     构建产物，重新 build 就有
 *   data/ data-test/  **用户数据与测试残留，绝不能进备份**
 *   release-staging/ _archive/  历史产物，几百 MB
 *   *.log          运行日志
 *
 * 附一份 MANIFEST：文件清单 + 每个文件的 sha256。
 * 那是回退时的"验收依据" —— 恢复后能逐个核对有没有丢文件/被改动。
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const ROOT = path.join(__dirname, '..')
const STAMP = process.argv[2] || 'v0.2.0'
const DEST = path.join(ROOT, '..', `AstriaX-source-${STAMP}`)

/* ══ 要备份的目录 ══ */
const DIRS = ['src', 'tests', 'scripts', 'build', 'docs']

/* ══ 要备份的根目录文件 ══ */
const FILES = [
  '.gitignore',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'electron-builder.yml',
  'electron.vite.config.ts',
  'vitest.config.ts',
  'LICENSE',
  'RELEASE.md'
]

/* ══ 明确排除（防止以后有人在上面加目录时漏掉） ══ */
const EXCLUDE_DIRS = new Set([
  'node_modules',
  'out',
  'dist',
  'data',
  'data-test',
  'release-staging',
  '_archive',
  '.git',
  'dumps',
  'logs-export'
])

const manifest = []
let copied = 0
let bytes = 0

function copyOne(srcRel) {
  const abs = path.join(ROOT, srcRel)
  if (!fs.existsSync(abs)) return
  const stat = fs.statSync(abs)
  if (stat.isDirectory()) return

  const dest = path.join(DEST, srcRel)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(abs, dest)

  const buf = fs.readFileSync(abs)
  manifest.push({
    path: srcRel.split(path.sep).join('/'),
    size: buf.length,
    sha256: crypto.createHash('sha256').update(buf).digest('hex')
  })
  copied++
  bytes += buf.length
}

console.log('=== 备份 AstriaX 源码快照 ===\n')
console.log('  源目录:', ROOT)
console.log('  目标  :', DEST, '\n')

/* 目录递归（跳过排除项与 log） */
function walk(rel) {
  const abs = path.join(ROOT, rel)
  let entries
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue
    if (EXCLUDE_DIRS.has(e.name)) continue
    if (/\.log$/i.test(e.name)) continue
    const child = path.join(rel, e.name)
    if (e.isDirectory()) walk(child)
    else copyOne(child)
  }
}

for (const d of DIRS) {
  if (fs.existsSync(path.join(ROOT, d))) {
    walk(d)
    process.stdout.write(`  ✓ ${d}\n`)
  }
}

for (const f of FILES) {
  if (fs.existsSync(path.join(ROOT, f))) {
    copyOne(f)
    process.stdout.write(`  ✓ ${f}\n`)
  }
}

/* ══ 写清单 ══ */
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const meta = {
  stamp: STAMP,
  version: pkg.version,
  productName: pkg.productName ?? 'AstriaX',
  appId: pkg.build?.appId ?? 'mx.launcher',
  createdAt: new Date().toISOString(),
  gitHead: (() => {
    try {
      return require('child_process')
        .execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' })
        .trim()
    } catch {
      return '(unknown)'
    }
  })(),
  note:
    '0.2.0 完整源码快照（独立于 git）。0.2 周期有 275 个文件未提交，' +
    '所以 tag/提交点都不足以回退，这个快照才是真正的保险。',
  fileCount: copied,
  totalBytes: bytes,
  excluded: [...EXCLUDE_DIRS].concat(['*.log']),
  files: manifest.sort((a, b) => a.path.localeCompare(b.path))
}

fs.writeFileSync(
  path.join(DEST, 'MANIFEST.json'),
  JSON.stringify(meta, null, 2),
  'utf8'
)

/* ══ 写一份人读的 README ══ */
fs.writeFileSync(
  path.join(DEST, 'README-回退说明.md'),
  `# AstriaX ${STAMP} 源码快照

**用途**：0.3 开发期间的回退保险。

## 为什么有它

0.2 周期累计 **275 个文件未提交**（\`git status\` 可见），也就是说
0.2 的绝大部分改动**不在任何 git 提交里**。给 0.2 打 tag 只能记下
一个提交点，靠它回退会丢掉整个 0.2 的工作。

所以这份快照是**独立于 git 的**：即使之后 git 被 reset / checkout /
误删，这个目录仍然完好。

## 怎么回退

\`\`\`powershell
# 1. 先把当前（0.3 开发中）的工作区整个挪走，别混在一起
Move-Item E:\\MX\\launcher-acb E:\\MX\\launcher-acb-inprogress

# 2. 把快照复制回项目位置
Copy-Item -Recurse "E:\\MX\\AstriaX-source-${STAMP}\\*" "E:\\MX\\launcher-acb\\"

# 3. 装依赖（快照里没有 node_modules）
cd E:\\MX\\launcher-acb
pnpm install
\`\`\`

## 核对有没有恢复对

快照里有 \`MANIFEST.json\`，列出**每个文件的 sha256**。
恢复后可以逐个核对：

\`\`\`powershell
cd E:\\MX\\launcher-acb
node -e "const m=require('./MANIFEST.json');console.log('应有',m.fileCount,'个文件')"
\`\`\`

（本快照不含 \`MANIFEST.json\` 自身。）

## 快照里没有什么（以及为什么）

| 排除项 | 原因 |
|---|---|
| \`node_modules/\` | 可用 \`pnpm install\` 重建，且体积大 |
| \`out/\` \`dist/\` | 构建产物，\`npm run build\` 就有 |
| \`data/\` | **用户数据**——绝不该混进源码备份 |
| \`data-test/\` | 测试残留（临时目录），可再生 |
| \`release-staging/\` \`_archive/\` | 历史构建产物，几百 MB |
| \`*.log\` | 运行日志 |

## 版本信息

- 版本：${pkg.version}
- git HEAD（仅供参考，快照本身不依赖它）：${meta.gitHead}
- 备份时间：${meta.createdAt}
- 文件数：${copied}，总计 ${(bytes / 1024 / 1024).toFixed(1)} MB
`,
  'utf8'
)

console.log(`\n=== 完成 ===`)
console.log(`  文件数 : ${copied}`)
console.log(`  总大小 : ${(bytes / 1024 / 1024).toFixed(2)} MB`)
console.log(`  清单   : ${path.join(DEST, 'MANIFEST.json')}`)
console.log(`  说明   : ${path.join(DEST, 'README-回退说明.md')}`)
console.log(`  版本   : ${pkg.version}  (git HEAD ${meta.gitHead})`)