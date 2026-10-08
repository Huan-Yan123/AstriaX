#!/usr/bin/env node
/*
 * 本地备份：成品文件夹 + 源码，各留多份时间戳快照。
 * ============================================================================
 *
 * 用户要求「本地可以多做点备份，成品和源码」。
 *
 * ## 为什么不用 PowerShell 的 Copy-Item / Compress-Archive
 *
 *   - Copy-Item 对几千个小文件（node_modules、src）**慢得离谱**，
 *     而且遇到长路径会直接失败。
 *   - Compress-Archive 实测比 tar 慢 29 倍（之前专门量过：2560ms vs 89ms），
 *     而且它在失败时可能留下半截 zip。
 *
 * 所以：
 *   - **目录树复制**用 robocopy（Windows 原生、多线程、扛长路径、
 *     退出码 0-7 都算成功，>=8 才是真失败 —— 这点最容易写错）。
 *   - **压缩归档**用系统 tar.exe（和安装器里用的是同一个）。
 *
 * ## 备份什么、不备份什么
 *
 *   成品：整个「E:\MX机器人启动器成品」—— 安装包 + 清单 + 报告，全要。
 *   源码：整个工程，但排除
 *           node_modules（几百 MB，可 pnpm i 还原）
 *           dist / out  （构建产物，可重新构建）
 *           data        （运行时缓存/临时目录，包含 tmp 垃圾）
 *           .git        （体积大且不是"源码备份"的必要部分）
 *         这样源码备份只有几 MB，可以留很多份。
 *
 * ## 为什么要同时留"目录副本"和"tar.gz"
 *
 *   目录副本 = 想拿哪个文件直接拿，最快。
 *   tar.gz   = 单一文件，不怕误删零散文件、便于整体搬走。
 *   两者都要，代价只是几百 MB，而 E: 盘有 900+ GB。
 *
 * 用法:
 *   node scripts/backup-local.cjs                 # 备份成品 + 源码
 *   node scripts/backup-local.cjs --only=src      # 只备份源码
 *   node scripts/backup-local.cjs --only=dist     # 只备份成品
 *   node scripts/backup-local.cjs --keep=15       # 每类保留 15 份（默认 10）
 *   node scripts/backup-local.cjs --list          # 只列出已有备份
 */
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.join(__dirname, '..')

/** 成品文件夹（用户口中的"老地方"） */
const DIST_SRC = 'E:\\MX机器人启动器成品'
/** 源码 = 本仓库 */
const SRC_SRC = ROOT
/** 备份根目录 */
const BACKUP_ROOT = 'E:\\MX-Backups'

const args = process.argv.slice(2)
const only = (/--only=([a-z,]+)/.exec(args.join(' ')) || [])[1]
const keepN = Number((/--keep=(\d+)/.exec(args.join(' ')) || [])[1] || 10)
const listOnly = args.includes('--list')

/** 本地时间戳 YYYYMMDD-HHMMSS */
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  )
}

function human(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB'
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB'
  return (bytes / 1073741824).toFixed(2) + ' GB'
}

/** 递归算目录大小 + 文件数（跳过符号链接，避免绕圈） */
function dirStats(dir) {
  let bytes = 0
  let files = 0
  const walk = (d) => {
    let ents
    try {
      ents = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      const p = path.join(d, e.name)
      try {
        if (e.isSymbolicLink()) continue
        if (e.isDirectory()) walk(p)
        else if (e.isFile()) {
          bytes += fs.statSync(p).size
          files++
        }
      } catch {
        /* 读不到就跳过，备份不该因为一个文件失败 */
      }
    }
  }
  walk(dir)
  return { bytes, files }
}

/** robocopy：目录树复制。注意退出码语义！ */
function robocopy(from, to, excludes = []) {
  fs.mkdirSync(to, { recursive: true })
  // /E  含空目录   /NFL /NDL /NJH /NJS /NP  静音   /R:1 /W:1 少重试
  const cmd = [
    from,
    to,
    '/E',
    '/NFL',
    '/NDL',
    '/NJH',
    '/NJS',
    '/NP',
    '/R:1',
    '/W:1',
    ...excludes.flatMap((x) => ['/XD', x])
  ]
  const r = spawnSync('robocopy', cmd, { encoding: 'utf8', timeout: 60 * 60 * 1000 })
  /*
   * ★ robocopy 的退出码是**位掩码**，不是常规的 0=成功：
   *     0 = 没有文件需要复制
   *     1 = 成功复制了文件
   *     2 = 有额外文件/目录
   *     4 = 有文件不匹配
   *     8 = ★失败（有文件复制不了）
   *    16 = 严重错误（没有权限/路径无效）
   *   所以 "退出码不为 0 就是失败" 是错的，会把成功的备份判成失败。
   *   正确判据是 **>= 8**。
   */
  const code = r.status === null ? 16 : r.status
  return { ok: code < 8, code, tail: (r.stdout || '').trim().split('\n').slice(-2).join(' | ') }
}

