import { ref, computed, watch, type Ref } from 'vue'
import type { LauncherApi, RuntimeVersion } from '../types/runtime-center'
export function useRuntimePip(api: () => LauncherApi, installedA: Ref<RuntimeVersion[]>) {
  const pipTag = ref('')
  const pipSpec = ref('')
  const pipBusy = ref(false)
  const pipMsg = ref('')
  const pipErr = ref('')

  /** 已装的 AstrBot 版本（下拉选项） */
  const pipTargets = computed(() => installedA.value.map((r) => r.tag))

  /*
   * 版本列表变化时校正选择：
   *   · 当前选的不在了（被删了 / 还没选）→ 落到第一个
   * 用 watch 而不是只在挂载时算一次 —— 用户可能刚在下面删掉一个版本。
   */
  watch(pipTargets, (list) => {
    if (!list.includes(pipTag.value)) pipTag.value = list[0] ?? ''
  }, { immediate: true })

  async function installPip(): Promise<void> {
    const spec = pipSpec.value.trim()
    if (!pipTag.value) {
      pipErr.value = '先选一个 AstrBot 版本'
      return
    }
    if (!spec) {
      pipErr.value = '先填要装的库名（比如 requests）'
      return
    }
    pipBusy.value = true
    pipErr.value = ''
    pipMsg.value = ''
    try {
      await api().runtimes?.installPip?.({ tag: pipTag.value, packageSpec: spec })
      pipMsg.value = `已给 AstrBot ${pipTag.value} 装好：${spec}`
      pipSpec.value = ''
    } catch (e) {
      /*
       * 主进程的报错里已经带了 pip 的原始输出（最后几行），
       * 直接展示 —— 用户拿这个去搜比我概括一句有用得多。
       */
      pipErr.value = e instanceof Error ? e.message : String(e)
    } finally {
      pipBusy.value = false
    }
  }
  return { pipTag, pipSpec, pipBusy, pipMsg, pipErr, pipTargets, installPip }
}
