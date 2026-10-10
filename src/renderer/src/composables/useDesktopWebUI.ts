import { ref, onMounted, onUnmounted } from 'vue'

interface WebUIApi {
  open(id: string): Promise<unknown>
  close(id: string): Promise<unknown>
  list(): Promise<string[]>
  visible?(): Promise<string | undefined>
  onClosed?(callback: () => void): () => void
}

export function useDesktopWebUI(options: { name(id: string): string; report(title: string, body: string): void }) {
  const webuiOpen = ref(new Set<string>())
  const webuiVisible = ref<string>()
  const webuiBusy = ref(new Set<string>())
  const api = (): WebUIApi | undefined => (window as unknown as { launcher?: { webui?: WebUIApi } }).launcher?.webui
  let revision = 0
  let unsubscribe: (() => void) | undefined

  async function refreshWebUi(): Promise<void> {
    const current = ++revision
    try {
      const [ids, visible] = await Promise.all([api()?.list(), api()?.visible?.()])
      if (current !== revision) return
      webuiOpen.value = new Set(ids ?? [])
      webuiVisible.value = visible
    } catch { /* Keep the last confirmed host state when a snapshot cannot be read. */ }
  }
  async function toggleWebUi(id: string): Promise<void> {
    const host = api()
    if (!host || webuiBusy.value.has(id)) return
    webuiBusy.value = new Set(webuiBusy.value).add(id)
    try {
      if (webuiOpen.value.has(id)) await host.close(id)
      else await host.open(id)
      await refreshWebUi()
    } catch (error) {
      options.report(`「${options.name(id)}」的 WebUI 打不开`, error instanceof Error ? error.message : String(error))
    } finally {
      const next = new Set(webuiBusy.value)
      next.delete(id)
      webuiBusy.value = next
    }
  }
  async function closeAllWebUi(): Promise<void> {
    const host = api()
    if (!host) return
    await Promise.all([...webuiOpen.value].map(id => host.close(id).catch(() => undefined)))
    await refreshWebUi()
  }
  onMounted(() => { unsubscribe = api()?.onClosed?.(() => { void refreshWebUi() }) })
  onUnmounted(() => { ++revision; unsubscribe?.() })
  return { webuiOpen, webuiVisible, webuiBusy, refreshWebUi, toggleWebUi, closeAllWebUi }
}
