<script setup lang="ts">
import astrbot from '../assets/astrbot-logo.webp'
import napcat from '../assets/napcat-logo.png'
defineProps<{ type: 'a' | 'n' }>()
</script>
<template><img class="brand-icon" :src="type === 'a' ? astrbot : napcat" :alt="type === 'a' ? 'AstrBot' : 'NapCat'" /></template>
<style scoped>.brand-icon { width: 24px; height: 24px; object-fit: contain; flex: none; border-radius: 5px; }</style>
