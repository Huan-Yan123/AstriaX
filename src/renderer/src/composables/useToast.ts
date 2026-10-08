/**
 * Toast 通知 Composable
 * 用法：const { toast } = useToast()
 *       toast.success('操作成功')
 */
import { ref } from 'vue'

export interface ToastItem {
  id: number
  type: 'info' | 'success' | 'warning' | 'error'
  message: string
  duration: number
}

const toasts = ref<ToastItem[]>([])
let nextId = 1

export function useToast() {
  function addToast(type: ToastItem['type'], message: string, duration = 3000): void {
    const id = nextId++
    toasts.value.push({ id, type, message, duration })

    if (duration > 0) {
      setTimeout(() => {
        removeToast(id)
      }, duration)
    }
  }

  function removeToast(id: number): void {
    const index = toasts.value.findIndex((t) => t.id === id)
    if (index > -1) {
      toasts.value.splice(index, 1)
    }
  }

  return {
    toasts,
    toast: {
      info: (msg: string, duration?: number) => addToast('info', msg, duration),
      success: (msg: string, duration?: number) => addToast('success', msg, duration),
      warning: (msg: string, duration?: number) => addToast('warning', msg, duration),
      error: (msg: string, duration?: number) => addToast('error', msg, duration)
    },
    removeToast
  }
}
