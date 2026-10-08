#!/usr/bin/env node
/*
 * 尺子：验证 CASE 4c 真能抓到"注册表指向别处时数据被删"那个 bug。
 *
 * 做法：把 `customUnInit` 改回**只看注册表**的老逻辑，
 * 跑 e2e，看 CASE 4c 是否变红。
 *
 * 这条尺子特别重要，因为 CASE 4c 守的是主人真实踩过的事故
 *（选「保留数据」卸载，`<安装目录>\data` 却被删）。
 * 如果撤回修复它不红，那这条用例就是摆设。
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const NSH = path.join(ROOT, 'build', 'installer.nsh')

/** 把"① 绝对优先抢救 $INSTDIR\data"那一段停掉（等价于老逻辑） */
function breakFix(src) {
  /*
   * ★ 必须精确定位到 `customUnInit` **里面**那一处。
   *
   * 踩过的坑：第一版用 `indexOf('${If} ${FileExists} "$INSTDIR\\data\\*.*"')`
   * 直接找，命中的却是**第 491 行 `MXBOT_UPDATE_BACKUP` 里**那处
   * （更新前打备份用的，逻辑完全不同）—— 于是尺子改了个无关的地方，
   * 测试照样全绿，得出**错误的结论**"CASE 4c 是摆设"。
   *
   * 所以先定位到 `!macro customUnInit`，再从它往后找第一个锚点。
   */
  const macroAt = src.indexOf('!macro customUnInit')
  if (macroAt < 0) return null
  const marker = '${If} ${FileExists} "$INSTDIR\\data\\*.*"'
  const rel = src.indexOf(marker, macroAt)
  if (rel < 0) return null
  /* 改成恒假：不再无条件抢救安装目录下的 data（= 老逻辑的效果） */
  return src.slice(0, rel) + '${If} "1" == "2"' + src.slice(rel + marker.length)
}

function runE2e() {
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'test-installer-e2e.cjs')], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 20 * 60 * 1000
    })
    return { failed: false, out }
  } catch (e) {
    return { failed: true, out: String(e.stdout ?? '') + String(e.stderr ?? '') }
  }
}

const bak = NSH + '.ruler-bak'
const orig = fs.readFileSync(NSH, 'utf8')
const broken = breakFix(orig)

if (!broken) {
  console.error('[FAIL] 找不到要撤回的那段（锚点失效）')
  process.exit(1)
}

let result
try {
  fs.copyFileSync(NSH, bak)
  fs.writeFileSync(NSH, broken, 'utf8')
  console.log('已把 customUnInit 改回"只看注册表"的老逻辑，跑 e2e…\n')
  result = runE2e()
} finally {
  fs.copyFileSync(bak, NSH)
  fs.unlinkSync(bak)
  console.log('\n文件已还原')
}

/* CASE 4c 那条应当报红，且指名"被删了" */
const caught =
  result.failed &&
  /注册表指向别处时，这些被删了/.test(result.out) &&
  /安装目录下的 data 被完整保住了/.test(result.out)

console.log(
  caught
    ? '✔ 尺子通过：撤回修复后 CASE 4c 立刻红，并指名"被删了" —— 它真的守得住这个事故'
    : `✘ 尺子失败：没抓到（failed=${result.failed}）—— CASE 4c 是摆设`
)

if (!caught) {
  /*
   * 尺子失败时把 CASE 4c 附近的输出**原样打出来** ——
   * 否则只能看到"没抓到"，看不出"为什么没抓到"。
   */
  const lines = result.out.split('\n')
  const i = lines.findIndex((l) => l.includes('[4c]'))
  console.log('\n--- CASE 4c 的实际输出（撤回修复后）---')
  for (const l of lines.slice(Math.max(0, i - 2), i + 12)) console.log('   ' + l.trim())
  console.log('--- 全部 ✘ 行 ---')
  for (const l of lines.filter((l) => l.includes('✘')).slice(0, 8)) console.log('   ' + l.trim())
}

process.exit(caught ? 0 : 1)
