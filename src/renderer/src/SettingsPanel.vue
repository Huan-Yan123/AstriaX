<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import AppIcon from './components/AppIcon.vue'
import { useAppUpdates } from './composables/useAppUpdates'
const { currentVersion, checking, updMsg, updErr, updPct, downloading, skipNote, savedPath, updInfo, checkUpdate, doUpdate, openSaved, skipVersion, installingUpdate, installUpdate } = useAppUpdates()

const props = defineProps<{ embedded?: boolean; section?: string; sidebarCollapsed?: boolean }>()
const settingsSearch = ref('')
const currentSection = ref(props.section || 'general')
watch(() => props.section, value => { if (value) currentSection.value = value })
const sections = [{ id: 'general', title: '常规' }, { id: 'updates', title: '应用更新' }, { id: 'storage', title: '存储' }, { id: 'diagnostics', title: '日志与反馈' }]
const matches = (text: string) => !settingsSearch.value.trim() || text.includes(settingsSearch.value.trim())
const visibleSections = computed(() => sections.filter(s => matches(s.title + ' ' + ({ general: '关闭行为 托盘 退出 每次询问', updates: '当前版本 检查更新 下载更新 安装', storage: '数据目录 迁移', diagnostics: '日志 反馈 问题 导出' }[s.id] || ''))))
const sectionTitle = computed(() => sections.find(s => s.id === currentSection.value)?.title || '常规')
function navigate(id: string): void { currentSection.value = id; emit('navigate', id) }
watch(settingsSearch, () => { if (visibleSections.value.length && !visibleSections.value.some(s => s.id === currentSection.value)) navigate(visibleSections.value[0].id) })

const emit = defineEmits<{ close: []; moved: []; navigate: [section: string] }>()

declare const window: {
  launcher?: {
    config?: {
      moving?: () => Promise<{ active: boolean; startedAt?: number; last?: { at: number; failed?: Array<{ item: string; reason: string }> } }>
      get: () => Promise<Record<string, unknown>>
      set: (p: unknown) => Promise<void>

      moveDataDir?: (
        target: string
      ) => Promise<{ movedCount: number; failed: Array<{ item: string; reason: string }> }>
    }

    dialog?: { pickDataDir?: () => Promise<string | null> }
    logs?: { exportZip?: () => Promise<string>; exportBusy?: () => Promise<boolean> }
  }
}

const dataRoot = ref('')
const exporting = ref(false)
const exportedPath = ref('')
const exportErr = ref('')
const closePolicy = ref<'tray' | 'quit' | 'ask'>('ask')
const policyError = ref('')

const OFFICIAL_GROUP = '1077554004'

const moving = ref(false)
const moveErr = ref('')
const moveNote = ref('')
const moveFailed = ref<Array<{ item: string; reason: string }>>([])

const moveStartedAt = ref(0)

const moveElapsedSec = ref(0)

let movePoll: ReturnType<typeof setInterval> | undefined
async function pollMoving(): Promise<void> {
  try {
    const s = await window.launcher?.config?.moving?.()
    const active = Boolean(s?.active)
    moving.value = active
    moveStartedAt.value = active ? Number(s?.startedAt ?? 0) : 0
    moveElapsedSec.value = active && moveStartedAt.value
      ? Math.max(0, Math.round((Date.now() - moveStartedAt.value) / 1000))
      : 0
    if (!active && moveStartedAt.value === 0) moveElapsedSec.value = 0

    const last = s?.last
    if (!active && last && last.at !== lastShownRelocateAt) {
      lastShownRelocateAt = last.at
      if (last.failed?.length) {
        moveFailed.value = last.failed
        moveNote.value = `上次搬家有 ${last.failed.length} 项没能搬过去（下面都列出来了）`
      }
    }
  } catch {

  }
}

let lastShownRelocateAt = 0
onMounted(() => {

  void pollMoving()
  movePoll = setInterval(() => void pollMoving(), 500)
})
onBeforeUnmount(() => {
  if (movePoll) clearInterval(movePoll)
  movePoll = undefined
})

