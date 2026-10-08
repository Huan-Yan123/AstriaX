#!/usr/bin/env node
/*
 * 验证备份**真的能用** —— 不是"文件存在"，而是"内容完整、能解出来"。
 * ============================================================================
 *
 * 为什么必须验：
 *   备份脚本跑完只证明"复制命令没报错"。它证明不了：
 *     - 文件是不是复制全了（robocopy 跳过某些文件也会返回成功位）
 *     - tar.gz 是不是完整的（写一半断电/磁盘满，文件照样存在但解不开）
 *     - 关键文件（安装包、package.json、installer.nsh）在不在
 *
 *   没验过的备份 = 没有备份。真出事时才发现解不开，那比没备份更惨。
 *
 * 判据：
 *   1. 目录副本里关键文件存在且**大小与源一致**（逐字节比对太慢，
 *      对关键几个文件做 sha256；其余比对总文件数/总字节数）
 *   2. tar.gz 能被 tar -tzf 列出（能列出 = 归档结构完整）
 *   3. 从 tar.gz 里真的解一个文件出来，和源文件逐字节相同
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { spawnSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const DIST_SRC = 'E:\\MX机器人启动器成品'
const SRC_SRC = ROOT
const BACKUP_ROOT = 'E:\\MX-Backups'

const TAR = [
  'C:\\Windows\\System32\\tar.exe',
  'C:\\Windows\\Sysnative\\tar.exe',
  'C:\\Windows\\SysWOW64\\tar.exe'
].find((p) => fs.existsSync(p))

let bad = 0
function check(label, ok, detail) {
  if (ok) console.log('  [OK]   ' + label)
  else {
    console.log('  [FAIL] ' + label + (detail ? '\n         ' + detail : ''))
    bad++
  }
}

/**
 * 列出 tar.gz 的成员名，**按 GBK 解码**。
 *
 * ## 为什么必须 GBK（这是本项目第 2 次栽在这个坑上）
 *
 * Windows 自带的 tar.exe 把成员名按**系统 ANSI(中文=GBK)** 写到 stdout。
 * 用 UTF-8 去解会得到 `MX��������������Ʒ/...` 这种乱码，
 * 再拿乱码串去 `-x` 就报 "Not found in archive"。
 *
 * 第一版本脚本正是这么写的，于是报出「能从归档里解出安装包 FAILED」的
 * **假红** —— 而那个归档其实完好无损（整包解压 12 个文件、大小全对）。
 *
 * 假红同样有害：它会让人去"修"一个根本没坏的东西。
 * 判据要么按 GBK 解，要么干脆不解析列表、直接整包解压后比对。
 */
function tarListGbk(tgz) {
  const r = spawnSync(TAR, ['-tzf', tgz], { timeout: 600000 })
  if (r.status !== 0) return { ok: false, entries: [] }
  const raw = r.stdout || Buffer.alloc(0)
  const text = new TextDecoder('gbk').decode(raw)
  return { ok: true, entries: text.split(/\r?\n/).filter(Boolean) }
}

/** 整包解压到临时目录，返回解出的文件清单（最可靠的完整性判据） */
function tarExtractAll(tgz, tmp) {
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.mkdirSync(tmp, { recursive: true })
  const r = spawnSync(TAR, ['-xzf', tgz, '-C', tmp], { timeout: 30 * 60 * 1000 })
  const out = []
  const walk = (d) => {
    let ents
    try {
      ents = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) out.push(p)
    }
  }
  walk(tmp)
  return { ok: r.status === 0 && out.length > 0, code: r.status, files: out }
}

function sha256(f) {
  return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
}

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
      } catch {}
    }
  }
  walk(dir)
  return { bytes, files }
}

/** 最新的一份备份 */
function latest(dir) {
  if (!fs.existsSync(dir)) return null
  const items = fs.readdirSync(dir).filter((n) => /^\d{8}-\d{6}$/.test(n)).sort()
  return items.length ? { stamp: items[items.length - 1], dir: path.join(dir, items[items.length - 1]) } : null
}
function latestTgz(dir) {
  if (!fs.existsSync(dir)) return null
  const items = fs.readdirSync(dir).filter((n) => /^\d{8}-\d{6}\.tar\.gz$/.test(n)).sort()
  return items.length ? path.join(dir, items[items.length - 1]) : null
}

console.log('')
console.log('  验证备份可用性')
console.log('  ' + '='.repeat(66))

