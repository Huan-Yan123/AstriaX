/*
 * 删除确认框的按钮语义。
 *
 * ## 用户报告（两条，同一段代码）
 *
 *   1. 「为什么我点取消都弹『名字没输对』」
 *   2. 「而且输入名字点取消，也成功删除了」
 *
 * 第 2 条是**数据毁灭级**的：用户想取消，实例被永久删了。
 *
 * ## 根因
 *
 * AppDialog.vue 的 pick() 原来是：
 *
 *     function pick(b: DialogButton): void {
 *       if (props.requireText && text.value.trim() !== props.requireText) {
 *         emit('pick', { __invalid: true }); return
 *       }
 *       emit('pick', props.requireText ? { __confirmed: true, text: ... } : b.value)
 *     }
 *
 * 两个错误叠在一起：
 *
 * ① **输入校验没有「只针对确认按钮」**。`requireText` 是弹窗级属性，
 *    pick() 对**任何**按钮都先校验一遍。于是点「取消」时输入框是空的 →
 *    校验不过 → 弹出「名字不一致」。取消键本该无条件生效。
 *
 * ② **放行时丢弃了按钮自身的值**。校验一通过就 emit
 *    `{__confirmed:true, text}`（一个真值对象），把 `b.value` 扔了。
 *    而取消按钮的 value 是 `false` —— 被那个对象盖掉之后，
 *    上层 `onPick(v)` 收到的是真值，于是一路走到删除逻辑。
 *    **输入了正确名字 + 点取消 = 删除**，就是这条。
 *
 * ## 正确的语义
 *
 *   - 「取消」这类 value 为假值的按钮：**永远**直接生效，不校验、不改写。
 *   - 「永久删除」这类确认按钮：才需要输入名字；不匹配就报错并**保持弹窗打开**。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import AppDialog from '../../src/renderer/src/AppDialog.vue'

const NAME = 'AstrBot 实例'

function mountDlg(): VueWrapper {
  return mount(AppDialog, {
    attachTo: document.body,
    props: {
      open: true,
      title: `删除「${NAME}」？`,
      body: '该实例的全部数据会被永久删除，不可恢复。',
      requireText: NAME,
      inputPlaceholder: `输入「${NAME}」以确认`,
      buttons: [
        { text: '取消', kind: 'ghost', value: false },
        { text: '永久删除', kind: 'danger', value: true, needsText: true }
      ]
    }
  })
}

/** 从 body 里按文字找按钮（弹窗是 Teleport 到 body 的） */
function clickButton(label: string): void {
  const b = [...document.body.querySelectorAll('button')].find(
    (x) => (x.textContent ?? '').trim() === label
  )
  if (!b) throw new Error(`没找到按钮：${label}（body 里有：${[...document.body.querySelectorAll('button')].map((x) => x.textContent).join('/')}）`)
  ;(b as HTMLButtonElement).click()
}

/** 往输入框里打字（走 v-model） */
function typeText(s: string): void {
  const input = document.body.querySelector('input') as HTMLInputElement | null
  if (!input) throw new Error('没找到输入框')
  input.value = s
  input.dispatchEvent(new Event('input'))
}

/** 最后一次 pick 事件的载荷 */
function lastPick(w: VueWrapper): unknown {
  const evs = w.emitted('pick')
  if (!evs || !evs.length) return Symbol('没有 pick 事件')
  return evs[evs.length - 1][0]
}

const isInvalid = (v: unknown): boolean =>
  typeof v === 'object' && v !== null && '__invalid' in v

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('删除确认框 · 取消键', () => {
  it('★什么都没输就点取消 → 必须直接取消，不能弹「名字不一致」', async () => {
    const w = mountDlg()
    clickButton('取消')
    await w.vm.$nextTick()

    const v = lastPick(w)
    expect(isInvalid(v), '点取消却报「名字不一致」').toBe(false)
    expect(v, '取消应当发出 false（假值），上层才会走「什么都不做」').toBe(false)
  })

  it('★输入了正确名字再点取消 → 仍然只是取消，绝不能删', async () => {
    const w = mountDlg()
    typeText(NAME)
    await w.vm.$nextTick()
    clickButton('取消')
    await w.vm.$nextTick()

    const v = lastPick(w)
    expect(
      v,
      '输入正确名字后点取消，发出的却是真值 —— 上层会照它去删除实例！'
    ).toBe(false)
  })

  it('★输入了错误名字再点取消 → 也是取消', async () => {
    const w = mountDlg()
    typeText('随便打的')
    await w.vm.$nextTick()
    clickButton('取消')
    await w.vm.$nextTick()
    expect(lastPick(w)).toBe(false)
  })
})

describe('删除确认框 · 删除键', () => {
  it('★没输入名字就点删除 → 报错（__invalid），不能删', async () => {
    const w = mountDlg()
    clickButton('永久删除')
    await w.vm.$nextTick()
    expect(isInvalid(lastPick(w)), '没输名字就让它删了').toBe(true)
  })

  it('★名字输错了点删除 → 报错，不能删', async () => {
    const w = mountDlg()
    typeText('AstrBot')
    await w.vm.$nextTick()
    clickButton('永久删除')
    await w.vm.$nextTick()
    expect(isInvalid(lastPick(w))).toBe(true)
  })

  it('★名字完全一致点删除 → 才真的发 true', async () => {
    const w = mountDlg()
    typeText(NAME)
    await w.vm.$nextTick()
    clickButton('永久删除')
    await w.vm.$nextTick()
    expect(lastPick(w), '名字对了却不给删').toBe(true)
  })

  it('★名字前后有空格也算（用户复制粘贴常带空格）', async () => {
    const w = mountDlg()
    typeText(`  ${NAME}  `)
    await w.vm.$nextTick()
    clickButton('永久删除')
    await w.vm.$nextTick()
    expect(lastPick(w)).toBe(true)
  })
})

describe('删除确认框 · 回车键', () => {
  it('★输入正确名字后按回车 → 等同于点删除', async () => {
    const w = mountDlg()
    typeText(NAME)
    await w.vm.$nextTick()
    const input = document.body.querySelector('input') as HTMLInputElement
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }))
    await w.vm.$nextTick()
    expect(lastPick(w), '回车应当触发「永久删除」而不是取消').toBe(true)
  })

  it('★没输名字就按回车 → 报错，不能取消也不能删', async () => {
    const w = mountDlg()
    const input = document.body.querySelector('input') as HTMLInputElement
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }))
    await w.vm.$nextTick()
    expect(isInvalid(lastPick(w))).toBe(true)
  })
})

describe('删除确认框 · 无输入框的普通弹窗', () => {
  it('★不需要输入名字时，按钮的值原样传出去', async () => {
    const w = mount(AppDialog, {
      attachTo: document.body,
      props: {
        open: true,
        title: '确定要停止吗？',
        buttons: [
          { text: '取消', kind: 'ghost', value: false },
          { text: '确定', kind: 'main', value: true }
        ]
      }
    })
    clickButton('取消')
    await w.vm.$nextTick()
    expect(lastPick(w)).toBe(false)
    clickButton('确定')
    await w.vm.$nextTick()
    expect(lastPick(w)).toBe(true)
  })
})
