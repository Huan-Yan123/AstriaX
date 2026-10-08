/**
 * 虚拟滚动列表组件
 * 优化大量实例时的渲染性能
 */
<script setup lang="ts" generic="T">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'

interface VirtualListProps {
  /** 数据源 */
  items: T[]
  /** 单项高度（像素） */
  itemHeight: number
  /** 可见区域高度（像素） */
  height?: number
  /** 缓冲区项数（上下各多渲染几项） */
  buffer?: number
}

const props = withDefaults(defineProps<VirtualListProps>(), {
  height: 600,
  buffer: 3
})

const scrollTop = ref(0)
const containerRef = ref<HTMLElement | null>(null)

// 计算可见范围
const visibleRange = computed(() => {
  const start = Math.floor(scrollTop.value / props.itemHeight)
  const visibleCount = Math.ceil(props.height / props.itemHeight)
  const bufferedStart = Math.max(0, start - props.buffer)
  const bufferedEnd = Math.min(
    props.items.length,
    start + visibleCount + props.buffer
  )
  
  return {
    start: bufferedStart,
    end: bufferedEnd,
    offsetY: bufferedStart * props.itemHeight
  }
})

// 可见项
const visibleItems = computed(() => {
  return props.items.slice(visibleRange.value.start, visibleRange.value.end)
})

// 总高度
const totalHeight = computed(() => props.items.length * props.itemHeight)

// 滚动处理（节流）
let rafId: number | null = null
function handleScroll(e: Event): void {
  if (rafId !== null) return
  
  rafId = requestAnimationFrame(() => {
    scrollTop.value = (e.target as HTMLElement).scrollTop
    rafId = null
  })
}

onMounted(() => {
  containerRef.value?.addEventListener('scroll', handleScroll, { passive: true })
})

onBeforeUnmount(() => {
  containerRef.value?.removeEventListener('scroll', handleScroll)
  if (rafId !== null) {
    cancelAnimationFrame(rafId)
  }
})
</script>

<template>
  <div 
    ref="containerRef" 
    class="virtual-list" 
    :style="{ height: `${height}px` }"
  >
    <div class="virtual-list__spacer" :style="{ height: `${totalHeight}px` }">
      <div 
        class="virtual-list__content"
        :style="{ transform: `translateY(${visibleRange.offsetY}px)` }"
      >
        <div
          v-for="(item, index) in visibleItems"
          :key="visibleRange.start + index"
          class="virtual-list__item"
          :style="{ height: `${itemHeight}px` }"
        >
          <slot :item="item" :index="visibleRange.start + index" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.virtual-list {
  overflow-y: auto;
  overflow-x: hidden;
}

.virtual-list__spacer {
  position: relative;
  width: 100%;
}

.virtual-list__content {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  will-change: transform;
}

.virtual-list__item {
  overflow: hidden;
}
</style>
