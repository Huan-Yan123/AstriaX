<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { stampPretty } from './util/stamp'

interface BackupItem {
  instanceId: string
  instanceName: string
  stamp: string
  version: string
  file: string
  sizeMB: number
  /** 这份备份所在的文件夹（每实例一个） */
  folder: string
}

/**
 * 覆盖更新时**安装器**自动打的整库备份。
 *
 * 和上面的 BackupItem 是两回事，所以单独一个类型、单独一个分区：
 *   - BackupItem：某个实例的运行时备份，用户手动点，可"回滚到这版"
 *   - UpdateBackupItem：整套用户数据（实例数据 + 配置）的快照，
 *     在覆盖更新前由安装器自动打，只供查看与手工取用
 *
 * 混在一起显示会让用户以为"更新备份也能一键回滚"，那是错的。
 */
interface UpdateBackupItem {
  stamp: string
  file: string
  sizeBytes: number
  mtimeMs: number
  hasPackage: boolean
}

declare const window: {
  launcher?: {
    backups?: {
      list?: () => Promise<{ items: BackupItem[]; folder: string }>
      del?: (file: string) => Promise<void>
      restore?: (args: { instanceId: string; file: string }) => Promise<void>
      openFolder?: (folder: string) => Promise<void>
      updateList?: () => Promise<{ items: UpdateBackupItem[]; folder: string }>
    }
    instance?: { stop?: (id: string) => Promise<void> }
  }
}

const items = ref<BackupItem[]>([])
/** 覆盖更新时安装器自动打的整库备份（只读展示） */
const updateItems = ref<UpdateBackupItem[]>([])
const updateFolder = ref('')
/**
 * 备份的存放位置（整台机器上一个根目录）。
 *
 * 用户问的是「备份文件夹在哪」，要的是**文件夹**，不是每条备份的完整路径 ——
 * 每条都列一遍完整路径既啰嗦又没多给信息（它们都在各自的实例目录下）。
 * 所以这里只显示一次根目录，每条备份只标自己的实例子目录名。
 */
const folder = ref('')
const loading = ref(false)
const busyName = ref('')
const confirmDel = ref<BackupItem | null>(null)
const errMsg = ref('')

/**
 * 备份文件名时间戳 → 可读时间（实现在 util/stamp.ts，便于单测）。
 * 见那里的注释：原来的硬切下标会把 20260912141734 显示成 42:14。
 */

async function load(): Promise<void> {
  loading.value = true
  errMsg.value = ''
  try {
    const r = await window.launcher?.backups?.list?.()
    // 兼容旧形态（直接返回数组）：那种情况下至少别把页面搞崩
    if (Array.isArray(r)) {
      items.value = r
      folder.value = r[0]?.folder ?? ''
    } else {
      items.value = r?.items ?? []
      folder.value = r?.folder ?? ''
    }
  } catch (e) {
    errMsg.value = String(e instanceof Error ? e.message : e)
  } finally {
    loading.value = false
  }
  /*
   * 自动备份单独取：它失败**不能**把上面那块也拖成错误状态
   * （老版本没有这个接口，或者目录读不了，都属于正常情况）。
   */
  try {
    const u = await window.launcher?.backups?.updateList?.()
    updateItems.value = u?.items ?? []
    updateFolder.value = u?.folder ?? ''
  } catch {
    updateItems.value = []
    updateFolder.value = ''
  }
}

