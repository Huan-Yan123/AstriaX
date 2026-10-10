import { createApp } from 'vue'
import App from './App.vue'
import './styles/tokens.css'
import { installDesktopBridge } from './platform/tauri'
import { subscribeDesktopErrors } from './platform/desktop-errors'

installDesktopBridge()
subscribeDesktopErrors()

createApp(App).mount('#app')
