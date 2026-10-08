#!/usr/bin/env node
/**
 * 验证「首启遮罩闪现」的回归测试**真的能抓到那个 bug**。
 *
 * ## 为什么要有这一步
 *
 * 项目里的铁律之一是「先验证尺子准不准」。我刚写了
 * `tests/ui/first-run.spec.ts` 里的新用例，它在 `mount()` 之后
 * **同步地**断言遮罩不存在。但这里有个容易自欺的地方：
 *
 *   如果 `mount()` 的首次渲染其实是**异步**的（或者
 *   `findComponent` 在组件树没建好时总是返回 not-exists），
 *   那条断言就会**永远通过** —— 哪怕 bug 还在。
 *   这种"永远绿"的测试比没有测试更危险：它让人以为守住了。
 *
 * ## 做法
 *
 * 拿一份 App.vue 的副本，把 `firstRun` 改回老的 `ref(true)`，
 * 用同样的方式 mount 并断言 —— 这时**必须**能查到遮罩。
 * 能查到 → 说明新用例的检测手段有效（bug 在就会红）。
 *
 * 用副本而不是改原文件：原文件必须保持修好的状态。
 *
 * 用法：node scripts/_verify-firstrun-test.cjs
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const APP = path.join(ROOT, 'src', 'renderer', 'src', 'App.vue')
const BAK = path.join(ROOT, 'src', 'renderer', 'src', '_App.vue.probe-bak')
const SPEC = path.join(ROOT, 'tests', 'ui', '_firstrun-probe.spec.ts')

const original = fs.readFileSync(APP, 'utf8')

/** 把三态改回老的一元写法（复现 bug） */
function breakIt(src) {
  return src.replace(
    'const firstRun = ref<boolean | null>(null)',
    'const firstRun = ref(true)'
  )
}

let bad = 0
try {
  const broken = breakIt(original)
  if (broken === original) {
    console.error('✘ 没能在 App.vue 里找到那行声明 —— 探针失效，请更新脚本')
    process.exit(1)
  }

  // 生成一个"把 bug 放回来"的临时探针 spec
  // 注意路径：spec 落在 tests/ui/ 下，要往上两级才到仓库根
  const probe = `
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import App from '../../src/renderer/src/App.vue'
import FirstRunWizard from '../../src/renderer/src/FirstRunWizard.vue'

describe('探针：确认检测手段能抓到 firstRun 闪现', () => {
  it('老写法下，mount 之后同步就能看到遮罩（说明断言有效）', async () => {
    ;(window as any).launcher = {
      config: { get: async () => ({ dataRoot: 'D:\\\\ACB\\\\data' }), set: async () => {} },
      instance: { list: async () => [] }
    }
    const app = mount(App)
    // 关键：**不等** flushPromises。老写法下此时 firstRun 仍是 true。
    expect(app.findComponent(FirstRunWizard).exists()).toBe(true)
  })
})
`
  // 先备份原 App.vue，写入"坏版"
  fs.copyFileSync(APP, BAK)
  fs.writeFileSync(APP, broken, 'utf8')
  fs.writeFileSync(SPEC, probe, 'utf8')

  console.log('把 firstRun 改回 ref(true) 后跑探针……\n')
  let out = ''
  let passed = false
  try {
    out = execFileSync(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['vitest', 'run', '--no-file-parallelism', 'tests/ui/_firstrun-probe.spec.ts'],
      { cwd: ROOT, encoding: 'utf8', timeout: 300000, shell: process.platform === 'win32' }
    )
    passed = true
  } catch (e) {
    out = String(e.stdout ?? '') + String(e.stderr ?? '')
  }

  const ok = /1 passed/.test(out)
  if (ok) {
    console.log('  ✔ 探针在"坏版"下确实看到了遮罩 —— 说明新用例的检测手段有效')
    console.log('     （bug 一旦回来，tests/ui/first-run.spec.ts 那条会红）')
  } else {
    bad++
    console.log('  ✘ 探针在"坏版"下**没**看到遮罩 —— 检测手段无效！')
    console.log('     这意味着 tests/ui/first-run.spec.ts 里那条新用例是"永远绿"的假测试。')
    console.log('     vitest 输出片段：')
    console.log(out.split('\n').slice(-20).join('\n'))
  }
} finally {
  // 无论成败都要还原
  fs.writeFileSync(APP, original, 'utf8')
  try {
    fs.unlinkSync(BAK)
  } catch {
    /* 忽略 */
  }
  try {
    fs.unlinkSync(SPEC)
  } catch {
    /* 忽略 */
  }
  console.log('\n原文件已还原（三态版本）。')
}

process.exit(bad)
