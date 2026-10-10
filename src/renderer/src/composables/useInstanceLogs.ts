import { ref, watch, nextTick, onUnmounted } from 'vue'

export function useInstanceLogs(report: (title: string, body: string) => void) {
  const logView = ref<{ id: string; name: string; text: string } | null>(null)
  const logPre = ref<HTMLElement | null>(null)
  let timer: ReturnType<typeof setInterval> | undefined
  let revision = 0
  function closeLog(): void {
    ++revision
    if (timer) clearInterval(timer)
    timer = undefined
    logView.value = null
  }
  async function showLog(instance: { id: string; name: string }): Promise<void> {
    const read = (window as unknown as { launcher?: { instance?: { log(id: string): Promise<string> } } }).launcher?.instance?.log
    if (!read) { report('暂时看不了日志', '日志通道没接上。'); return }
    closeLog()
    const current = revision
    try {
      const text = await read(instance.id)
      if (current !== revision) return
      logView.value = { ...instance, text: text || '（暂无输出——先启动一次）' }
      let reading = false
      timer = setInterval(() => {
        if (reading) return
        reading = true
        void read(instance.id).then(text => {
          if (current !== revision || !logView.value) return
          text ||= '（暂无输出——先启动一次）'
          if (logView.value.text !== text) logView.value = { ...logView.value, text }
        }).catch(() => undefined).finally(() => { reading = false })
      }, 2000)
    } catch (error) {
      if (current === revision) report('读取日志失败', error instanceof Error ? error.message : String(error))
    }
  }
  watch(logView, async value => {
    if (!value) return
    await nextTick()
    if (logPre.value) logPre.value.scrollTop = logPre.value.scrollHeight
  })
  onUnmounted(closeLog)
  return { logView, logPre, showLog, closeLog }
}
