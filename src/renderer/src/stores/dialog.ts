/**
 * 对话框 Store
 * 管理全局弹窗状态
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * 问题反馈群 + 附在求助弹窗末尾的一行。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 提到**模块作用域**（主人 2026-10-08）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 原来 `notify()` 和 `choose()` **各自**在函数体里写了一遍
 * `const FEEDBACK_QQ = '2250713669'` —— 同一份数据抄两遍。
 * 这正是"改一处漏一处"的经典土壤：主人要求去掉个人 QQ 时，
 * 必须先在两处都找到它们才敢改（我这次就是搜 `2250713669` 才找全的）。
 *
 * 现在一份定义、两处引用。与 `App.vue` 的 `FEEDBACK_LINE`
 * 是同一个号（渲染层没有跨文件共享常量的地方，所以各写一份），
 * 测试会校验它们一致。
 *
 * 文案（为什么不是"加我 QQ"）：换成群之后，"找我"这个主语就不成立了 ——
 * 群里是互相帮忙，且可能有人已经遇到过。所以写成"去群里问"。
 */
const OFFICIAL_GROUP = '1077554004'
const FEEDBACK_LINE = `\n\n—— 搞不定的话去群里问：${OFFICIAL_GROUP}（问题反馈群）`

export interface DialogButton {
  text: string
  kind: 'main' | 'ghost' | 'danger'
  value: unknown
  current?: boolean
}

export interface DialogState {
  title: string
  body?: string
  buttons: DialogButton[]
  requireText?: string
  inputPlaceholder?: string
  error?: string
  choiceList?: boolean
  onPick?: (v: unknown) => void
}

export const useDialogStore = defineStore('dialog', () => {
  const dialog = ref<DialogState | null>(null)

  function showDialog(state: DialogState): void {
    dialog.value = state
  }

  function closeDialog(): void {
    dialog.value = null
  }

  function setError(error: string): void {
    if (dialog.value) {
      dialog.value = { ...dialog.value, error }
    }
  }

  /**
   * 简单通知
   */
  function notify(title: string, body?: string, opts?: { feedback?: boolean }): void {
    showDialog({
      title,
      body: opts?.feedback ? `${body ?? ''}${FEEDBACK_LINE}` : body,
      buttons: [{ text: '知道了', kind: 'main', value: true }]
    })
  }

  /**
   * 确认对话框
   */
  function confirm(
    title: string,
    body: string,
    onYes: () => void,
    danger = false
  ): void {
    showDialog({
      title,
      body,
      buttons: [
        { text: '取消', kind: 'ghost', value: false },
        { text: '确定', kind: danger ? 'danger' : 'main', value: true }
      ],
      onPick: (v) => {
        if (v) onYes()
      }
    })
  }

  /**
   * 二选一
   */
  function choose(
    title: string,
    body: string,
    yes: string,
    no: string,
    opts?: { feedback?: boolean }
  ) {
    return new Promise<boolean>((resolve) => {
      showDialog({
        title,
        body: opts?.feedback ? `${body}${FEEDBACK_LINE}` : body,
        buttons: [
          { text: no, kind: 'ghost', value: false },
          { text: yes, kind: 'main', value: true }
        ],
        onPick: (v) => resolve(v === true)
      })
    })
  }

  /**
   * 多选一
   */
  function chooseOne(
    title: string,
    body: string,
    options: Array<{ text: string; value: string; current?: boolean }>
  ): Promise<string | null> {
    return new Promise((resolve) => {
      showDialog({
        title,
        body,
        choiceList: true,
        buttons: [
          { text: '取消', kind: 'ghost', value: null },
          ...options.map((o) => ({
            text: o.text,
            kind: 'main' as const,
            value: o.value,
            current: o.current
          }))
        ],
        onPick: (v) => resolve(typeof v === 'string' ? v : null)
      })
    })
  }

  return {
    dialog,
    showDialog,
    closeDialog,
    setError,
    notify,
    confirm,
    choose,
    chooseOne
  }
})
