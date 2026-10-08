/**
 * UI 状态 Store
 * 管理全局 UI 状态（页面、弹窗、加载等）
 */
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export const useUIStore = defineStore('ui', () => {
  // 页面状态
  const currentPage = ref<'a' | 'n' | 'download'>('a')
  const wizardOpen = ref(false)
  const settingsOpen = ref(false)
  const firstRun = ref<boolean | null>(null)

  // 全局加载
  const globalBusy = ref(false)
  const bootError = ref('')

  // WebUI 状态
  const webuiOpen = ref<Set<string>>(new Set())
  const webuiVisible = ref<string | undefined>(undefined)
  const webuiBusy = ref<Set<string>>(new Set())

  // 日志浮层
  const logView = ref<{ id: string; name: string; text: string } | null>(null)

  // 运行时状态
  const runtimeReady = ref<{ a: boolean; n: boolean }>({ a: false, n: false })

  // 计算属性
  const isFirstRun = computed(() => firstRun.value === true)
  const isLoading = computed(() => firstRun.value === null)

  // 动作
  function setPage(page: 'a' | 'n' | 'download'): void {
    currentPage.value = page
  }

  function openWizard(): void {
    wizardOpen.value = true
  }

  function closeWizard(): void {
    wizardOpen.value = false
  }

  function openSettings(): void {
    settingsOpen.value = true
  }

  function closeSettings(): void {
    settingsOpen.value = false
  }

  function setFirstRun(value: boolean | null): void {
    firstRun.value = value
  }

  function setGlobalBusy(busy: boolean): void {
    globalBusy.value = busy
  }

  function setBootError(error: string): void {
    bootError.value = error
  }

  function setWebuiOpen(ids: Set<string>): void {
    webuiOpen.value = ids
  }

  function setWebuiVisible(id: string | undefined): void {
    webuiVisible.value = id
  }

  function addWebuiBusy(id: string): void {
    webuiBusy.value = new Set(webuiBusy.value).add(id)
  }

  function removeWebuiBusy(id: string): void {
    const next = new Set(webuiBusy.value)
    next.delete(id)
    webuiBusy.value = next
  }

  function setLogView(view: { id: string; name: string; text: string } | null): void {
    logView.value = view
  }

  function setRuntimeReady(type: 'a' | 'n', ready: boolean): void {
    runtimeReady.value = { ...runtimeReady.value, [type]: ready }
  }

  return {
    // 状态
    currentPage,
    wizardOpen,
    settingsOpen,
    firstRun,
    globalBusy,
    bootError,
    webuiOpen,
    webuiVisible,
    webuiBusy,
    logView,
    runtimeReady,
    // 计算属性
    isFirstRun,
    isLoading,
    // 动作
    setPage,
    openWizard,
    closeWizard,
    openSettings,
    closeSettings,
    setFirstRun,
    setGlobalBusy,
    setBootError,
    setWebuiOpen,
    setWebuiVisible,
    addWebuiBusy,
    removeWebuiBusy,
    setLogView,
    setRuntimeReady
  }
})
