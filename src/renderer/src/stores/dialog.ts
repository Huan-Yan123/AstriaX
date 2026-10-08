/**
 * 对话框 Store
 * 管理全局弹窗状态
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'

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
    const FEEDBACK_QQ = '2250713669'
    const FEEDBACK_LINE = `\n\n—— 搞不定的话加我 QQ：${FEEDBACK_QQ}（问题反馈QQ）`

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
  ): Promise<boolean> {
    const FEEDBACK_QQ = '2250713669'
    const FEEDBACK_LINE = `\n\n—— 搞不定的话加我 QQ：${FEEDBACK_QQ}（问题反馈QQ）`

    return new Promise((resolve) => {
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
