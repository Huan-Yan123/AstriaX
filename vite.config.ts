import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'

export default defineConfig({
  root: 'src/renderer',
  plugins: [vue()],
  resolve: { alias: { '@': resolve('src/renderer/src') } },
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: '127.0.0.1' },
  build: { outDir: '../../dist/web', emptyOutDir: true },
})
