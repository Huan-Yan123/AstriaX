import type { useLauncherDialogs } from './useLauncherDialogs'
type Dialogs = ReturnType<typeof useLauncherDialogs>
export function useStartupPrompts({ choose, note }: { choose: Dialogs['choose']; note: Dialogs['note'] }) {
  async function silentCheckUpdate(): Promise<void> {
    try {
      const api = window.launcher as unknown as {
        app?: {
          version?: () => Promise<string>
          checkUpdate?: (p?: { force?: boolean }) => Promise<{
            hasUpdate: boolean
            currentVersion?: string
            latestVersion?: string
            url?: string
            sizeMB?: number
            sha256?: string
          }>
          downloadUpdate?: (p: { url: string; version: string; sha256?: string }) => Promise<string>
        }
      }
      const r = await api?.app?.checkUpdate?.()
      if (!r?.hasUpdate) return

      const ver = r.latestVersion ?? ''
      const size = r.sizeMB ? `（${r.sizeMB} MB）` : ''
      const cur = r.currentVersion ?? ''
      // 有新版：问要不要现在下载。下载的只是安装包，装不装由用户自己决定
      const go = await choose(
        `发现新版本 ${ver}`,
        `当前 ${cur || '旧版本'}，新版本 ${ver}${size}。\n\n` +
          '下载后会保存到系统「下载」文件夹，双击那个安装包即可完成更新。',
        '下载',
        '以后再说'
      )
      if (!go || !r.url) return

      try {
        const saved = await api?.app?.downloadUpdate?.({ url: r.url, version: ver, sha256: r.sha256 })
        note('已下载更新包', saved ? `保存在：${saved}\n双击它即可完成更新。` : '下载完成。')
      } catch (e) {
        note('下载更新失败', e instanceof Error ? e.message : String(e))
      }
    } catch {
      /* 静默检查：任何失败都不打扰用户（用户要求失败时当作最新版） */
    }
  }
  async function askExportAfterCrash(): Promise<void> {
    try {
      const l = window as unknown as {
        launcher?: {
          app?: { lastCrash?: () => Promise<{ crashed: boolean; startedAt?: number }> }
          logs?: { exportZip?: () => Promise<string> }
        }
      }
      const info = await l.launcher?.app?.lastCrash?.()
      if (!info?.crashed) return
      const when = info.startedAt ? new Date(info.startedAt).toLocaleString() : '（时间读不出）'
      const want = await choose(
        '上次好像没有正常退出呢',
        `软件上次是**异常结束**的（启动于 ${when}），没来得及走完退出流程。\n\n` +
          '上次会话标记与现有实例、操作日志可以导出。\n' +
          '要现在导出一份诊断日志吗？以后出问题把它发我，我就能查。',
        '导出诊断日志',
        '先不用啦',
        /* 崩溃后导出日志 = 用户正要找人帮忙，联系方式放这里最有用 */
        { feedback: true }
      )
      if (!want) return
      const p = await l.launcher?.logs?.exportZip?.()
      if (p) note('日志已导出', `诊断日志打包好啦：\n${p}`)
    } catch {
      /* 提示本身失败绝不该影响启动 */
    }
  }
  return { silentCheckUpdate, askExportAfterCrash }
}