/** tar 打包（用系统 tar.exe，安装器里同一份实现） */
function targz(srcDir, outFile, excludes = []) {
  const tar = [
    'C:\\Windows\\System32\\tar.exe',
    'C:\\Windows\\Sysnative\\tar.exe',
    'C:\\Windows\\SysWOW64\\tar.exe'
  ].find((p) => fs.existsSync(p))
  if (!tar) return { ok: false, code: -1, msg: '找不到 tar.exe' }

  const listFile = outFile + '.list.txt'
  fs.writeFileSync(listFile, excludes.join('\r\n') + '\r\n', 'utf8')

  const r = spawnSync(
    tar,
    ['-czf', outFile, '-C', path.dirname(srcDir), '--exclude-from', listFile, path.basename(srcDir)],
    { encoding: 'utf8', timeout: 60 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 }
  )
  try {
    fs.unlinkSync(listFile)
  } catch {}
  const ok = r.status === 0 && fs.existsSync(outFile) && fs.statSync(outFile).size > 0
  return { ok, code: r.status, msg: (r.stderr || '').trim().split('\n').slice(-1)[0] || '' }
}

/** 保留最近 keepN 份，删更早的 */
function prune(dir, keepN) {
  if (!fs.existsSync(dir)) return []
  const items = fs
    .readdirSync(dir)
    .filter((n) => /^\d{8}-\d{6}$/.test(n))
    .sort() // 时间戳格式天然按字典序=时间序
  const removed = []
  while (items.length > keepN) {
    const old = items.shift()
    try {
      fs.rmSync(path.join(dir, old), { recursive: true, force: true })
      removed.push(old)
    } catch {}
  }
  return removed
}

function listBackups() {
  console.log('')
  console.log('  已有备份（根目录 ' + BACKUP_ROOT + '）')
  console.log('  ' + '='.repeat(66))
  for (const [label, sub] of [
    ['成品', '成品'],
    ['源码', '源码']
  ]) {
    const dir = path.join(BACKUP_ROOT, sub)
    console.log('')
    console.log('  【' + label + '】 ' + dir)
    if (!fs.existsSync(dir)) {
      console.log('    (还没有备份)')
      continue
    }
    const items = fs.readdirSync(dir).filter((n) => /^\d{8}-\d{6}$/.test(n)).sort()
    if (items.length === 0) {
      console.log('    (还没有备份)')
      continue
    }
    for (const it of items) {
      const full = path.join(dir, it)
      const st = dirStats(full)
      const when = `${it.slice(0, 4)}-${it.slice(4, 6)}-${it.slice(6, 8)} ${it.slice(9, 11)}:${it.slice(11, 13)}`
      console.log(`    ${when}   ${human(st.bytes).padStart(10)}   ${String(st.files).padStart(6)} 个文件`)
    }
    console.log('    共 ' + items.length + ' 份')
  }
  console.log('')
}

