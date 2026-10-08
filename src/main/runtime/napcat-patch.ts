import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

/**
 * 修掉 NapCat Shell 包在「纯 Node 环境」下的一个致命 bug。
 *
 * 背景：NapCat 的 napcat.mjs 里判断宿主类型后决定 worker 的启动参数，判断链是
 *
 *     const { manager, isElectron } = await oAe()
 *     du = manager
 *     Hu = isElectron              // 纯 Node 下为 false
 *     ...
 *     du.createWorker(worker, args, {
 *       stdio: Hu ? "pipe" : ["inherit", "pipe", "pipe", "ipc"],
 *       ...Hu ? {} : { execArgv: ["--no-sandbox"] }     // ← 三元写反了
 *     })
 *
 * `--no-sandbox` 是 Electron 专有参数，纯 Node 的 node.exe 完全不认，
 * worker 一启动就 `bad option: --no-sandbox`、退出码 9，重试 3 次后主进程放弃
 * ——表现就是「实例显示运行中，但端口永远不通、WebUI 打开一片空白」。
 *
 * 注意 Hu=false 时**才会**塞 --no-sandbox，所以官方那个
 * NAPCAT_FORCE_NODE_PROCESS=1 开关反而帮不上忙（它只能改走哪条分支，
 * 改不了这个写反的三元）。
 *
 * 我们没法在进程外拦掉这个参数（NODE_OPTIONS 白名单拒绝 --no-sandbox，
 * 它也不是环境变量能覆盖的），所以解压后直接把这处字面量修掉。
 * 只做一次精确字面替换，匹配数不等于 1 就跳过——绝不动别的代码。
 */
export function patchNapcatWorkerArgv(dir: string): { patched: boolean; reason: string } {
  const file = join(dir, 'napcat', 'napcat.mjs')
  if (!existsSync(file)) {
    return { patched: false, reason: '没找到 napcat/napcat.mjs（可能不是 Node 版布局）' }
  }

  const FROM = 'execArgv: ["--no-sandbox"]'
  const TO = 'execArgv: []'

  let src: string
  try {
    src = readFileSync(file, 'utf8')
  } catch (e) {
    return { patched: false, reason: `读不了 napcat.mjs：${String(e)}` }
  }

  if (!src.includes(FROM)) {
    // 已经是好的（补过 / 上游自己修了），不算错
    return { patched: false, reason: '无需修补（没找到目标片段）' }
  }

  const hits = src.split(FROM).length - 1
  if (hits !== 1) {
    return { patched: false, reason: `目标片段出现 ${hits} 次，不是唯一匹配，为安全起见跳过` }
  }

  // 先留个备份，万一上游结构变了还能回退排查
  try {
    const bak = `${file}.mxbot-orig`
    if (!existsSync(bak)) writeFileSync(bak, src, 'utf8')
  } catch {
    /* 备份失败不影响主流程 */
  }

  writeFileSync(file, src.split(FROM).join(TO), 'utf8')
  return { patched: true, reason: '已修掉 worker 的 --no-sandbox（Node 不认这个 Electron 参数）' }
}
