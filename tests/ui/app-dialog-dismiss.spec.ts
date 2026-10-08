/*
 * ★ AppDialog 的「遮罩关闭 = 取消」契约（四厂商审计确认的高危回归）
 *
 * ## 背景
 *
 * App.vue 的 choose/chooseOne 是 promise 型弹窗：`onPick` 是唯一 resolve 入口。
 * 原来点遮罩只 emit('close') → dlg 被清空、弹窗消失，但那个 Promise
 * **永远不 resolve** —— 等它的调用方整段吊死（busy 复不了位、按钮全灰）。
 *
 * 修法：遮罩点击/Esc 在弹窗内部模拟点「取消类按钮」（value 假值那个），
 * 走正常 pick 结算；纯告知型（找不到假值按钮）才退回 emit('close')。
 *
 * ## 测法（踩过一次 Teleport 的坑）
 *
 * 弹窗本体在 `<Teleport to="body">` 里 —— 用 @vue/test-utils 的 `find('.mask')`
 * 会报 "Cannot call trigger on an empty DOMWrapper"（teleport 的内容不在
 * wrapper 的 DOM 子树里）。现有 dialog-text-confirm.spec.ts 的正确姿势：
 * `attachTo: document.body` 挂载，再从 `document.body` 里查元素、派真实事件。
 * 本条沿用同一套，避免再踩。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import AppDialog from '../../src/renderer/src/AppDialog.vue'
import { nextTick } from 'vue'

type Btn = { text: string; kind?: 'main' | 'ghost' | 'danger'; value: unknown; needsText?: boolean }

/** body 里找弹窗元素（teleport 导致 wrapper.find 找不到，见上面的说明） */
function bodyEl(selector: string): HTMLElement {
  const el = document.body.querySelector(selector)
  if (!el) throw new Error(`body 里找不到 ${selector}`)
  return el
}

describe('★遮罩点击 / Esc 必须按取消结算（不能只关闭）', () => {
  let w: ReturnType<typeof mount> | undefined

  beforeEach(() => {
    document.body.innerHTML = ''
  })
  afterEach(() => {
    w?.unmount()
    w = undefined
    document.body.innerHTML = ''
  })

  it('choose 型按钮（含 value:false 的取消）→ 点遮罩 emit 的是 pick(false)', async () => {
    w = mount(AppDialog, {
      attachTo: document.body,
      props: {
        open: true,
        title: 't',
        body: 'b',
        buttons: [
          { text: '先不更新', kind: 'ghost', value: false },
          { text: '开始更新', kind: 'main', value: true }
        ]
      }
    })
    bodyEl('.mask').click()
    await nextTick()

    expect(w.emitted('close'), '不能再只发 close —— 否则调用方的 Promise 会吊死').toBeFalsy()
    const pick = w.emitted('pick')
    expect(pick, '应当以取消的语义结算').toBeTruthy()
    expect(pick![0][0], '点遮罩应当等价于点「取消」').toBe(false)
  })

  it('chooseOne 型（取消 value:null）→ 点遮罩 emit pick(null)', async () => {
    w = mount(AppDialog, {
      attachTo: document.body,
      props: {
        open: true,
        title: '切到哪个版本？',
        buttons: [
          { text: '取消', kind: 'ghost', value: null },
          { text: 'v4.29.0', kind: 'main', value: 'v4.29.0' }
        ]
      }
    })
    bodyEl('.mask').click()
    await nextTick()
    expect(w.emitted('pick')![0][0]).toBe(null)
  })

  it('★Esc 与遮罩同一路径；关闭后不再生效', async () => {
    w = mount(AppDialog, {
      attachTo: document.body,
      props: {
        open: true,
        title: 't',
        buttons: [
          { text: '取消', kind: 'ghost', value: false },
          { text: '确定', kind: 'main', value: true }
        ]
      }
    })
    // window 级监听：必须真派 keydown
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()
    expect(w.emitted('pick')![0][0]).toBe(false)

    // 关掉之后 Esc 不再动作（监听虽挂着，open=false 要被挡住）
    await w.setProps({ open: false })
    await nextTick()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()
    expect(w.emitted('pick'), '关闭后 Esc 不该再派发 pick').toHaveLength(1)
  })

  it('纯告知型（只有「知道啦」）→ 点遮罩退回 close（没有等待者，关掉即是答复）', async () => {
    w = mount(AppDialog, {
      attachTo: document.body,
      props: { open: true, title: 't', buttons: [{ text: '知道啦', kind: 'main', value: true }] }
    })
    bodyEl('.mask').click()
    await nextTick()
    expect(w.emitted('close'), '没有取消项时保持原行为').toBeTruthy()
    expect(w.emitted('pick')).toBeFalsy()
  })
})

/*
 * 附：requireText 的取消安全不受影响 ——
 * 点遮罩 = 点「取消」，取消键**无条件生效**（AppDialog pick 的既有契约：
 * 只有 needsText 的按钮才校验输入）。这条由 dialog-text-confirm.spec.ts 守着。
 */
