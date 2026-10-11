<script setup lang="ts">
defineProps<{ name: string }>()
const paths: Record<string, string> = {
  instances: 'M3 4h7l2 2h9v14H3z M3 10h18',
  download: 'M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4',
  settings: 'M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z',
  general: 'M4 7h16M4 17h16M8 4v6m8 4v6',
  updates: 'M20 8a9 9 0 1 0 1 7M20 3v6h-6',
  storage: 'M4 4h16v16H4zM4 14h16M7 17h2',
  diagnostics: 'M5 3h10l4 4v14H5zM9 11h6M9 15h6M15 3v4h4',
  network: 'M3 9a14 14 0 0 1 18 0M6 13a9 9 0 0 1 12 0M9 17a4 4 0 0 1 6 0M12 21h.01',
  back: 'M19 12H5m7-7-7 7 7 7',
  forward: 'M5 12h14m-7-7 7 7-7 7',
  sidebar: 'M3 4h18v16H3zM9 4v16',
  search: 'M16 16l5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  close: 'M6 6l12 12M18 6 6 18',
  tray: 'M4 13v7h16v-7M12 3v12m-4-4 4 4 4-4',
  quit: 'M12 3v9M7 5a9 9 0 1 0 10 0',
  ask: 'M9 8a3 3 0 1 1 5 2c-2 1-2 2-2 3M12 17h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
}
</script>
<template><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="paths[name] || paths.settings" /><circle v-if="name === 'settings'" cx="12" cy="12" r="3" /></svg></template>