/** 字节数 → 人类可读（备份包多在几 KB ~ 几 MB 之间） */
function prettySize(bytes: number): string {
  if (!bytes || bytes <= 0) return '空'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * 时间戳 `20260914-151447` → `2026-09-14 15:14`。
 *
 * 自己解析而不用 util/stamp.ts 的 stampPretty：那个是给**实例备份**
 * 用的，它的时间戳是 `20260912141734`（无分隔、14 位）这种形态。
 * 两者格式不同，硬套会把自动备份的时间显示错（这正是那个文件注释里
 * 记着的"硬切下标把时间显示成 42:14"那类 bug）。
 */
function prettyStamp(s: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(s)
  if (!m) return s
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`
}

/** 在资源管理器里打开备份文件夹 */
async function openFolder(): Promise<void> {
  try {
    await window.launcher?.backups?.openFolder?.(folder.value)
  } catch (e) {
    errMsg.value = String(e instanceof Error ? e.message : e)
  }
}

/**
 * 把完整路径裁成「相对备份根目录」的一小段，例如
 *   E:\...\data\instances\NapCat\n_abc\backups  →  NapCat\n_abc\backups
 * 这样卡片上一眼看得出是哪台实例的备份，又不会撑破版面。
 */
function instanceSubPath(p: string): string {
  if (!folder.value) return p
  const base = folder.value.endsWith('\\') || folder.value.endsWith('/') ? folder.value : folder.value + '\\'
  return p.startsWith(base) ? p.slice(base.length) : p
}

async function restore(b: BackupItem): Promise<void> {
  busyName.value = b.file
  try {
    // 停实例 → 恢复 → 刷新列表
    await window.launcher?.instance?.stop?.(b.instanceId)
    await window.launcher?.backups?.restore?.({ instanceId: b.instanceId, file: b.file })
    await load()
  } catch (e) {
    errMsg.value = String(e instanceof Error ? e.message : e)
  } finally {
    busyName.value = ''
  }
}

async function doDel(): Promise<void> {
  const b = confirmDel.value
  if (!b) return
  try {
    await window.launcher?.backups?.del?.(b.file)
    await load()
  } finally {
    confirmDel.value = null
  }
}

onMounted(load)
</script>

<template>
  <div class="page">
    <header class="topbar">
      <h1>备份</h1>
      <span class="hint">更新实例版本前会自动先留一份底哦</span>
      <button class="createbtn ghost2" @click="load">{{ loading ? '刷新中…' : '刷新一下' }}</button>
    </header>

    <!--
      备份文件夹位置：用户明确问过「备份文件夹在哪」。
      显示一个根目录 + 一个「打开」按钮，比每条备份列一遍完整路径有用得多。
    -->
    <section v-if="folder" class="folderbar">
      <span class="flabel">备份文件夹</span>
      <code class="fpath" :title="folder">{{ folder }}</code>
      <button class="mini" @click="openFolder">打开看看</button>
    </section>

    <!--
      覆盖更新自动备份：安装器在每次覆盖更新前打的整库数据快照。
      单独一个分区，因为它的用途和上面"实例备份"完全不同 ——
      这里不给"回滚"按钮（整库回滚不是这个页面的职责），只让用户看到、找到、打开。
    -->
    <section v-if="updateItems.length > 0" class="updblock">
      <header class="updhead">
        <b>覆盖更新前的自动备份</b>
        <span class="hint2">每次更新前都会自动打一份，只留最近几份哦</span>
      </header>
      <p class="updpath" :title="updateFolder">{{ updateFolder }}</p>
      <ul class="updlist">
        <li v-for="u in updateItems" :key="u.file">
          <span class="utime">{{ prettyStamp(u.stamp) }}</span>
          <span class="usize">{{ prettySize(u.sizeBytes) }}</span>
          <span v-if="!u.hasPackage" class="ubad">这个包里没有数据文件呢</span>
        </li>
      </ul>
    </section>

    <p v-if="errMsg" class="empty">{{ errMsg }}</p>
    <p v-else-if="items.length === 0 && !loading" class="empty">还没有备份呢。更新实例版本前会自动先留一份底哦~</p>

    <TransitionGroup v-else name="cardpop" tag="section" class="cards">
      <article v-for="b in items" :key="b.file" class="card">
        <header>
          <b>{{ stampPretty(b.stamp) }}</b>
          <span class="badge">v{{ b.version }}</span>
        </header>
        <p class="meta">{{ b.instanceName }} · {{ b.sizeMB }} MB</p>
        <!-- 每条只显示自己的实例子目录名，完整路径看上面的根目录 -->
        <p class="subpath" :title="b.folder">{{ instanceSubPath(b.folder) }}</p>
        <div class="actions2">
          <button class="main" :disabled="busyName !== ''" @click="restore(b)">{{ busyName === b.file ? '回滚中…' : '回滚到这一版' }}</button>
          <button class="ghost" :disabled="busyName !== ''" @click="confirmDel = b">删除</button>
        </div>
      </article>
    </TransitionGroup>

    <Teleport to="body">
      <div v-if="confirmDel" class="mask" @click.self="confirmDel = null">
        <div class="dlg confirm">
          <h2>真的要删除这份备份吗？</h2>
          <p class="warn2">{{ stampPretty(confirmDel.stamp) }} · {{ confirmDel.instanceName }} · {{ confirmDel.sizeMB }} MB。删除之后就再也找不回来了哦。</p>
          <div class="row">
            <button class="ghost" @click="confirmDel = null">取消</button>
            <button class="main danger" @click="doDel">删除</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
}
.topbar {
  display: flex;
  align-items: baseline;
  gap: 14px;
  margin-bottom: 18px;
}
.topbar h1 {
  margin: 0;
  font-size: 24px;
  letter-spacing: -0.025em;
}
.hint {
  color: var(--ink-soft);
  font-size: 12.5px;
}
.createbtn {
  margin-left: auto;
  border: 1px solid var(--hairline);
  border-radius: var(--radius-ctrl);
  background: #fff;
  padding: 8px 14px;
  color: var(--ink-soft);
  font-size: 13px;
  cursor: pointer;
}
.badge {
  padding: 3px 8px;
  border-radius: 6px;
  background: var(--primary-soft);
  color: var(--primary-deep);
  font-size: 11px;
  font-weight: 600;
}
.card {
  display: grid;
  grid-template-columns: minmax(160px, 1fr) minmax(140px, 0.8fr) minmax(160px, 1.3fr) auto;
  align-items: center;
  gap: 8px 18px;
  background: transparent;
  border: 0;
  border-bottom: 1px solid var(--hairline);
  border-radius: 0;
  padding: 14px 8px;
}
.empty {
  padding: 28px 8px;
  color: var(--ink-soft);
  border-bottom: 1px solid var(--hairline);
}
.card header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 0;
  min-width: 0;
}
.meta {
  color: var(--ink-soft);
  font-size: 12.5px;
  margin: 0;
}
.actions2 {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
.cards {
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--hairline);
}
.ghost2 {
  background: #fff;
  border: 1px solid var(--hairline);
}
/* 备份文件夹位置条：一行根目录 + 打开按钮 */
.folderbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  margin-bottom: 14px;
  border: 0;
  border-bottom: 1px solid var(--hairline);
  border-radius: 0;
  background: transparent;
}
.flabel {
  flex: none;
  font-size: 12px;
  color: var(--ink-soft);
}
.fpath {
  flex: 1;
  min-width: 0;
  font: 12px/1.5 'JetBrains Mono', Consolas, monospace;
  color: var(--ink);
  /* 路径太长时尾部省略（Windows 路径的关键信息通常在前半段） */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
}
/* 覆盖更新自动备份分区：和实例备份卡片视觉上区分开（更淡、更紧凑） */
.updblock {
  border: 0;
  border-block: 1px solid var(--hairline);
  border-radius: 0;
  background: transparent;
  padding: 14px 8px;
  margin-bottom: 16px;
}
.updhead {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 8px;
}
.hint2 {
  font-size: 12px;
  color: var(--ink-soft);
}
.updpath {
  margin: 0 0 10px;
  font: 11.5px/1.5 'JetBrains Mono', Consolas, monospace;
  color: var(--ink-soft);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.updlist {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.updlist li {
  display: flex;
  align-items: baseline;
  gap: 12px;
  font-size: 13px;
}
.utime {
  font: 12.5px/1.5 'JetBrains Mono', Consolas, monospace;
  color: var(--ink);
}
.usize {
  font-size: 12px;
  color: var(--ink-soft);
}
.ubad {
  font-size: 12px;
  color: var(--ribbon-error);
}
/* 卡片里的实例子路径：小一号、次要色 */
.subpath {
  margin: 0;
  font: 11.5px/1.5 'JetBrains Mono', Consolas, monospace;
  color: var(--ink-soft);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mask {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 18px;
  background: rgba(24, 39, 65, 0.25);
  -webkit-backdrop-filter: blur(10px) saturate(125%);
  backdrop-filter: blur(10px) saturate(125%);
}
.dlg.confirm {
  position: relative;
  isolation: isolate;
  width: min(440px, calc(100vw - 36px));
  padding: 22px 24px;
  border: 1px solid var(--glass-edge);
  border-radius: 20px;
  background: linear-gradient(145deg, rgba(255, 255, 255, 0.86), rgba(242, 247, 255, 0.72));
  -webkit-backdrop-filter: blur(28px) saturate(160%);
  backdrop-filter: blur(28px) saturate(160%);
  box-shadow: 0 24px 64px rgba(19, 37, 70, 0.24), inset 0 1px 0 rgba(255, 255, 255, 0.9);
}
.dlg.confirm h2 {
  margin: 0 0 10px;
  font-size: 18px;
}
.dlg.confirm .row {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 18px;
}
@media (max-width: 760px) {
  .card {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .card header,
  .subpath {
    grid-column: 1 / -1;
  }
  .actions2 {
    grid-column: 1 / -1;
    justify-content: flex-start;
  }
  .folderbar {
    flex-wrap: wrap;
  }
}
</style>
