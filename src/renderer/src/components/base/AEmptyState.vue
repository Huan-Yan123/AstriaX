<script setup lang="ts">
/**
 * 空状态组件 - 统一的空列表/无数据展示
 */
export interface EmptyStateProps {
  /** 插图图片路径 */
  image?: string
  /** 主标题 */
  title: string
  /** 描述文字 */
  description?: string
}

defineProps<EmptyStateProps>()
</script>

<template>
  <div class="empty-state">
    <img v-if="image" :src="image" :alt="title" class="empty-state__image" />
    <h3 class="empty-state__title">{{ title }}</h3>
    <p v-if="description" class="empty-state__desc">{{ description }}</p>
    <div v-if="$slots.action" class="empty-state__action">
      <slot name="action" />
    </div>
  </div>
</template>

<style scoped>
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px 24px;
  text-align: center;
}

.empty-state__image {
  width: 120px;
  height: 120px;
  margin-bottom: 20px;
  opacity: 0.85;
}

.empty-state__title {
  margin: 0 0 8px;
  font-size: 16px;
  font-weight: 600;
  color: var(--ink);
}

.empty-state__desc {
  margin: 0 0 24px;
  max-width: 360px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--ink-soft);
}

.empty-state__action {
  display: flex;
  gap: 12px;
}
</style>
