import { ref, computed, type Ref } from 'vue'
import { dlInvalidate } from '../dl-cache'
import type { LauncherApi, Mirror } from '../types/runtime-center'
export function useRuntimeRemoval(api: () => LauncherApi, { err, note, picking, reload, loadVersions }: {
    err: Ref<string>; note: Ref<string>; picking: Ref<Mirror | null>
    reload: () => Promise<void>; loadVersions: () => Promise<void>
  }) {
  const delTarget = ref<{ type: 'a' | 'n'; tag: string } | null>(null)

  /*
   * 点了「删除」时，先算出有哪些实例还在用这个版本，写进确认弹窗里。
   *
   * 为什么要在**删之前**算：删除本身现在允许执行（用户明确要求「改成可以删」），
   * 所以唯一的保护手段就是让用户看清后果再确认 —— 弹窗里必须写明白
   * 「这几个实例下次启动会失败」，而不是含糊地说「不受影响」。
   *
   * 属性名注意：实例接口返回的是 runtimeTag（运行时版本）。
   */

  const instancesOfType = ref<
    Array<{ id: string; name: string; type: 'a' | 'n'; runtimeTag?: string; status?: string }>
  >([])

  const delUsedBy = computed(() => {
    const t = delTarget.value
    if (!t) return []
    return instancesOfType.value
      .filter((i) => i.type === t.type && i.runtimeTag === t.tag)
      .map((i) => i.name)
  })


  const delRunning = computed(() => {
    const t = delTarget.value
    if (!t) return []
    return instancesOfType.value
      .filter((i) => i.type === t.type && i.runtimeTag === t.tag && i.status === 'running')
      .map((i) => i.name)
  })

  async function askRemove(type: 'a' | 'n', tag: string): Promise<void> {
    // 每次弹确认前刷一遍实例列表，避免拿旧数据吓人或漏报
    try {
      instancesOfType.value = (await api().instance?.list?.()) ?? []
    } catch {
      instancesOfType.value = []
    }
    // 上一次删除留下的提示不该跟着这一次显示
    note.value = ''
    delTarget.value = { type, tag }
  }

  async function doRemove(): Promise<void> {
    const t = delTarget.value
    if (!t) return
    err.value = ''
    try {
      const r = await api().runtimes?.remove?.({ type: t.type, tag: t.tag })
      delTarget.value = null
      /*
       * ★ 写操作成功 → 主动失效缓存（指导书 2.3 明列的一条）
       *
       * 不失效的话：删掉 v4.18.19 之后立刻切走再回来，SWR 会先把
       * **缓存里那个已被删掉的版本**画出来（然后后台刷新再抹掉）——
       * 用户会看到"删了又回来"的假象，比空白更让人困惑。
       * 失效之后再进页就是全新拉取（主进程那边的磁盘缓存是另一层，不受影响）。
       */
      dlInvalidate()

      const unknown = (r as { unknownBinding?: string[] } | void)?.unknownBinding ?? []
      if (unknown.length) {
        note.value =
          `已经删掉 ${t.tag} 啦。注意哦：${unknown.join('、')} 的版本记录已经损坏，` +
          `没法确认它到底有没有在用这个版本呢 —— 请在实例卡片上重新选一次版本，` +
          `不然它下次启动可能会失败哦。`
      } else {
        note.value = ''
      }
      await reload()
      if (picking.value) await loadVersions()
    } catch (e) {
      err.value = e instanceof Error ? e.message : String(e)
      delTarget.value = null
    }
  }
  return { delTarget, delUsedBy, delRunning, askRemove, doRemove }
}