async function moveDataDir(): Promise<void> {
  moveErr.value = ''
  moveNote.value = ''
  moveFailed.value = []

  if (moving.value) {
    moveErr.value = '上一次搬家还在进行中哦，等它搬完再试呀。'
    return
  }
  let target: string | null = null
  try {
    target = (await window.launcher?.dialog?.pickDataDir?.()) ?? null
  } catch (e) {
    moveErr.value = `目录选择框打不开呢：${e instanceof Error ? e.message : String(e)}`
    return
  }
  if (!target) return // 用户取消了

  moving.value = true
  try {
    const r = await window.launcher?.config?.moveDataDir?.(target)
    dataRoot.value = target
    const failed = r?.failed ?? []
    moveFailed.value = failed
    if (failed.length) {
      moveNote.value = `数据目录已经切到新位置啦，不过有 ${failed.length} 项没能搬过去（下面都列出来了）`
    } else {
      moveNote.value = '数据目录搬完啦，原来那个目录可以自己删掉哦~'
    }
    emit('moved')
  } catch (e) {
    moveErr.value = `迁移没能完成呢：${e instanceof Error ? e.message : String(e)}`
  } finally {
    moving.value = false
    void pollMoving()
  }
}

onMounted(async () => {
  const cfg = (await window.launcher?.config?.get()) ?? {}
  dataRoot.value = (cfg.dataRoot as string) ?? ''
  closePolicy.value = cfg.closePolicy === 'tray' || cfg.closePolicy === 'quit' ? cfg.closePolicy : 'ask'
})

async function setPolicy(p: 'tray' | 'quit' | 'ask'): Promise<void> {
  policyError.value = ''
  const previous = closePolicy.value
  closePolicy.value = p
  try { await window.launcher?.config?.set({ closePolicy: p }); closePolicy.value = p }
  catch (e) { closePolicy.value = previous; policyError.value = e instanceof Error ? e.message : String(e) }
}

async function exportLogs(): Promise<void> {
  exporting.value = true
  exportErr.value = ''
  try {
    exportedPath.value = (await window.launcher?.logs?.exportZip?.()) ?? ''
  } catch (e) {
    exportErr.value = String(e instanceof Error ? e.message : e)
  } finally {
    exporting.value = false
  }
}

let busyPoll: ReturnType<typeof setInterval> | undefined

function stopBusyPoll(): void {
  if (busyPoll) {
    clearInterval(busyPoll)
    busyPoll = undefined
  }
}

onMounted(() => {
  void (async () => {
    try {
      const busy = (await window.launcher?.logs?.exportBusy?.()) ?? false
      if (!busy) return

      exporting.value = true
      stopBusyPoll()
      busyPoll = setInterval(() => {
        void (async () => {
          try {
            const still = (await window.launcher?.logs?.exportBusy?.()) ?? false
            if (!still) {
              exporting.value = false
              stopBusyPoll()
            }
          } catch {

            exporting.value = false
            stopBusyPoll()
          }
        })()
      }, 1000)
    } catch {

    }
  })()
})

onBeforeUnmount(stopBusyPoll)
</script>

