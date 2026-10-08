<script setup lang="ts">
/**
 * 重构后的实例卡片组件
 * - 使用 Pinia store 管理状态
 * - 使用基础组件（AButton）
 * - 简化状态管理逻辑
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useInstanceStore } from './stores/instance'
import AButton from './components/base/AButton.vue'

export interface Instance {
  id: string
  name: string
  type: 'a' | 'n'
  status: string
  port: number
  memMB?: number
  runtimeVersion?: string
}

const props = withDefaults(
  defineProps<{
    inst: Instance
    tplReady?: boolean
  }>(),
  { tplReady: true }
)

const emit = defineEmits<{
  toggle: []
  webui: []
  del: []
  creds: []
  reset: []
  log: []
  version: []
  update: []
}>()

const instanceStore = useInstanceStore()
const menuOpen = ref(false)
const cardEl = ref<HTMLElement | null>(null)

// 从 store 获取状态
const isBusy = computed(() => instanceStore.isBusy(props.inst.id))
const isUpdating = computed(() => instanceStore.isUpdating(props.inst.id))
const switchingState = computed(() => instanceStore.getSwitchingState(props.inst.id))

// 菜单自动收起
function onDocPointerDown(e: MouseEvent): void {
  if (!menuOpen.value) return
  const el = cardEl.value
  if (el && e.target instanceof Node && el.contains(e.target)) return
  menuOpen.value = false
}

onMounted(() => document.addEventListener('pointerdown', onDocPointerDown, true))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocPointerDown, true))

// 计算属性
const canToggle = computed(() => 
  !isBusy.value && 
  !isUpdating.value && 
  props.inst.status !== 'starting' && 
  props.inst.status !== 'stopping'
)

const webuiUsable = computed(() => 
  props.inst.port > 0 && 
  props.inst.status !== 'starting' && 
  props.inst.status !== 'stopping'
)

const toggleText = computed(() => {
  if (isUpdating.value) return '更新中…'
  if (switchingState.value === 'starting' || props.inst.status === 'starting') return '启动中…'
  if (switchingState.value === 'stopping') return '停止中…'
  return props.inst.status === 'running' ? '停止' : '启动'
})

const statusText = computed(() => {
  switch (props.inst.status) {
    case 'running': return '运行中'
    case 'starting': return '启动中'
    case 'stopping': return '停止中'
    case 'error': return '出错了'
    default: return '已停止'
  }
})

const statusClass = computed(() => {
  if (props.inst.status === 'running') return 'running'
  if (props.inst.status === 'error') return 'error'
  return 'stopped'
})

const canUpdate = computed(() => {
  if (isBusy.value || isUpdating.value) return false
  if (props.inst.status === 'running') return false
  if (!props.tplReady) return false
  return true
})

const updateTitle = computed(() => {
  if (!props.tplReady) return '需要先下载这个类型的运行时'
  if (props.inst.status === 'running') return '运行中不能更新（请先停止）'
  if (isBusy.value) return '实例忙碌中'
  return '更新到最新版'
})

const versionTitle = computed(() => {
  if (!props.tplReady) return '需要先下载这个类型的运行时'
  if (props.inst.status === 'running') return '运行中不能切换版本（请先停止）'
  if (isBusy.value) return '实例忙碌中'
  return '切换运行时版本'
})

const typeName = computed(() => props.inst.type === 'a' ? 'AstrBot' : 'NapCat')
</script>

<template>
  <div ref="cardEl" class="card" :class="statusClass">
    <div class="ribbon" :class="`ribbon--${statusClass}`">
      {{ statusText }}
    </div>

    <div class="info">
      <h3 class="name">{{ inst.name }}</h3>
      <div class="meta">
        <span class="type">{{ typeName }}</span>
        <span v-if="inst.runtimeVersion" class="version">{{ inst.runtimeVersion }}</span>
        <span v-else class="version unknown">版本未知</span>
        <span class="port">:{{ inst.port }}</span>
      </div>
    </div>

    <div class="actions">
      <AButton
        variant="main"
        size="small"
        :disabled="!canToggle"
        :loading="switchingState !== null"
        @click="emit('toggle')"
      >
        {{ toggleText }}
      </AButton>

      <AButton
        variant="ghost"
        size="small"
        :disabled="!webuiUsable"
        @click="emit('webui')"
      >
        WebUI
      </AButton>

      <button class="menu-btn" @click="menuOpen = !menuOpen">⋯</button>

      <Transition name="menupop">
        <div v-if="menuOpen" class="menu">
          <button @click="emit('creds')">查看凭据</button>
          <button 
            :disabled="!canUpdate"
            :title="updateTitle"
            @click="emit('update')"
          >
            一键更新
          </button>
          <button 
            :disabled="!canUpdate"
            :title="versionTitle"
            @click="emit('version')"
          >
            换版本
          </button>
          <button @click="emit('log')">查看日志</button>
          <button class="danger" @click="emit('reset')">重置数据</button>
          <button class="danger" @click="emit('del')">删除</button>
        </div>
      </Transition>
    </div>
  </div>
</template>

<style scoped>
.card {
  position: relative;
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 16px;
  padding: 18px 20px;
  background: var(--card-a);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-card);
  transition: all 0.2s ease;
}

.card:hover {
  border-color: var(--primary-soft);
  box-shadow: 0 4px 12px rgba(40, 88, 168, 0.08);
}

.ribbon {
  position: absolute;
  top: 0;
  left: 0;
  padding: 4px 12px;
  border-radius: var(--radius-card) 0 8px 0;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}

.ribbon--running {
  background: var(--ribbon-run);
  color: #fff;
}

.ribbon--stopped {
  background: var(--ribbon-stop);
  color: var(--ink-soft);
}

.ribbon--error {
  background: var(--ribbon-error);
  color: #fff;
}

.info {
  padding-top: 28px;
}

.name {
  margin: 0 0 6px;
  font-size: 16px;
  font-weight: 600;
  color: var(--ink);
}

.meta {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: var(--ink-soft);
}

.type {
  font-weight: 500;
}

.version.unknown {
  color: var(--danger);
  opacity: 0.7;
}

.port {
  font-family: 'Cascadia Code', 'SF Mono', Consolas, monospace;
  font-weight: 500;
}

.actions {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding-top: 28px;
  position: relative;
}

.menu-btn {
  padding: 6px 12px;
  border: 1px solid var(--hairline);
  background: #fff;
  border-radius: var(--radius-ctrl);
  font-size: 16px;
  line-height: 1;
  color: var(--ink-soft);
  cursor: pointer;
  transition: all 0.14s ease;
}

.menu-btn:hover {
  border-color: var(--primary);
  color: var(--primary-deep);
  background: var(--primary-soft);
}

.menu {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 4px;
  min-width: 140px;
  padding: 6px;
  background: var(--glass-panel);
  border: 1px solid var(--glass-edge);
  border-radius: var(--radius-ctrl);
  box-shadow: 0 8px 24px rgba(19, 37, 70, 0.18);
  backdrop-filter: blur(20px);
  z-index: 10;
}

.menu button {
  display: block;
  width: 100%;
  text-align: left;
  border: none;
  background: transparent;
  border-radius: 6px;
  padding: 8px 12px;
  color: var(--ink);
  font-size: 13px;
  cursor: pointer;
  transition: background 0.14s ease;
}

.menu button:hover:not(:disabled) {
  background: var(--primary-soft);
}

.menu button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.menu .danger {
  color: var(--danger);
}

.menu .danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--danger) 8%, transparent);
}

.menupop-enter-active,
.menupop-leave-active {
  transition: all 0.18s ease;
}

.menupop-enter-from,
.menupop-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}

@media (max-width: 720px) {
  .card {
    grid-template-columns: 1fr;
    gap: 12px;
  }
  
  .actions {
    grid-column: 1;
    flex-wrap: wrap;
  }
}
</style>
