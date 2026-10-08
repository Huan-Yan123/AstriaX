/**
 * 实例操作 Composable
 * 封装实例启停、创建、删除等操作
 */
import { useInstanceStore } from '../stores/instance'
import { useDialogStore } from '../stores/dialog'

export function useInstanceActions() {
  const instanceStore = useInstanceStore()
  const dialogStore = useDialogStore()

  function api() {
    return (window as any).launcher?.instance
  }

  async function refreshInstances(): Promise<void> {
    try {
      const list = await api()?.list()
      if (list) {
        instanceStore.setInstances(list)
      }
    } catch (e) {
      console.error('刷新实例列表失败:', e)
    }
  }

  async function toggleInstance(id: string): Promise<void> {
    const instance = instanceStore.instances.find(x => x.id === id)
    if (!instance || instanceStore.isBusy(id)) return

    const action = instance.status === 'running' ? 'stopping' : 'starting'
    
    instanceStore.setBusy(id, true)
    instanceStore.setSwitching(id, action)
    
    // 乐观更新
    instanceStore.updateInstanceStatus(id, action)

    try {
      if (action === 'stopping') {
        await api()?.stop(id)
      } else {
        await api()?.start(id)
      }
      await refreshInstances()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      
      // QQ 环境问题
      if (/QQ/.test(msg) && /(没有检测到|版本太低|读不出)/.test(msg)) {
        dialogStore.notify('需要先安装 QQ', msg, { feedback: true })
      } else {
        throw e
      }
      
      await refreshInstances()
    } finally {
      instanceStore.setBusy(id, false)
      instanceStore.setSwitching(id, null)
    }
  }

  async function createInstance(payload: {
    type: 'a' | 'n'
    name: string
    port?: number
    tag?: string
    qqAccount?: string
  }): Promise<void> {
    try {
      await api()?.create(payload)
      await refreshInstances()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      
      if (/QQ/.test(msg) && /(没有检测到|版本太低|读不出)/.test(msg)) {
        dialogStore.notify('需要先安装 QQ', msg, { feedback: true })
      } else {
        throw new Error(`创建失败: ${msg}`)
      }
    }
  }

  async function removeInstance(id: string): Promise<void> {
    await api()?.remove(id)
    instanceStore.removeInstance(id)
  }

  async function updateInstance(id: string): Promise<void> {
    const instance = instanceStore.instances.find(x => x.id === id)
    if (!instance) return

    instanceStore.setBusy(id, true)
    instanceStore.setUpdating(id, true)

    try {
      const updateApi = (window as any).launcher?.instance?.update
      if (!updateApi) {
        throw new Error('更新接口没接上')
      }

      const result = await updateApi(id)
      await refreshInstances()

      if (result.updated) {
        dialogStore.notify('更新好啦', `「${instance.name}」现在是 ${result.to ?? '最新版'}，数据和配置都保留了。`)
      } else if (result.reason) {
        dialogStore.notify('没有更新', result.reason)
      }
    } finally {
      instanceStore.setBusy(id, false)
      instanceStore.setUpdating(id, false)
    }
  }

  return {
    refreshInstances,
    toggleInstance,
    createInstance,
    removeInstance,
    updateInstance
  }
}
