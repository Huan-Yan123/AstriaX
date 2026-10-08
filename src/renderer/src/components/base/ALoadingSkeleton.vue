<script setup lang="ts">
/**
 * 骨架屏加载组件
 */
export interface SkeletonProps {
  /** 骨架屏类型 */
  type?: 'card' | 'text' | 'circle'
  /** 高度 */
  height?: string
  /** 宽度 */
  width?: string
  /** 数量（重复渲染） */
  count?: number
}

const props = withDefaults(defineProps<SkeletonProps>(), {
  type: 'text',
  height: '16px',
  width: '100%',
  count: 1
})
</script>

<template>
  <div class="skeleton-wrapper">
    <div
      v-for="i in count"
      :key="i"
      class="skeleton"
      :class="`skeleton--${type}`"
      :style="{ height, width }"
    />
  </div>
</template>

<style scoped>
.skeleton-wrapper {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.skeleton {
  background: linear-gradient(
    90deg,
    var(--card-n) 0%,
    var(--primary-soft) 50%,
    var(--card-n) 100%
  );
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
  border-radius: 8px;
}

.skeleton--card {
  height: 120px;
  border-radius: var(--radius-card);
}

.skeleton--circle {
  /*
   * ★ 这里原来写的是 `width: var(--size, 40px)` / `height: var(--size, 40px)`。
   *
   * 问题：`--size` **从来没有被任何调用方设置过**，也没在 tokens.css 里定义 ——
   * 于是它永远走回退值 40px，那个"可配置直径"其实是个**假接口**。
   * 而且 css-tokens 守卫会（正确地）把它报成"用了未定义的变量"：
   * 一个不存在的入参，比一个写死的值更糟 —— 下一个人会以为它可配。
   *
   * 现在直接用组件本来就有的 height/width props（模板里 :style 已经绑了），
   * 圆形只是再补一个 50% 圆角。
   */
  border-radius: 50%;
}

@keyframes shimmer {
  0% {
    background-position: 200% 0;
  }
  100% {
    background-position: -200% 0;
  }
}
</style>