<template>
  <Teleport to="body" :disabled="embedded">
    <div class="settings-shell" :class="{ embedded, modal: !embedded }" @click.self="!embedded && emit('close')">
      <div class="panel" :class="{ 'sidebar-collapsed': sidebarCollapsed }">
        <aside v-if="!sidebarCollapsed" class="settings-nav">
          <h2><AppIcon name="settings" /> 设置</h2>
          <label class="settings-search"><AppIcon name="search" /><input v-model="settingsSearch" placeholder="搜索设置" aria-label="搜索设置" /></label>
          <p class="nav-label">应用</p>
          <button v-for="section in visibleSections" :key="section.id" class="section-link" :class="{ active: currentSection === section.id }" @click="navigate(section.id)"><AppIcon :name="section.id" />{{ section.title }}</button>
        </aside>
        <div class="settings-main">
          <nav v-if="sidebarCollapsed" class="compact-sections" aria-label="设置页面"><button v-for="section in sections" :key="section.id" class="section-link" :class="{ active: currentSection === section.id }" @click="navigate(section.id)"><AppIcon :name="section.id" />{{ section.title }}</button></nav>
          <p v-if="!visibleSections.length" class="hint">未找到匹配设置</p>
          <header><h1><AppIcon :name="currentSection" />{{ sectionTitle }}</h1><button class="close-settings" aria-label="关闭设置" @click="emit('close')"><AppIcon name="close" /></button></header>
          <section v-show="currentSection === 'general' && visibleSections.some(s => s.id === 'general')" id="settings-general">
            <h3><AppIcon name="general" />关闭行为</h3>
            <div class="card" role="radiogroup" aria-label="关闭行为">
              <label class="setting-row"><AppIcon name="tray" /><span><b>缩回托盘</b><small>关闭窗口后，实例继续运行。</small></span><input type="radio" name="closepolicy" :checked="closePolicy === 'tray'" @change="setPolicy('tray')" /></label>
              <label class="setting-row"><AppIcon name="quit" /><span><b>直接退出</b><small>退出前停止所有实例。</small></span><input type="radio" name="closepolicy" :checked="closePolicy === 'quit'" @change="setPolicy('quit')" /></label>
              <label class="setting-row"><AppIcon name="ask" /><span><b>每次询问</b><small>每次关闭窗口时选择缩回托盘或退出程序。</small></span><input type="radio" name="closepolicy" :checked="closePolicy === 'ask'" @change="setPolicy('ask')" /></label>
            </div>
            <p v-if="policyError" class="hint err" role="alert">{{ policyError }}</p>
          </section>
          <section v-show="currentSection === 'updates' && visibleSections.some(s => s.id === 'updates')" id="settings-updates">
            <h3><AppIcon name="updates" />应用更新</h3>
            <div class="card">
              <div class="setting-row"><AppIcon name="updates" /><span><b>当前版本</b><small>AstriaX {{ currentVersion }}</small></span><button class="pick" :disabled="checking || downloading" @click="checkUpdate(true)">{{ checking ? '检查中…' : '检查更新' }}</button></div>
              <p class="hint">更新来源：Soffd/AstriaX · GitHub Releases</p>
              <p v-if="updMsg" class="hint" :class="{ err: updErr }">{{ updMsg }}</p>
              <p v-if="updInfo?.hasUpdate && updInfo.notes" class="notes">{{ updInfo.notes }}</p>
              <div v-if="updInfo?.hasUpdate" class="actions"><button class="pick primary" :disabled="downloading" @click="doUpdate">{{ downloading ? `下载中 ${updPct}%` : '下载更新' }}</button><button class="pick" :disabled="downloading" @click="skipVersion">跳过这个版本</button></div>
              <p v-if="downloading && updPct === 0" class="hint">正在连接下载服务器…</p>
              <div v-if="savedPath" class="downloaded"><p class="path">{{ savedPath }}</p><div class="actions"><button class="pick primary" :disabled="installingUpdate" @click="installUpdate">{{ installingUpdate ? '正在退出…' : '退出并安装更新' }}</button><button class="pick" @click="openSaved">打开它所在的文件夹</button></div></div>
              <p v-if="skipNote" class="hint">{{ skipNote }}</p>
            </div>
          </section>
          <section v-show="currentSection === 'storage' && visibleSections.some(s => s.id === 'storage')" id="settings-storage">
            <h3><AppIcon name="storage" />存储</h3>
            <div class="card">
              <div class="setting-row"><AppIcon name="storage" /><span><b>数据目录</b><small class="path">{{ dataRoot || '（未设置）' }}</small></span><button class="pick" :disabled="moving" @click="moveDataDir">{{ moving ? '迁移中…' : '迁移目录' }}</button></div>
              <p class="hint">复制实例、运行时和日志到新位置，保留原目录。迁移期间请保持应用运行。</p>
              <p v-if="moving" class="hint">正在迁移，已用 {{ moveElapsedSec }} 秒</p>
              <p v-if="moveNote" class="hint">{{ moveNote }}</p><p v-if="moveErr" class="hint err">{{ moveErr }}</p>
              <ul v-if="moveFailed.length" class="faillist"><li v-for="(f, i) in moveFailed" :key="i"><b>{{ f.item }}</b> — {{ f.reason }}</li></ul>
            </div>
          </section>
          <section v-show="currentSection === 'diagnostics' && visibleSections.some(s => s.id === 'diagnostics')" id="settings-diagnostics">
            <h3><AppIcon name="diagnostics" />日志与反馈</h3>
            <div class="card">
              <div class="setting-row"><AppIcon name="diagnostics" /><span><b>日志</b><small>导出诊断信息，帮助定位问题。</small></span><button class="pick" :disabled="exporting" @click="exportLogs">{{ exporting ? '正在打包…' : '导出日志' }}</button></div>
              <p v-if="exportedPath" class="hint path">已生成：{{ exportedPath }}</p><p v-if="exportErr" class="hint err">{{ exportErr }}</p>
              <div class="setting-row"><AppIcon name="ask" /><span><b>问题反馈群</b><small>反馈问题时可附上导出的日志。</small></span><span class="qqnum">{{ OFFICIAL_GROUP }}</span></div>
            </div>
          </section>
        </div>
      </div>
    </div>
  </Teleport>
</template>
<style scoped src="./styles/SettingsPanel.css"></style>
