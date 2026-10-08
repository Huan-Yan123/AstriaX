/*
 * ★★ 内部定制版的硬件信息覆盖（主人 2026-10-08）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这是什么
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 主人要求打三个包：
 *   ① 0.2.1        —— 测试更新链路用的旧版
 *   ② 1.0.0 公开版  —— 上传 GitHub 的正式版（**这个文件对它完全无效**）
 *   ③ 1.0.0 内部版  —— 硬件信息固定成一套高端配置，用于截图/演示
 *
 * 内部版的硬件显示为：
 *   · CPU：AMD Ryzen 9 9950X3D2（16 核 32 线程）
 *   · GPU：NVIDIA GeForce RTX 5090（32GB GDDR7）
 *   · 内存：64 GB
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 为什么用"编译期常量"而不是"运行期读配置文件"
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 运行期读配置（比如 config.json 里一个 `fakeHardware` 字段）会有两个问题：
 *
 *   ① **公开版里会留下后门**：那段代码连同字段一起进公开仓库，
 *      任何人都能打开配置把硬件改成假的 —— 那对一个"帮你看清自己
 *      运行环境"的工具来说是根本性的可信问题。
 *   ② 内部版和公开版**不是同一份代码**，测出来的东西不能代表公开版。
 *
 * 用 `<define>` 注入的编译期常量（见 `electron.vite.config.ts`）：
 *   · 公开版里 `INTERNAL_HW_OVERRIDE` 被 **tree-shaking 整段消掉**，
 *     产物的 JS 里**不存在**这些字符串，也就不存在后门。
 *   · 两个包共用同一份源码，只在构建时换一个开关。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 数值依据（真实规格，不是编的）
 * ══════════════════════════════════════════════════════════════════════════
 *
 *   AMD Ryzen 9 9950X3D2：16 核 / 32 线程，双 CCD 各叠一层 3D V-Cache，
 *                          总缓存 208MB，最高加速频率约 5.7GHz
 *   NVIDIA RTX 5090：GB202 核心，21760 CUDA，32GB GDDR7，
 *                    512-bit 位宽，带宽约 1792 GB/s
 *   内存：64 GB（DDR5）
 *
 * 内存是唯一会"动"的一项 —— 见下面 `hourlyJitter`：
 * 固定写死 64GB 会让"已用/可用"永远一样，截图看起来像假的。
 */

/** 内部定制版的硬件常量（只在 INTERNAL 构建里被引用） */
export interface HardwareOverride {
  cpuModel: string
  gpuModel: string
  totalMemMB: number
}

const GB = 1024

/**
 * 固定硬件。
 *
 * 内存给 64GB，但**已用部分会随时间小幅波动**（见下方），
 * 这样界面上"已用 X / 64 GB"看着是活的，而不是一张贴图。
 */
export const INTERNAL_HW: HardwareOverride = {
  cpuModel: 'AMD Ryzen 9 9950X3D2 16-Core Processor',
  gpuModel: 'NVIDIA GeForce RTX 5090',
  totalMemMB: 64 * GB
}

/**
 * 「已用内存」的模拟值 —— 随时间在两段区间里慢速漂移。
 *
 * 为什么不做成纯随机：纯随机会在每次刷新时跳来跳去（32GB → 41GB → 35GB），
 * 反而不像真的。真实的开发机内存占用是**缓变**的。
 * 用 sin 叠加一个缓慢的相位，配合"启动后经过的分钟数"，
 * 就能得到一条平滑、看起来合理的曲线。
 *
 * 基准 18GB（一台开着 IDE + 浏览器 + 几个容器的开发机很典型），
 * 摆动 ±4GB。
 */
export function internalUsedMemMB(nowMs = Date.now()): number {
  const minutes = nowMs / 60_000
  const wave = Math.sin(minutes / 7) * 2.2 + Math.sin(minutes / 23) * 1.8
  const used = 18 * GB + wave * GB
  /* 夹在合理区间内，别出现"用了 40GB"或"只用了 3GB"这种极端值 */
  const lo = 12 * GB
  const hi = 30 * GB
  return Math.round(Math.min(hi, Math.max(lo, used)))
}

/**
 * 这个构建是不是内部定制版。
 *
 * `INTERNAL_HW_OVERRIDE` 由 electron.vite 的 `define` 注入成**字面量**：
 *   · 内部版构建 → `true`   → 下面 `internalUsedMemMB` 等被保留
 *   · 公开版构建 → `false`  → 引用它的代码被整段 tree-shaking 删除
 *
 * ## ⚠️ 必须声明这个全局变量（踩过）
 *
 * 我第一版写的是 `typeof INTERNAL_HW_OVERRIDE !== 'undefined' && ...`，
 * 想"防 ReferenceError"。**那反而让注入失效**：
 * `define` 做的是**文本替换**，而 `typeof X !== 'undefined'` 这种写法
 * 在压缩器眼里是"运行期判断" —— 它不敢把后面的分支删掉，
 * 于是公开版照样带着一份运行期检查（虽然后果不严重，但 tree-shaking
 * 的意图没达到）。
 *
 * 现在用 `declare const` 明确告诉 TypeScript"这是构建期注入的"，
 * 运行时它已经被替换成 `true` / `false` 字面量，
 * 压缩器能直接判定分支死活。
 */
declare const INTERNAL_HW_OVERRIDE: boolean

export function isInternalBuild(): boolean {
  return INTERNAL_HW_OVERRIDE === true
}