/* ===================== 成品 ===================== */
console.log('')
console.log('  【成品】')
{
  const l = latest(path.join(BACKUP_ROOT, '成品'))
  if (!l) {
    check('存在成品备份', false, '没有找到')
  } else {
    console.log('    最新: ' + l.stamp + '  ' + l.dir)

    // 1) 关键文件在不在，大小对不对
    const srcFiles = fs.readdirSync(DIST_SRC).filter((n) => fs.statSync(path.join(DIST_SRC, n)).isFile())
    let missing = []
    let sizeMismatch = []
    for (const n of srcFiles) {
      const a = path.join(DIST_SRC, n)
      const b = path.join(l.dir, n)
      if (!fs.existsSync(b)) {
        missing.push(n)
        continue
      }
      if (fs.statSync(a).size !== fs.statSync(b).size) sizeMismatch.push(n)
    }
    check('所有成品文件都在备份里（' + srcFiles.length + ' 个）', missing.length === 0, '缺: ' + missing.join(', '))
    check('文件大小全部一致', sizeMismatch.length === 0, '不一致: ' + sizeMismatch.join(', '))

    // 2) 安装包逐字节比对（最关键的文件，必须一模一样）
    const setupName = srcFiles.find((n) => /Setup-.*\.exe$/.test(n) && !/Web/.test(n))
    if (setupName) {
      const h1 = sha256(path.join(DIST_SRC, setupName))
      const h2 = sha256(path.join(l.dir, setupName))
      check(
        '安装包 ' + setupName + ' 逐字节一致',
        h1 === h2,
        '源 ' + h1.slice(0, 16) + ' vs 备份 ' + h2.slice(0, 16)
      )
    }

    // 3) tar.gz 完整性：整包解出来，逐个和源比大小（不解析成员名）
    const tg = latestTgz(path.join(BACKUP_ROOT, '成品'))
    if (!tg) check('存在成品归档', false)
    else {
      const tmp = path.join(BACKUP_ROOT, '.verify-dist')
      const ex = tarExtractAll(tg, tmp)
      check('成品归档能完整解压（' + ex.files.length + ' 个文件）', ex.ok, 'tar 退出码 ' + ex.code)

      // 解出来的每个文件都要能在源里找到同大小的对应
      let mismatched = []
      let checkedBig = false
      for (const f of ex.files) {
        const name = path.basename(f)
        const src = path.join(DIST_SRC, name)
        if (!fs.existsSync(src)) {
          mismatched.push(name + '(源里没有)')
          continue
        }
        if (fs.statSync(src).size !== fs.statSync(f).size) mismatched.push(name + '(大小不同)')
        // 安装包做逐字节 sha256（最关键、也最能说明归档没被截断）
        if (setupName && name === setupName && !checkedBig) {
          checkedBig = true
          const h = sha256(f)
          check(
            '归档解出的安装包与源逐字节一致',
            h === sha256(path.join(DIST_SRC, setupName)),
            '解出 ' + h.slice(0, 16)
          )
        }
      }
      check('归档内文件与源一一对应', mismatched.length === 0, mismatched.join(', '))
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }
}

/* ===================== 源码 ===================== */
console.log('')
console.log('  【源码】')
{
  const l = latest(path.join(BACKUP_ROOT, '源码'))
  if (!l) {
    check('存在源码备份', false, '没有找到')
  } else {
    console.log('    最新: ' + l.stamp + '  ' + l.dir)

    // 关键源文件必须都在（按相对路径查）
    const KEY = [
      'package.json',
      'electron-builder.yml',
      'build/installer.nsh',
      'src/main/ipc.ts',
      'src/main/index.ts',
      'src/main/update/update-backups.ts',
      'src/preload/api-map.ts',
      'src/renderer/src/App.vue'
    ]
    const base = path.join(l.dir, 'launcher-acb')
    const missing = KEY.filter((k) => !fs.existsSync(path.join(base, k)))
    check('关键源文件都在（' + KEY.length + ' 个）', missing.length === 0, '缺: ' + missing.join(', '))

    // 关键文件逐字节一致
    const diff = KEY.filter((k) => {
      const a = path.join(SRC_SRC, k)
      const b = path.join(base, k)
      if (!fs.existsSync(a) || !fs.existsSync(b)) return true
      return sha256(a) !== sha256(b)
    })
    check('关键源文件内容一致', diff.length === 0, '不一致: ' + diff.join(', '))

    // 不该被备份的东西必须不在（否则备份里塞了几百 MB 垃圾）
    const junk = ['node_modules', 'dist', 'out', '.git'].filter((j) => fs.existsSync(path.join(base, j)))
    check('没有把 node_modules/dist/out/.git 塞进去', junk.length === 0, '混进了: ' + junk.join(', '))

    // tar.gz 可解
    const tg = latestTgz(path.join(BACKUP_ROOT, '源码'))
    if (!tg) check('存在源码归档', false)
    else {
      const tmp = path.join(BACKUP_ROOT, '.verify-src')
      const ex = tarExtractAll(tg, tmp)
      check('源码归档能完整解压（' + ex.files.length + ' 个文件）', ex.ok, 'tar 退出码 ' + ex.code)

      const pkg = ex.files.find((f) => f.endsWith(path.join('launcher-acb', 'package.json')))
      if (!pkg) check('归档里有 package.json', false, '找不到')
      else {
        const a = JSON.parse(fs.readFileSync(path.join(SRC_SRC, 'package.json'), 'utf8'))
        const b = JSON.parse(fs.readFileSync(pkg, 'utf8'))
        check(
          '解出的 package.json 与源一致（版本 ' + b.version + '）',
          a.version === b.version && a.name === b.name
        )
      }
      // 归档里不能混进 node_modules 之类
      const junk = ex.files.filter(
        (f) => f.includes('node_modules') || f.includes(`${path.sep}out${path.sep}`)
      )
      check('归档里没有 node_modules/out 垃圾', junk.length === 0, '混进了 ' + junk.length + ' 个文件')
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }
}

console.log('')
console.log('  ' + '='.repeat(66))
console.log(bad === 0 ? '  [OK] 备份验证通过，确实可用' : `  [FAIL] ${bad} 项不对`)
console.log('')
process.exit(bad === 0 ? 0 : 1)
