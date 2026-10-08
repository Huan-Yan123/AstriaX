#!/usr/bin/env node
/**
 * 验证「创建按钮永久灰掉」的回归测试**真的能抓到那个 bug**。
 *
 * ## 为什么要有这一步
 *
 * 我刚在 `tests/ui/create-wizard.spec.ts` 里加了两条用例，
 * 断言"父组件复位 busy 后按钮又能点"。但有个容易自欺的可能：
 * 如果 `:disabled="busy || !canCreate"` 里 `busy` 这个标识符
 * 其实没绑到 props 上（比如被当成 undefined），那 `busy` 恒为假，
 * 断言就**永远通过** —— bug 在也不红。这种"永远绿"的测试最危险。
 *
 * ## 做法
 *
 * 把 CreateWizard.vue 的模板临时改回"自己管 busy"的坏写法
 * （`busy` 恒为 true 那种不现实，改成一个更接近原 bug 的形态：
 *  submit 里置 true 且不复位），然后跑一条**专门探测**的断言：
 * 点一次之后按钮必须变禁用。
 *
 *   · 坏版下能观察到"点完就禁用" → 说明检测手段有效
 *   · 坏版下观察不到 → 说明我的断言无效，得换判据
 *
 * 原文件跑完必须还原（用副本 + finally 保证）。
 *
 * 用法：node scripts/_verify-busy-test.cjs
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const WIZ = path.join(ROOT, 'src', 'renderer', 'src', 'CreateWizard.vue')
const SPEC = path.join(ROOT, 'tests', 'ui', '_busy-probe.spec.ts')

const original = fs.readFileSync(WIZ, 'utf8')

/**
 * 把"自己管 busy 且不复位"的老 bug 放回来。
 *
 * 做法：在 script 里加一个本地的 busy ref，并让 submit 置 true；
 * 模板里的 `busy` 会优先解析到本地 ref（遮蔽 props）。
 *
 * ## 锚点必须用**正则**，不能写字面量 `\n`
 *
 * 第一版写的是 `"  err.value = ''\n  /*"`，结果替换次数为 0 ——
 * 因为 CreateWizard.vue 是 **CRLF** 换行，实际是 `\r\n`。
 * 于是"坏版"根本没改，探针跑的其实还是修好的版本，
 * 报出"没观察到禁用"—— 那句话**看起来**像在说我的判据无效，
 * 实际是在说注入没生效。
 *
 * 两个结论的修法完全不同（一个改判据、一个改注入），
 * 所以这种时候一定要先确认"我到底改了没有"，别急着下结论。
 * 用 `\r?\n` 就两种换行都能匹配。
 */
function breakIt(src) {
  let s = src
  // 1) 在 defaultPort 声明前插入本地 busy ref（遮蔽 props.busy）
  s = s.replace(
    /const defaultPort = ref<number \| null>\(null\)/,
    'const busy = ref(false)\nconst defaultPort = ref<number | null>(null)'
  )
  // 2) submit 里加回 busy.value = true（锚点用正则兼容 CRLF）
  s = s.replace(/err\.value = ''\r?\n/, "err.value = ''\n  busy.value = true\n")
  return s
}

let bad = 0
try {
  const broken = breakIt(original)
  /*
   * 校验注入**真的生效了**，否则后面的结论毫无意义。
   * 第一版就是漏了这一步，把一个"注入失败"误读成"判据无效"。
   */
  const injectedRef = broken.includes('const busy = ref(false)')
  const injectedSet = /busy\.value = true/.test(broken)
  if (!injectedRef || !injectedSet) {
    console.error('✘ 坏写法注入失败 —— 探针本身有问题，请检查锚点是否匹配')
    console.error(`   插入本地 busy ref: ${injectedRef}`)
    console.error(`   插入 busy.value=true: ${injectedSet}`)
    process.exit(1)
  }

  const probe = `
import { describe, it, expect } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import CreateWizard from '../../src/renderer/src/CreateWizard.vue'

describe('探针：坏写法下按钮会不会被自己禁掉', () => {
  it('点一次后按钮变成禁用（老 bug 的形态）', async () => {
    ;(globalThis as any).window ??= {}
    ;(globalThis as any).window.launcher = {
      runtimes: { list: async () => [{ type: 'a', tag: 'v4.28.0' }] },
      instance: { list: async () => [] },
      python: { status: async () => ({ ready: true }) }
    }
    const w = mount(CreateWizard, { props: { defaultType: 'a', busy: false } })
    await flushPromises()
    await w.find('.main').trigger('click')
    await flushPromises()
    // 坏写法（向导自己置 busy 且不复位）→ 这里应为 true
    expect((w.find('.main').element as HTMLButtonElement).disabled).toBe(true)
  })
})
`
  fs.writeFileSync(WIZ, broken, 'utf8')
  fs.writeFileSync(SPEC, probe, 'utf8')

  console.log('注入"向导自己管 busy 且不复位"的坏写法后跑探针……\n')
  let out = ''
  try {
    out = execFileSync(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['vitest', 'run', '--no-file-parallelism', 'tests/ui/_busy-probe.spec.ts'],
      { cwd: ROOT, encoding: 'utf8', timeout: 300000, shell: process.platform === 'win32' }
    )
  } catch (e) {
    out = String(e.stdout ?? '') + String(e.stderr ?? '')
  }

  if (/1 passed/.test(out)) {
    console.log('  ✔ 坏写法下确实观察到"点完就禁用" —— 说明判据有效')
    console.log('     （bug 一旦回来，create-wizard.spec.ts 那条会红）')
  } else {
    bad++
    console.log('  ✘ 坏写法下**没**观察到禁用 —— 判据无效，得换检测方式')
    console.log(out.split('\n').slice(-18).join('\n'))
  }
} finally {
  fs.writeFileSync(WIZ, original, 'utf8')
  try {
    fs.unlinkSync(SPEC)
  } catch {
    /* 忽略 */
  }
  console.log('\nCreateWizard.vue 已还原（busy 归父组件版本）。')
}

process.exit(bad)
