import { ref, type Ref } from 'vue'
export function usePythonSources(err: Ref<string>) {
  interface PySourceItem {
    label: string
    indexUrl: string
    note?: string
    builtin?: boolean
  }
  const pySources = ref<{ sources: PySourceItem[]; pref: string; active?: PySourceItem }>({
    sources: [],
    pref: ''
  })
  const pyActive = ref('')

  /**
   * Python 源的实测延迟（与 `mirrorHealth` 对称）。
   *
   * 主人 2026-09-27：「加入和 github 一样的测通断」。
   * key 用 indexUrl（渲染层的 v-for 也是按它做 key）。
   */
  const pyHealth = ref<Map<string, { status: string; ms: number | null; reason?: string }>>(
    new Map()
  )

  /** 探测所有 Python 源的通断与延迟（与 probeMirrors 同一形态） */
  async function probePySources(): Promise<void> {
    try {
      const l = window as unknown as {
        launcher?: {
          pysrc?: {
            test?: () => Promise<Array<{ indexUrl: string; status: string; ms: number | null; reason?: string }>>
          }
        }
      }
      const rows = (await l.launcher?.pysrc?.test?.()) ?? []
      const m = new Map<string, { status: string; ms: number | null; reason?: string }>()
      for (const r of rows) m.set(r.indexUrl, { status: r.status, ms: r.ms, reason: r.reason })
      pyHealth.value = m
    } catch {
      /* 探测失败就当没测过，不打扰用户（与 GitHub 源一致） */
    }
  }

  /**
   * 一次重测**两边**的源（GitHub 源 + Python 源）。
   *
   * 为什么要有这个：界面上只有「重新检测」一个按钮，用户在心理上认为
   * 它测的是"所有源"。原来只测 GitHub 那半边，Python 源的徽章会停在
   * 进页面时的旧值 —— 用户点了检测却发现那一栏没变化，看着像坏了。
   */
  async function loadPySources(): Promise<void> {
    try {
      const l = window as unknown as {
        launcher?: {
          pysrc?: { state?: () => Promise<{ sources: PySourceItem[]; pref: string; active?: PySourceItem }> }
        }
      }
      const st = await l.launcher?.pysrc?.state?.()
      if (st) {
        pySources.value = st
        pyActive.value = st.active?.label ?? ''
      }
    } catch {
      /* 读不到就不显示 Python 源那一栏（不该让整页报错） */
    }
  }
  async function removePySource(indexUrl: string): Promise<void> {
    try {
      const l = window as unknown as {
        launcher?: {
          pysrc?: {
            remove?: (v: string) => Promise<{ sources: PySourceItem[]; pref: string; active?: PySourceItem }>
          }
        }
      }
      const st = await l.launcher?.pysrc?.remove?.(indexUrl)
      if (st) {
        pySources.value = st
        pyActive.value = st.active?.label ?? ''
      }
    } catch (e) {

      err.value = `删除 Python 源失败：${e instanceof Error ? e.message : String(e)}`
    }
  }
  return { pySources, pyActive, pyHealth, probePySources, loadPySources, removePySource }
}
