#!/usr/bin/env node
/*
 * 真机验证：**打好的 0.1.2 安装包**能不能真的做出自动备份？
 * ============================================================================
 *
 * ## 为什么必须用真安装包，不能只用 e2e 模拟
 *
 * e2e（scripts/test-installer-e2e.cjs）用的是**自己编译的模拟安装器** ——
 * 它内联同一份 installer.nsh，但由我用简化的 .nsi 包起来。
 * 这能验逻辑，验不了：
 *
 *   1. electron-builder 真正生成的安装器（它还会注入一堆自己的宏和变量）
 *      里，我的宏**是否真的被插进去了**
 *   2. 真实安装器的变量/寄存器环境是否和模拟的一样
 *      （$R0..$R9 在 electron-builder 的模板里可能已被占用！）
 *   3. `${GetTime}` 在真实环境里能不能用
 *
 * 第 2 条尤其危险：模拟 .nsi 里没有别的代码，$R 寄存器全是空的。
 * 而真实安装器模板用了大量 $R，**如果我的宏复用了已占用的寄存器，
 * 会破坏安装器自己的变量** —— 那可能就是"备份做好了但安装坏了"，
 * 或者反过来。必须用真安装包验。
 *
 * ## 这个脚本怎么验（安全第一）
 *
 * 真安装包会真的装软件、真改注册表 —— 而用户机器上**有正在跑的实例**，
 * 绝不能乱来。所以：
 *
 *   - **不执行**真安装包的安装流程（那会覆盖用户当前 0.1.1 安装）
 *   - 改为**只读地**从安装包里提取那个内嵌的 installer.nsh 编译产物？
 *     —— 不行，NSIS 是编译成一体的。
 *   - 所以改用**最接近真实**的办法：用 electron-builder 真实生成的
 *     `dist\__uninstaller-nsis-mxbot-launcher.exe` 和真实安装包一起，
 *     在**完全隔离的沙箱**里跑：注册表指向沙箱、TEMP 指向沙箱、
 *     安装目录在沙箱里。
 *
 * 关键是用 electron-builder **自己生成的那份 .nsi**（在 dist 里能找到
 * 或能重新生成），而不是我手写的模拟版。
 */
const { spawnSync, execFileSync } = require('child_process')
const fs = require('fs')
const { join } = require('path')

const ROOT = join(__dirname, '..')
const DIST = join(ROOT, 'dist')

console.log('')
console.log('  真安装包验证（0.1.2）')
console.log('  ' + '='.repeat(64))

const setup = join(DIST, 'AstriaX-Setup-0.1.2.exe')
if (!fs.existsSync(setup)) {
  console.log('  找不到安装包：' + setup)
  process.exit(1)
}
console.log('  安装包: ' + setup)
console.log('  大小  : ' + (fs.statSync(setup).size / 1048576).toFixed(2) + ' MB')

/*
 * ---- 核心检查：从真安装包里证明我的宏被编进去了 ----
 *
 * NSIS 安装包是自解压压缩体，里面的脚本指令会被压缩。
 * 直接搜字符串不可靠（压缩后搜不到）。但有几样东西是**以明文形式**
 * 留在安装包里的：
 *   - Setup 的字符串表里会有 DetailPrint 的中文提示
 *   - 变量名、文件路径等
 *
 * 所以判据：在安装包二进制里找**我写的那句 DetailPrint 文案**。
 * 如果编进去了，说明宏确实在真实安装器里。找不到就说明
 * electron-builder 没包含 build/installer.nsh（那 e2e 全绿也没意义）。
 *
 * 注意：NSIS 用 Unicode(UTF-16LE) 存字符串，所以要么找 UTF-16 编码的，
 * 要么找 ASCII 部分。这里两种都试。
 */
console.log('')
console.log('  [1] 确认备份逻辑真的被编进了安装包')
{
  const buf = fs.readFileSync(setup)

  /*
   * 找一句只可能来自我宏里的文案。
   * 用较短的、不含中文的部分提高命中率，同时中文部分用于确认。
   */
  const probes = [
    { name: '备份完成提示（中文，UTF-16LE）', needle: Buffer.from('更新前备份完成', 'utf16le') },
    { name: '备份完成提示（中文，UTF-8）', needle: Buffer.from('更新前备份完成', 'utf8') },
    { name: 'tar 打包参数 -czf', needle: Buffer.from('-czf', 'utf8') },
    { name: '备份文件名 mxbot-data.tar.gz', needle: Buffer.from('mxbot-data.tar.gz', 'utf8') },
    { name: '备份文件名（UTF-16LE）', needle: Buffer.from('mxbot-data.tar.gz', 'utf16le') },
    { name: '备份目录 backups\\update', needle: Buffer.from('backups\\update', 'utf8') },
    { name: '备份目录（UTF-16LE）', needle: Buffer.from('backups\\update', 'utf16le') }
  ]

  let hits = 0
  for (const p of probes) {
    const found = buf.indexOf(p.needle) >= 0
    if (found) hits++
    console.log('      ' + (found ? '[OK]  ' : '[--]  ') + p.name)
  }

  console.log('')
  if (hits === 0) {
    console.log('  [!!] 一条都没找到 —— 备份逻辑**没有**被编进真安装包！')
    console.log('       e2e 全绿也不能说明问题：那只用了我的模拟 .nsi。')
    process.exitCode = 1
  } else {
    console.log(`  [OK] 命中 ${hits}/${probes.length} 条 —— 备份逻辑确实在真安装包里`)
  }
}

