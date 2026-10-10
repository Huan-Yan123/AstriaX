import { ref } from 'vue'
import type { Instance } from '../types/instance'
import type { useLauncherDialogs } from './useLauncherDialogs'
type Dialogs = ReturnType<typeof useLauncherDialogs>
export function useInstanceCredentials({ ask, note, refresh }: {
    ask: Dialogs['ask']; note: Dialogs['note']; refresh: () => Promise<void>
  }) {
  interface Cred { label: string; value: string }
  const credView = ref<{ name: string; list: Cred[] } | null>(null)
  const credErr = ref('')

  async function showCreds(x: Instance): Promise<void> {
    credErr.value = ''
    const cApi = (window as unknown as { launcher?: { instance?: { creds?: (id: string) => Promise<Cred[]> } } }).launcher?.instance?.creds
    if (!cApi) {
      return
    }
    try {
      const list = await cApi(x.id)
      if (list.length === 0) {
        credView.value = { name: x.name, list: [] }
        credErr.value = '暂未在运行时配置里找到账号信息（实例首次启动完成初始化后再试）'
      } else {
        credView.value = { name: x.name, list }
      }
    } catch (e) {
      credErr.value = String(e instanceof Error ? e.message : e)
    }
  }
  function resetCreds(x: Instance): void {
    const running = x.status === 'running' || x.status === 'starting'
    const go = (): void => {
      void (async () => {
        const rApi = (
          window as unknown as {
            launcher?: {
              instance?: { resetCreds?: (id: string) => Promise<{ list: Array<{ label: string; value: string }>; stoppedFirst?: boolean }> }
            }
          }
        ).launcher?.instance?.resetCreds
        if (!rApi) {
          note('暂时重置不了', '重置功能没接上。')
          return
        }
        try {
          const r = await rApi(x.id)
          await refresh()
          credErr.value = ''
          credView.value = { name: x.name, list: r.list }
        } catch (e) {
          credErr.value = e instanceof Error ? e.message : String(e)
          credView.value = { name: x.name, list: [] }
        }
      })()
    }

    const what =
      x.type === 'n'
        ? 'WebUI 登录 token 为 114514'
        : '用户名和密码都是 astrbot'
    if (running) {
      ask(`重置「${x.name}」的账密？`, `会先把实例停下来，重置账密为${what}。改完要重新启动才生效。`, go, true)
    } else {
      ask(`重置「${x.name}」的账密？`, `重置账密为${what}。改完要重新启动才生效。`, go, true)
    }
  }
  return { credView, credErr, showCreds, resetCreds }
}
