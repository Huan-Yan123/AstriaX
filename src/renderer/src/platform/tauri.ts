import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { createLauncherApi, type LauncherTransport } from '../../../shared/launcher-api'

type Handler = (...args: any[]) => void
// Registration may finish after a Vue component unmounts; still release its listener.
export function createTauriTransport(): LauncherTransport {
  const subscriptions = new Map<string, Map<Handler, { disposed: boolean; off?: UnlistenFn }>>()
  return {
    async invoke(channel, ...args) {
      try { return await invoke('launcher_request', { channel, payload: args[0] ?? null }) }
      catch (error) {
        const message = typeof error === 'object' && error !== null && 'message' in error
          ? String(error.message) : String(error)
        throw new Error(message)
      }
    },
    send(channel, ...args) { void this.invoke(channel, ...args).catch(console.error) },
    on(channel, handler) {
      this.removeListener(channel, handler)
      let group = subscriptions.get(channel)
      if (!group) { group = new Map(); subscriptions.set(channel, group) }
      const subscription: { disposed: boolean; off?: UnlistenFn } = { disposed: false }
      group.set(handler, subscription)
      void listen(channel, ({ payload }) => { if (!subscription.disposed) handler(undefined, payload) }).then(off => {
        if (subscription.disposed) off()
        else subscription.off = off
      }).catch(error => { group!.delete(handler); console.error(error) })
    },
    removeListener(channel, handler) {
      const group = subscriptions.get(channel)
      const subscription = group?.get(handler)
      if (!subscription) return
      subscription.disposed = true
      subscription.off?.()
      group!.delete(handler)
      if (!group!.size) subscriptions.delete(channel)
    },
  }
}

export function installDesktopBridge(): void {
  if (!isTauri()) return
  const transport = createTauriTransport()
  Object.defineProperty(window, 'launcher', { value: createLauncherApi(transport) })
  const api = {
    minimize: () => transport.invoke('window:minimize'),
    toggleMaximize: () => transport.invoke('window:toggleMaximize'),
    close: () => transport.invoke('window:close'),
    isMaximized: () => transport.invoke('window:isMaximized'),
    onMaximizeChange(callback: (maximized: boolean) => void) {
      const handler = (_: unknown, maximized: boolean): void => callback(maximized)
      transport.on('window:maximize-change', handler)
      return () => transport.removeListener('window:maximize-change', handler)
    },
  }
  Object.defineProperty(window, 'desktop', { value: { window: api } })
  if (import.meta.env.DEV) void transport.invoke('app:ping').then(async ping => {
    const result = await transport.invoke('desktop:ready', { ping })
    if (result?.smokePending) {
      await transport.invoke('window:isMaximized')
      await transport.invoke('desktop:finish')
    }
  }).catch(console.error)
}
