import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
// @ts-expect-error 根目录的构建开关（纯常量文件，没有类型声明）
import { INTERNAL_BUILD } from './build-flags'

/*
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 内部定制版开关（主人 2026-10-08）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 开关在 `build-flags.ts` 里（**改一行布尔**即可），这里只负责把它注入。
 *
 * ## 为什么不用环境变量
 *
 * 我第一版写的是 `INTERNAL=1 npm run build`，结果内部版构建出来
 * **完全没生效**，且没有任何报错（构建照样成功）—— 排查花了好几轮。
 * 环境变量在 PowerShell / npm / electron-vite 三层之间是否透传
 * 是个看不见的东西。硬编码的布尔则不可能悄悄失效。
 *
 * ## 为什么要"注入"而不是直接 import
 *
 * 直接 `import { INTERNAL_BUILD }` 的话，两个版本产物里都会留一份
 * 运行时判断，`hardware-override.ts` 那段代码也就跟着进公开版 ——
 * 任何人都能把公开版改成内部版。用 `define` 注入成字面量之后，
 * 公开版的 `false` 让压缩器把整段删掉（已验证：产物里搜不到
 * "9950X3D2" 这些字符串）。
 */
const INTERNAL = INTERNAL_BUILD === true

/* 构建时明确说出来 —— 免得又出现"以为打了内部版其实没有" */
console.log(
  INTERNAL
    ? '\n\u001b[33m★★ 内部定制版构建（硬件信息固定：9950X3D2 / RTX 5090 / 64GB）\u001b[0m\n'
    : '\n公开版构建（使用真实硬件信息）\n'
)

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: {
      INTERNAL_HW_OVERRIDE: JSON.stringify(INTERNAL)
    },
    resolve: {
      alias: {
        '@': resolve('src/main')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    define: {
      INTERNAL_HW_OVERRIDE: JSON.stringify(INTERNAL)
    },
    resolve: {
      alias: {
        '@': resolve('src/preload')
      }
    }
  },
  renderer: {
    plugins: [vue()],
    define: {
      __INTERNAL_BUILD__: JSON.stringify(INTERNAL)
    },
    resolve: {
      alias: {
        '@': resolve('src/renderer/src')
      }
    }
  }
})
