import { isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { ref } from 'vue'

export const desktopError = ref('')
export function subscribeDesktopErrors(): void {
  if (isTauri()) void listen<string>('desktop:error', event => { desktopError.value = event.payload })
}
