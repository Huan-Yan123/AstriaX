/**
 * WebUI 管理 Composable
 * 封装 WebUI 开关逻辑
 */
import { ref } from 'vue'
import { useUIStore } from '../stores/ui'

export function useWebUI() {
  const uiStore = useUIStore()

  function webuiApi() {
    return (window as any).launcher?.webui
  }

  async function refreshWebUI(): Promise<void> {
    try {
      const api = webuiApi()
      if (!api) return

      const ids = (await api.list()) ?? []
      uiStore.setWebuiOpen(new Set(ids))
      
      const visible = await api.visible?.()
      uiStore.setWebuiVisible(visible)
    } catch {
      /* 无 webui 通道则维持现状 */
    }
  }

  async function toggleWebUI(id: string, instanceName: string): Promise<void> {
    const api = webuiApi()
    if (!api || uiStore.webuiBusy.has(id)) return

    uiStore.addWebuiBusy(id)
    try {
      if (uiStore.webuiOpen.has(id)) {
        await api.close(id)
        const next = new Set(uiStore.webuiOpen)
        next.delete(id)
        uiStore.setWebuiOpen(next)
      } else {
        await api.open(id)
        const next = new Set(uiStore.webuiOpen)
        next.add(id)
        uiStore.setWebuiOpen(next)
      }

      await refreshWebUI()
    } catch (e) {
      throw new Error(`「${instanceName}」的 WebUI 打不开: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      uiStore.removeWebuiBusy(id)
    }
  }

  async function closeAllWebUI(): Promise<void> {
    const api = webuiApi()
    if (!api) return
    
    await Promise.all(
      [...uiStore.webuiOpen].map((id) => api.close(id).catch(() => undefined))
    )
    await refreshWebUI()
  }

  return {
    refreshWebUI,
    toggleWebUI,
    closeAllWebUI
  }
}
