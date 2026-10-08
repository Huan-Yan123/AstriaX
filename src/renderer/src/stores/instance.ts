/**
 * 实例管理 Store
 * 替换 App.vue 中的实例状态管理
 */
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export interface Instance {
  id: string
  name: string
  type: 'a' | 'n'
  status: string
  port: number
  memMB?: number
  runtimeVersion?: string
  runtimeTag?: string
}

export const useInstanceStore = defineStore('instance', () => {
  // 状态
  const instances = ref<Instance[]>([])
  const busyIds = ref<Set<string>>(new Set())
  const updatingIds = ref<Set<string>>(new Set())
  const switching = ref<Map<string, 'starting' | 'stopping'>>(new Map())

  // 计算属性
  const astrBotInstances = computed(() => instances.value.filter(x => x.type === 'a'))
  const napCatInstances = computed(() => instances.value.filter(x => x.type === 'n'))
  
  function isBusy(id: string): boolean {
    return busyIds.value.has(id)
  }
  
  function isUpdating(id: string): boolean {
    return updatingIds.value.has(id)
  }
  
  function getSwitchingState(id: string): 'starting' | 'stopping' | null {
    return switching.value.get(id) ?? null
  }

  // 动作
  function setInstances(list: Instance[]): void {
    instances.value = list
  }

  function setBusy(id: string, busy: boolean): void {
    const next = new Set(busyIds.value)
    if (busy) next.add(id)
    else next.delete(id)
    busyIds.value = next
  }

  function setUpdating(id: string, updating: boolean): void {
    const next = new Set(updatingIds.value)
    if (updating) next.add(id)
    else next.delete(id)
    updatingIds.value = next
  }

  function setSwitching(id: string, state: 'starting' | 'stopping' | null): void {
    const next = new Map(switching.value)
    if (state === null) next.delete(id)
    else next.set(id, state)
    switching.value = next
  }

  function updateInstanceStatus(id: string, status: string): void {
    instances.value = instances.value.map(inst =>
      inst.id === id ? { ...inst, status } : inst
    )
  }

  function addInstance(instance: Instance): void {
    instances.value.push(instance)
  }

  function removeInstance(id: string): void {
    instances.value = instances.value.filter(inst => inst.id !== id)
  }

  return {
    // 状态
    instances,
    busyIds,
    updatingIds,
    switching,
    // 计算属性
    astrBotInstances,
    napCatInstances,
    // 查询方法
    isBusy,
    isUpdating,
    getSwitchingState,
    // 动作
    setInstances,
    setBusy,
    setUpdating,
    setSwitching,
    updateInstanceStatus,
    addInstance,
    removeInstance
  }
})