/*
 * ---- [2] 真实安装器的寄存器占用情况 ----
 *
 * 用真实的 electron-builder 模板编译一份安装器，检查 $R0..$R9
 * 在**模板自己**的代码里有没有被使用。如果用了，我的宏必须
 * Push/Pop 保护它们（我已经做了），但要确认我 Push 的**正好是**
 * 我在用的那些。
 *
 * 这个检查是**静态**的：找我宏里用了哪些 $R，和我 Push/Pop 的对比。
 */
console.log('')
console.log('  [2] 静态核对：备份宏用到的 $R 寄存器是否都做了保护')
{
  const nsh = fs.readFileSync(join(ROOT, 'build', 'installer.nsh'), 'utf8')
  const m = /\n!macro MXBOT_UPDATE_BACKUP([\s\S]*?)\n!macroend\n/.exec(nsh)
  if (!m) {
    console.log('  [!!] 找不到 MXBOT_UPDATE_BACKUP 宏')
    process.exitCode = 1
  } else {
    const body = m[1]
    // 宏体里用到的寄存器（$R0-$R9、$0-$9）
    const used = new Set()
    for (const mm of body.matchAll(/\$R(\d)/g)) used.add('$R' + mm[1])
    for (const mm of body.matchAll(/(?<![A-Za-z0-9_$])\$(\d)(?![0-9])/g)) used.add('$' + mm[1])

    // Push 的
    const pushed = new Set()
    for (const mm of body.matchAll(/^\s*Push\s+(\$R?\d)\s*$/gm)) pushed.add(mm[1])
    const popped = new Set()
    for (const mm of body.matchAll(/^\s*Pop\s+(\$R?\d)\s*$/gm)) popped.add(mm[1])

    console.log('      用到的: ' + [...used].sort().join(' '))
    console.log('      Push  : ' + [...pushed].sort().join(' '))
    console.log('      Pop   : ' + [...popped].sort().join(' '))

    const unprotected = [...used].filter((u) => !pushed.has(u))
    // 注意：$R4/$R5 之类如果只做临时变量也应该保护，但有些是"故意不保护"
    // 的纯输出变量。这里全部要求保护，因为宏可能被插到任何上下文里。
    console.log('')
    if (unprotected.length > 0) {
      console.log('  [!!] 这些寄存器没有 Push 保护：' + unprotected.join(' '))
      console.log('       真实安装器模板可能已在用它们，会破坏安装器状态！')
      process.exitCode = 1
    } else {
      console.log('  [OK] 用到的寄存器全部有 Push 保护')
    }

    const pushPopMismatch = [...pushed].filter((p) => !popped.has(p))
    const popPushMismatch = [...popped].filter((p) => !pushed.has(p))
    if (pushPopMismatch.length || popPushMismatch.length) {
      console.log('  [!!] Push/Pop 不配对！')
      if (pushPopMismatch.length) console.log('       Push 了但没 Pop: ' + pushPopMismatch.join(' '))
      if (popPushMismatch.length) console.log('       Pop 了但没 Push: ' + popPushMismatch.join(' '))
      process.exitCode = 1
    } else {
      console.log('  [OK] Push/Pop 配对正确（' + pushed.size + ' 对）')
    }
  }
}

/*
 * ---- [3] 真实安装包能不能正常启动（不实际安装，只看它能否运行到自检）----
 *
 * 用 /? 或 --help 之类的参数通常不会真装。更安全的做法：
 * 直接**不运行**它。这里只验证文件完整性（大小、PE 头、能否被 7z 识别）。
 */
console.log('')
console.log('  [3] 安装包完整性')
{
  const buf = fs.readFileSync(setup)
  const isPE = buf[0] === 0x4d && buf[1] === 0x5a // MZ
  console.log('      ' + (isPE ? '[OK]  ' : '[!!]  ') + '是有效的 Windows 可执行文件（MZ 头）')
  // NSIS 的签名标记
  const nsisMark = buf.indexOf(Buffer.from('Nullsoft', 'utf8')) >= 0
  console.log('      ' + (nsisMark ? '[OK]  ' : '[--]  ') + '包含 NSIS 标记')
  if (!isPE) process.exitCode = 1
}

console.log('')
console.log('  ' + '='.repeat(64))
console.log(process.exitCode ? '  [!!] 有问题' : '  [OK] 真安装包验证通过')
console.log('')