function main() {
  if (listOnly) {
    listBackups()
    return
  }

  const doDist = !only || only.includes('dist') || only.includes('成品')
  const doSrc = !only || only.includes('src') || only.includes('源码')
  const s = stamp()

  console.log('')
  console.log('  本地备份')
  console.log('  ' + '='.repeat(66))
  console.log('  时间戳 : ' + s)
  console.log('  保留   : 每类最近 ' + keepN + ' 份')
  console.log('')

  const manifest = { stamp: s, at: new Date().toISOString(), entries: [] }

  /* ---------- 成品 ---------- */
  if (doDist) {
    if (!fs.existsSync(DIST_SRC)) {
      console.log('  [跳过] 成品文件夹不存在：' + DIST_SRC)
    } else {
      const destDir = path.join(BACKUP_ROOT, '成品', s)
      console.log('  【成品】' + DIST_SRC)
      const r = robocopy(DIST_SRC, destDir)
      const st = dirStats(destDir)
      console.log(
        '    复制: ' + (r.ok ? 'OK' : '失败') + '  (robocopy 退出码 ' + r.code + ')' +
          '  ' + human(st.bytes) + ' / ' + st.files + ' 个文件'
      )
      if (!r.ok) process.exitCode = 1

      // 再打一个 tar.gz，作为"单一文件"备份
      const tg = path.join(BACKUP_ROOT, '成品', s + '.tar.gz')
      const t = targz(DIST_SRC, tg)
      console.log('    归档: ' + (t.ok ? 'OK  ' + human(fs.statSync(tg).size) : '失败 ' + t.msg))
      if (!t.ok) process.exitCode = 1

      const removed = prune(path.join(BACKUP_ROOT, '成品'), keepN)
      const removedTgz = pruneTgz(path.join(BACKUP_ROOT, '成品'), keepN)
      if (removed.length || removedTgz.length)
        console.log('    清理旧份: ' + [...removed, ...removedTgz].join(', '))

      manifest.entries.push({
        kind: '成品',
        from: DIST_SRC,
        to: destDir,
        archive: tg,
        bytes: st.bytes,
        files: st.files
      })
      console.log('')
    }
  }

  /* ---------- 源码 ---------- */
  if (doSrc) {
    const destDir = path.join(BACKUP_ROOT, '源码', s, 'launcher-acb')
    console.log('  【源码】' + SRC_SRC)
    const excludes = [
      path.join(SRC_SRC, 'node_modules'),
      path.join(SRC_SRC, 'dist'),
      path.join(SRC_SRC, 'out'),
      path.join(SRC_SRC, 'data'),
      path.join(SRC_SRC, '.git'),
      path.join(SRC_SRC, '_audit_tmp')
    ]
    const r = robocopy(SRC_SRC, destDir, excludes)
    const st = dirStats(destDir)
    console.log(
      '    复制: ' + (r.ok ? 'OK' : '失败') + '  (robocopy 退出码 ' + r.code + ')' +
        '  ' + human(st.bytes) + ' / ' + st.files + ' 个文件'
    )
    if (!r.ok) process.exitCode = 1

    const tg = path.join(BACKUP_ROOT, '源码', s + '.tar.gz')
    const t = targz(SRC_SRC, tg, [
      'node_modules',
      'dist',
      'out',
      'data',
      '_audit_tmp',
      '.git',
      '*.tar.gz'
    ])
    console.log('    归档: ' + (t.ok ? 'OK  ' + human(fs.statSync(tg).size) : '失败 ' + t.msg))
    if (!t.ok) process.exitCode = 1

    const removed = prune(path.join(BACKUP_ROOT, '源码'), keepN)
    const removedTgz = pruneTgz(path.join(BACKUP_ROOT, '源码'), keepN)
    if (removed.length || removedTgz.length)
      console.log('    清理旧份: ' + [...removed, ...removedTgz].join(', '))

    manifest.entries.push({
      kind: '源码',
      from: SRC_SRC,
      to: destDir,
      archive: tg,
      bytes: st.bytes,
      files: st.files,
      excludes: ['node_modules', 'dist', 'out', 'data', '.git', '_audit_tmp']
    })
    console.log('')
  }

  // manifest 追加（保留历史，便于以后查"哪次备份了哪个版本"）
  const mf = path.join(BACKUP_ROOT, 'backups.json')
  let all = []
  try {
    all = JSON.parse(fs.readFileSync(mf, 'utf8'))
    if (!Array.isArray(all)) all = []
  } catch {}
  all.push(manifest)
  fs.mkdirSync(BACKUP_ROOT, { recursive: true })
  fs.writeFileSync(mf, JSON.stringify(all, null, 2), 'utf8')

  console.log('  ' + '='.repeat(66))
  console.log('  ' + (process.exitCode ? '[!!] 有步骤失败' : '[OK] 备份完成'))
  console.log('  清单: ' + mf)
  console.log('')
}

/** tar.gz 也按时间戳保留 keepN 份 */
function pruneTgz(dir, keepN) {
  if (!fs.existsSync(dir)) return []
  const items = fs
    .readdirSync(dir)
    .filter((n) => /^\d{8}-\d{6}\.tar\.gz$/.test(n))
    .sort()
  const removed = []
  while (items.length > keepN) {
    const old = items.shift()
    try {
      fs.unlinkSync(path.join(dir, old))
      removed.push(old)
    } catch {}
  }
  return removed
}

main()
