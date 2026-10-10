import { ref, computed, type Ref } from 'vue'
import type { LauncherApi, RuntimeVersion, ImportProbe } from '../types/runtime-center'
export function useRuntimeImport(api: () => LauncherApi, installedA: Ref<RuntimeVersion[]>, installedN: Ref<RuntimeVersion[]>, reload: () => Promise<void>) {
  const impFile = ref('')
  const impBusy = ref(false)
  const impErr = ref('')
  const impMsg = ref('')
  const impVersion = ref('')

  const impProbe = ref<ImportProbe | null>(null)

  /** 当前页面在哪个类型（AstrBot / NapCat），导入时用它判断包类型对不对 */
  const impType = computed<'a' | 'n'>(() => (installedN.value.length && !installedA.value.length ? 'n' : 'a'))
  async function pickImport(): Promise<void> {
    impErr.value = ''
    impMsg.value = ''
    impProbe.value = null
    try {
      const file = (await api().runtimes?.pickFile?.()) as string | null | undefined
      if (!file) return // 用户取消了
      impFile.value = file
      impBusy.value = true
      const p = await api().runtimes?.probeFile?.(file)
      impProbe.value = p ?? null
      // 能识别就先把版本号填上，用户少打一次字
      if (p?.version) impVersion.value = p.version
    } catch (e) {
      impErr.value = e instanceof Error ? e.message : String(e)
    } finally {
      impBusy.value = false
    }
  }

  async function doImport(): Promise<void> {
    if (!impFile.value) return
    impErr.value = ''
    impMsg.value = ''
    impBusy.value = true
    try {
      const r = (await api().runtimes?.importFile?.({
        type: impProbe.value?.kind ?? impType.value,
        file: impFile.value,
        version: impVersion.value
      })) as { tag?: string; depsOk?: boolean } | undefined

      if (r?.depsOk === false) {

        impErr.value =
          `导入完成，但依赖没装上，这个版本启动会失败。\n` +
          `把「必要运行组件」里的 Python 装好，再导入一次这个文件就行。`
        impMsg.value = ''
      } else {
        impMsg.value = `装好啦 ${r?.tag ?? impVersion.value}~`
      }
      impProbe.value = null
      impFile.value = ''
      impVersion.value = ''
      await reload()
    } catch (e) {
      impErr.value = e instanceof Error ? e.message : String(e)
    } finally {
      impBusy.value = false
    }
  }
  return { impFile, impBusy, impErr, impMsg, impVersion, impProbe, impType, pickImport, doImport }
}
