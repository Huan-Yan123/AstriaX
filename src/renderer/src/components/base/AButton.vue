<script setup lang="ts">
/**
 * 统一按钮组件 - 替换全局样式，支持完整的变体和状态
 */
export interface ButtonProps {
  /** 视觉变体 */
  variant?: 'main' | 'ghost' | 'danger'
  /** 尺寸 */
  size?: 'default' | 'small'
  /** 禁用态 */
  disabled?: boolean
  /** 加载态 */
  loading?: boolean
  /** 块级（占满父容器宽度）*/
  block?: boolean
}

const props = withDefaults(defineProps<ButtonProps>(), {
  variant: 'ghost',
  size: 'default'
})

const emit = defineEmits<{
  click: [e: MouseEvent]
}>()

function handleClick(e: MouseEvent): void {
  if (!props.disabled && !props.loading) {
    emit('click', e)
  }
}
</script>

<template>
  <button
    class="a-button"
    :class="[
      `a-button--${variant}`,
      `a-button--${size}`,
      { 'a-button--loading': loading, 'a-button--block': block }
    ]"
    :disabled="disabled || loading"
    @click="handleClick"
  >
    <span v-if="loading" class="a-button__spinner" />
    <span class="a-button__content">
      <slot />
    </span>
  </button>
</template>

<style scoped>
.a-button {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border-radius: var(--radius-ctrl);
  font-family: inherit;
  font-weight: 500;
  line-height: 1;
  cursor: pointer;
  transition: all 0.14s ease;
  white-space: nowrap;
}

/* 尺寸 */
.a-button--default {
  padding: 8px 18px;
  font-size: 13px;
}
.a-button--small {
  padding: 6px 12px;
  font-size: 12px;
}

/* 变体 */
.a-button--ghost {
  border: 1px solid var(--hairline);
  background: #fff;
  color: var(--ink-soft);
}
.a-button--ghost:hover:not(:disabled) {
  border-color: var(--primary);
  color: var(--primary-deep);
  background: var(--primary-soft);
}

.a-button--main {
  border: none;
  background: var(--primary);
  color: #fff;
  font-weight: 600;
}
.a-button--main:hover:not(:disabled) {
  background: var(--primary-deep);
}

.a-button--danger {
  border: 1px solid #eccbc8;
  background: #fff;
  color: #b04740;
}
.a-button--danger:hover:not(:disabled) {
  background: var(--danger);
  border-color: var(--danger);
  color: #fff;
}

/* 状态 */
.a-button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.a-button--loading {
  cursor: wait;
}
.a-button--loading .a-button__content {
  opacity: 0.6;
}

.a-button--block {
  width: 100%;
}

/* 加载态动画 */
.a-button__spinner {
  width: 14px;
  height: 14px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* 聚焦态 */
.a-button:focus-visible {
  outline: 3px solid color-mix(in srgb, var(--primary) 28%, transparent);
  outline-offset: 2px;
}
</style>
