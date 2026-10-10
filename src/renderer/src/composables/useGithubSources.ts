import { ref, computed, type Ref } from 'vue'
import { dlMarkProbed, dlSaveHealth, dlInvalidate } from '../dl-cache'
import type { LauncherApi, MirrorState } from '../types/runtime-center'
export function useGithubSources(api: () => LauncherApi, state: Ref<MirrorState | null>, err: Ref<string>, reload: () => Promise<void>) {
  const newLabel = ref('')
  const newBase = ref('')
  const newMode = ref<'proxy' | 'files'>('proxy')
  const showAdd = ref(false)

  const mirrors = computed(() => state.value?.mirrors ?? [])
  const githubMirrors = computed(() => mirrors.value.filter((m) => m.mode === 'proxy'))
  const mirrorHealth = ref<Map<string, { status: string; ms: number | null; reason?: string }>>(new Map())
  const testing = ref(false)
  async function probeMirrors(): Promise<void> {
    testing.value = true
    try {
      const rows = (await api().mirrors?.test?.()) ?? []
      const m = new Map<string, { status: string; ms: number | null; reason?: string }>()
      for (const r of rows) m.set(r.base, { status: r.status, ms: r.ms, reason: r.reason })
      mirrorHealth.value = m
      /*
       * 记下"刚探测过"的时刻 —— 进页面自动探测的 60s 节流就靠它
       *（dlProbeBlocked 读它）。不记的话每次进页面都重新打全部源，
       * 那就是主人抱怨的"每次点进去都要等"。
       */
      dlMarkProbed()
      /*
       * ★ 还要把**探测结果本身**写回快照（审计抓出的真问题）。
       *
       * 只记时刻是不够的：reload 总在探测之前跑，所以快照里的 health
       * 永远是空的。用户切走再回来（节流生效、不重测）→ 水合拿到空 health
       * → 那些"120ms / 可用"「N 个源不可用」整块消失，看着像功能时有时无。
       */
      dlSaveHealth([...m.entries()].map(([base, v]) => ({ base, ...v })))
      await autoPickFastest()
    } catch {
      /* 探测失败就当没测过，不打扰用户 */
    } finally {
      testing.value = false
    }
  }


  async function autoPickFastest(): Promise<void> {
    const alive = mirrors.value
      .map((m) => ({ base: m.base, info: mirrorHealth.value.get(m.base) }))
      .filter((x): x is { base: string; info: { status: string; ms: number | null } } => {
        return x.info?.status === 'ok' && typeof x.info.ms === 'number'
      })
      .sort((a, b) => (a.info.ms ?? 0) - (b.info.ms ?? 0))
    if (!alive.length) return
    const best = alive[0].base
    // 和当前一致就别多跑一次 IPC
    if (state.value?.pref.n === best) return
    try {
      state.value = (await api().mirrors?.pref?.({ n: best })) ?? state.value
    } catch {
      /* 设不上就维持原样，下载时仍会按顺序试 */
    }
  }


  function isSourceDown(
    h: { status: string } | undefined
  ): boolean {
    return h !== undefined && h.status !== 'ok'
  }


  function downHint(h: { status: string; ms?: number | null; reason?: string } | undefined, verb: string): string {
    if (!isSourceDown(h)) return ''
    const why = h?.reason?.trim()
    return why
      ? `这个源不可用：${why}\n换一个源，或点右上角「检测所有来源」重测`
      : `这个源检测到不可用，${verb}会失败 —— 换一个源，或点右上角「检测所有来源」重测`
  }

  /**
   * 不可用的自定义源：给用户一个「移除」。
   *
   * 「不可用」包括两种，**都算不可用**（这是之前判错的地方）：
   *   - unreachable：连不上/超时/HTTP 错误
   *   - empty：连得上，但源上根本没有版本清单（啥也下不到）
   * 内置官方源永远留着（hideBase，用户加不了）。
   */
  const deadMirrors = computed(() =>
    mirrors.value.filter((m) => {
      if (m.builtin) return false
      return isSourceDown(mirrorHealth.value.get(m.base))
    })
  )

  async function removeAllDead(): Promise<void> {
    for (const m of deadMirrors.value) {
      try {
        state.value = (await api().mirrors?.remove?.(m.base)) ?? state.value
      } catch {
        /* 单个删不掉就跳过 */
      }
    }
    await probeMirrors()
  }
  async function addMirror(): Promise<void> {
    err.value = ''
    if (!newBase.value.trim()) {
      err.value = '得先填镜像地址哦'
      return
    }
    try {
      state.value = (await api().mirrors?.add?.({
        label: newLabel.value.trim() || newBase.value.trim(),
        base: newBase.value.trim(),
        mode: newMode.value
      })) ?? state.value
      newLabel.value = ''
      newBase.value = ''
      showAdd.value = false
      /*
       * 加了源 → 快照失效（审计：这条原则原来只覆盖删除版本）。
       * 保留探测结果：新加的源在列表里但还没测过，用户切走再进来时
       * 旧源的可用性标签仍然有效，不该整块消失。
       */
      dlInvalidate({ keepProbe: true })
      await reload()
    } catch (e) {
      err.value = e instanceof Error ? e.message : String(e)
    }
  }

  async function removeMirror(base: string): Promise<void> {
    err.value = ''
    try {
      state.value = (await api().mirrors?.remove?.(base)) ?? state.value
      /* 删了源 → 失效（并清掉这个源的探测结果，它已经不在列表里了） */
      const next = new Map(mirrorHealth.value)
      next.delete(base)
      mirrorHealth.value = next
      dlInvalidate({ keepProbe: true })
      dlSaveHealth([...next.entries()].map(([b, v]) => ({ base: b, ...v })))
      await reload()
    } catch (e) {
      err.value = e instanceof Error ? e.message : String(e)
    }
  }
  return { newLabel, newBase, newMode, showAdd, mirrors, githubMirrors, mirrorHealth, testing, probeMirrors, isSourceDown, downHint, deadMirrors, removeAllDead, addMirror, removeMirror }
}
