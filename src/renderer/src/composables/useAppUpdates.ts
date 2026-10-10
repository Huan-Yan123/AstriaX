import { ref, onMounted } from 'vue'
declare const window: { launcher?: unknown }

export function useAppUpdates() {
  const currentVersion = ref('')
  const checking = ref(false)
  const updMsg = ref('')
  const updErr = ref(false)
  const updPct = ref(0)
  const downloading = ref(false)
  const skipNote = ref('')

  const savedPath = ref('')
  const updInfo = ref<{
    hasUpdate: boolean
    version?: string
    url?: string
    sizeMB?: number
    sha256?: string
    notes?: string
  } | null>(null)

  interface UpdApi {
    app?: {
      version?: () => Promise<string>
      installUpdate?: () => Promise<void>
      pendingUpdate?: () => Promise<{ path: string; version: string } | null>
      checkUpdate?: (opts?: { force?: boolean }) => Promise<{
        hasUpdate: boolean
        latestVersion?: string
        version?: string
        url?: string
        sizeMB?: number
        sha256?: string
        notes?: string
        checkedAt?: number
        throttled?: boolean
        available?: boolean
      }>
      downloadUpdate?: (p: {
        url: string
        version: string
        sha256?: string
        sizeMB?: number
      }) => Promise<string>
      skipVersion?: (v: string) => Promise<void>
      onUpdateProgress?: (cb: (p: { percent: number }) => void) => () => void
    }
    shell?: {
      openPath?: (p: string) => Promise<unknown>
      showItem?: (p: string) => Promise<unknown>
    }
  }

  const updApi = (): UpdApi => (window.launcher as unknown as UpdApi) ?? {}

  async function checkUpdate(force = false): Promise<void> {
    checking.value = true
    updMsg.value = ''
    updErr.value = false
    skipNote.value = ''
    try {

      const r = await updApi().app?.checkUpdate?.(force ? { force: true } : undefined)

      const latest = (r?.latestVersion ?? (r as { version?: string } | undefined)?.version) ?? ''
      updInfo.value = r
        ? {
            hasUpdate: r.hasUpdate,
            version: latest,
            url: r.url,
            sizeMB: r.sizeMB,
            sha256: r.sha256,
            notes: r.notes
          }
        : { hasUpdate: false }
      if (r?.hasUpdate && latest) {
        updMsg.value = `发现新版本 ${latest}${r.sizeMB ? `（${r.sizeMB} MB）` : ''}`
      } else if (r?.available === false) {
        updErr.value = true
        updMsg.value = '暂时无法读取 Tauri 更新清单，请稍后重试'
      } else {
        updMsg.value = '已是最新版本'
      }
    } catch {

      updInfo.value = { hasUpdate: false }
      updErr.value = true
      updMsg.value = '检查更新失败，请稍后重试'
    } finally {
      checking.value = false
    }
  }

  async function doUpdate(): Promise<void> {
    const info = updInfo.value

    if (!info?.url || !info.version) {
      updErr.value = true
      updMsg.value = '这条更新信息不完整，暂时下不了 —— 过一会儿再点「检查更新」试试'
      return
    }
    downloading.value = true
    updPct.value = 0
    updMsg.value = ''
    try {
      const off = updApi().app?.onUpdateProgress?.((p) => {
        updPct.value = Math.max(0, Math.min(100, Math.round(p.percent)))
      })
      try {

        const saved = await updApi().app?.downloadUpdate?.({
          url: info.url,
          version: info.version,
          sha256: info.sha256,
          sizeMB: info.sizeMB
        })
        savedPath.value = saved ?? ''
        updMsg.value = saved ? '下载完成' : '未获得安装包路径'
        updInfo.value = { hasUpdate: false }
      } finally {
        off?.()
      }
    } catch (e) {
      updErr.value = true
      updMsg.value = `下载更新失败：${e instanceof Error ? e.message : String(e)}`
    } finally {
      downloading.value = false
    }
  }

  async function openSaved(): Promise<void> {
    const p = savedPath.value
    if (!p) return
    try {
      await updApi().shell?.showItem?.(p)
    } catch {
      try {
        await updApi().shell?.openPath?.(p)
      } catch {

      }
    }
  }

  async function skipVersion(): Promise<void> {
    const v = updInfo.value?.version
    if (!v) return
    await updApi().app?.skipVersion?.(v)
    updInfo.value = { hasUpdate: false }
    updMsg.value = `已跳过 ${v}，下个版本发布时会再次提醒`
  }

  const installingUpdate = ref(false)
  async function installUpdate(): Promise<void> {
    installingUpdate.value = true
    try {
      const api = updApi().app
      if (!api?.installUpdate) throw new Error('安装更新接口不可用')
      await api.installUpdate()
    }
    catch (e) { updErr.value = true; updMsg.value = `启动安装器失败：${e instanceof Error ? e.message : String(e)}` }
    finally { installingUpdate.value = false }
  }
  onMounted(async () => {
    try { currentVersion.value = (await updApi().app?.version?.()) ?? '未知' }
    catch { currentVersion.value = '未知' }
    try {
      const pending = await updApi().app?.pendingUpdate?.()
      if (pending) { savedPath.value = pending.path; updMsg.value = `${pending.version} 已下载，等待安装` }
    } catch (e) { updErr.value = true; updMsg.value = `已下载更新不可用：${e instanceof Error ? e.message : String(e)}` }
  })
  return { currentVersion, checking, updMsg, updErr, updPct, downloading, skipNote, savedPath, updInfo, checkUpdate, doUpdate, openSaved, skipVersion, installingUpdate, installUpdate }
}
