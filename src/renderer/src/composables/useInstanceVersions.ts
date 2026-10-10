import type { Ref } from 'vue'
import type { Instance } from '../types/instance'
import type { useLauncherDialogs } from './useLauncherDialogs'

type Dialogs = ReturnType<typeof useLauncherDialogs>
interface Options {
  note: Dialogs['note']; choose: Dialogs['choose']; chooseOne: Dialogs['chooseOne']
  refresh: () => Promise<void>; refreshRuntimeState: () => Promise<void>
  busy: Ref<boolean>; updatingIds: Ref<Set<string>>
  markBusyId: (id: string, on: boolean) => void
}
export function useInstanceVersions(options: Options) {
  const { note, choose, chooseOne, refresh, refreshRuntimeState, busy, updatingIds, markBusyId } = options

  async function pickVersion(x: Instance): Promise<void> {
    const l = window as unknown as {
      launcher?: {
        runtimes?: { list?: () => Promise<Array<{ type: 'a' | 'n'; tag: string; sizeMB?: number }>> }
        instance?: {
          setRuntime?: (p: { id: string; tag: string; type: 'a' | 'n' }) => Promise<{
            changed: boolean
            from?: string
            to: string
            restarted?: boolean
            restartError?: string
          }>
        }
      }
    }


    let installed: Array<{ type: 'a' | 'n'; tag: string; sizeMB?: number }> = []
    try {
      installed = (await l.launcher?.runtimes?.list?.()) ?? []
    } catch (e) {
      note('读不到已安装的版本', e instanceof Error ? e.message : String(e))
      return
    }
    const mineInstalled = installed.filter((v) => v.type === x.type)

    if (!mineInstalled.length) {
      note(
        '还没有装过这个类型的版本',
        `请先到「下载」页安装一个 ${x.type === 'a' ? 'AstrBot' : 'NapCat'} 版本，装好之后这里就能切了。`
      )
      return
    }

    const current = x.runtimeTag
    /* 当前版本排第一（用户最常做的是"重装/切回当前"），其余按版本倒序 */
    const ordered = [...mineInstalled].sort((a, b) => {
      if (a.tag === current) return -1
      if (b.tag === current) return 1
      return cmpTagDesc(a.tag, b.tag)
    })

    /*
     * ★ 已装版本的数量**通常很少**（用户不会装几十个），所以不再截断。
     * 但仍然防一手：万一有人手动导入了几十个，弹窗会撑爆 ——
     * 留一个上限并如实说明（这是"防御性"而非"常态"）。
     */
    const MAX_OPTIONS = 30
    const shown = ordered.slice(0, MAX_OPTIONS)

    const sizes = shown.map((v) => v.sizeMB).filter((s): s is number => typeof s === 'number')
    const sizeVaries = new Set(sizes).size > 1

    const options = shown.map((v) => {
      const bits = [v.tag]
      if (sizeVaries && v.sizeMB) bits.push(`${v.sizeMB} MB`)
      return { text: bits.join('  '), value: v.tag, current: v.tag === current }
    })

    const running = x.status === 'running' || x.status === 'starting'
    const picked = await chooseOne(
      `「${x.name}」切换到哪个版本？`,
      /* 明确写出"只列已装的"—— 主人要求的标注 */
      `这里只显示**已经装好**的版本。` +
        `要装新版本，去「下载」页。\n` +
        `数据和配置都会保留。` +
        (running ? `\n切换会先停掉实例，完成后自动重启。` : ''),
      options
    )
    if (!picked) return
    const tag = picked

    if (!l.launcher?.instance?.setRuntime) {
      note('暂时切换不了', '切换版本的接口没接上。')
      return
    }
    try {
      const r = await l.launcher.instance.setRuntime({ id: x.id, tag, type: x.type })
      await refresh()
      await refreshRuntimeState()
      if (r.restartError) {
        /*
         * 版本已经切好了，只是没能自动启动 —— 这两件事必须分开说。
         * 混在一起会让用户以为切换失败了，然后去重复操作。
         */
        note(
          `已切到 ${r.to}，但没能自动启动`,
          `版本切换成功，数据与配置都保留着。启动失败的原因：\n${r.restartError}`
        )
      } else if (r.changed) {
        note('版本已切换', `「${x.name}」现在是 ${r.to}，数据和配置都保留了。`)
      }
    } catch (e) {
      note('切换版本失败', e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * 版本号倒序比较（新的在前）。
   *
   * 为什么自己写而不是用现成的：渲染层拿不到主进程的 `cmpVersion`
   *（那是主进程模块）。而这里只需要"把标签按版本从新到旧排"，
   * 三段的数字比较足够了。认不出来的（如 `imported-xxx`）排最后，
   * 它们不是真版本号，排在前面会干扰用户。
   */
  function cmpTagDesc(a: string, b: string): number {
    const num = (t: string): number[] | undefined => {
      const m = t.match(/v?(\d+)\.(\d+)\.(\d+)/)
      if (!m) return undefined
      return [Number(m[1]), Number(m[2]), Number(m[3])]
    }
    const na = num(a)
    const nb = num(b)
    if (!na && !nb) return a.localeCompare(b)
    if (!na) return 1 // 认不出的排后面
    if (!nb) return -1
    for (let i = 0; i < 3; i++) {
      if (na[i] !== nb[i]) return nb[i] - na[i] // 倒序
    }
    return 0
  }


  async function updateInstance(x: Instance): Promise<void> {
    /*
     * 运行中直接拦下并说清怎么办。
     *
     * 界面上那个菜单项已经 disabled 了，但这里再拦一道：
     * 状态可能刚变化（用户在别处点了启动），而且按钮的 disabled
     * 不该是唯一的防线。
     */
    if (x.status === 'running' || x.status === 'starting') {
      note(
        '它正在运行哦',
        `更新要先装好新版本，而 ${x.type === 'a' ? 'AstrBot' : 'NapCat'} 在运行时` +
          `会占着旧版本的文件（Windows 会锁住），所以请先点「停止」再更新呀。`
      )
      return
    }

    const l = window as unknown as {
      launcher?: {
        instance?: {
          update?: (id: string) => Promise<{
            updated: boolean
            from?: string
            to?: string
            reason?: string
          }>
        }
      }
    }
    if (!l.launcher?.instance?.update) {
      note('暂时更新不了', '更新接口没接上。')
      return
    }

    const yes = await choose(
      `把「${x.name}」更新到最新版？`,
      '会先去网上取最新版本；需要下载并安装依赖，可能要几分钟。\n\n' +
        '你的实例数据、配置和登录状态都会完整保留，只更换运行时版本。\n\n' +
        '前提：它必须是停止状态（现在已经是了）。',
      '开始更新',
      '先不更新'
    )
    if (!yes) return

    busy.value = true

    markBusyId(x.id, true)
    updatingIds.value = new Set([...updatingIds.value, x.id])
    try {
      const r = await l.launcher.instance.update(x.id)
      await refresh()
      await refreshRuntimeState()

      if (r.updated) {
        note('更新好啦', `「${x.name}」现在是 ${r.to ?? '最新版'}，数据和配置都保留了。`)
        return
      }

      /*
       * 没更新也要**说清为什么** —— 三种情况差别很大：
       *   · 本来就是最新（好消息，不该像报错）
       *   · 安装期间实例被启动了（用户操作导致，要告诉他再点一次）
       *   · 主进程给了别的原因
       */
      note('没有更新', r.reason ?? '已经是最新版本啦。')
    } catch (e) {
      note('更新失败', e instanceof Error ? e.message : String(e))
    } finally {
      busy.value = false
      /* ★ 失败也要解锁，否则这张卡片永久不能用启动/停止了 */
      markBusyId(x.id, false)
      const next = new Set(updatingIds.value)
      next.delete(x.id)
      updatingIds.value = next
    }
  }
  return { pickVersion, updateInstance }
}
