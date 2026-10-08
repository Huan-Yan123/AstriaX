/*
 * pip 执行 + **失败时绕过缓存重试**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ## 为什么需要它（主人 2026-09-27 实测的真实失败）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 日志（audit-2026-09-27，14:53:23）：
 *
 *     [14:51:42]  config:moving  -  成功              ← 刚搬完数据目录
 *     [14:53:23]  runtime:install  AstrBot v4.27.4  失败
 *         装 AstrBot 失败：.1-py3-none-any.whl' ->
 *         'e:\mx\launcher-acb\data\cache\pip-cache\wheels\08\a1\a3\...\
 *          jieba-0.42.1-py3-none-any.whl'
 *         error: failed-wheel-build-for-install
 *         Failed to build installable wheels for some pyproject.toml
 *         based projects jieba
 *
 * ## 根因：pip 的 wheel 缓存与它的索引**对不上**
 *
 * 查缓存目录里的 `origin.json`，它记的是**源码包**：
 *     {"url": ".../jieba-0.42.1.tar.gz", "archive_info": {...}}
 * 而缓存里实际躺着的却是一个 **.whl**（18.42 MB）。
 *
 * pip 的行为是：sdist 构建成功后，把**构建出来的 wheel**
 * 复制进 `wheels/<hash>/` 并在那里写 origin。
 * 当这一步失败（文件被占用 / 目录权限在搬家后变了 / 半写状态），
 * 就报 `failed-wheel-build-for-install` —— **尽管 wheel 其实已经建好了**。
 *
 * 复现验证：我单独对同一个 jieba 跑 `pip install --target ...` 是**成功**的
 *（生成 19.3MB 的 wheel），说明 jieba 本身没问题、编译器也不缺 ——
 * 纯粹是**缓存那一步**卡住了。
 *
 * ## 修法：失败时**绕过缓存**重试一次
 *
 * `--no-cache-dir` 让 pip 完全不碰那个缓存目录：
 *   · 代价：这一次要重新下载/构建（慢，但**能成功**）
 *   · 收益：用户不会因为一个损坏的缓存**永远装不上**
 *
 * ## 为什么只在"看起来与缓存有关"时才重试
 *
 * 不是什么失败都值得重试：
 *   · 源上真没这个包（`from versions: none`）→ 重试也白搭，浪费时间
 *   · 网络断开 → 同上
 *   · 而 `failed-wheel-build-for-install` / `[Errno 13]` / `EBUSY` 这类
 *     **本地文件层面**的错，重试（且绕开缓存）大概率就过了
 *
 * 所以按关键字判断，避免无谓的第二次等待。
 */
import type { RunResult, RunOptions } from './async-exec'

/** 判断这个 pip 失败是否"像是缓存/本地文件的问题"（值得绕缓存重试） */
export function looksCacheRelated(stderr: string, stdout = ''): boolean {
  const t = `${stderr}\n${stdout}`
  return (
    /failed-wheel-build-for-install/i.test(t) ||
    /Failed to build installable wheels/i.test(t) ||
    /\[Errno 13\]/i.test(t) || // Permission denied
    /EBUSY|EPERM/i.test(t) ||
    /Access is denied/i.test(t) ||
    /* 缓存里那份 shard 是坏的：pip 自己会说 hash 不匹配 */
    /THESE PACKAGES DO NOT MATCH THE HASHES/i.test(t) ||
    /hash mismatch/i.test(t)
  )
}

/** 往 pip 参数里插入 `--no-cache-dir`（幂等） */
export function withNoCacheDir(args: string[]): string[] {
  if (args.includes('--no-cache-dir')) return args
  const i = args.indexOf('install')
  if (i < 0) return [...args, '--no-cache-dir']
  return [...args.slice(0, i + 1), '--no-cache-dir', ...args.slice(i + 1)]
}

/**
 * 跑 pip；**失败且像是缓存问题时，自动加 `--no-cache-dir` 重试一次**。
 *
 * `runner` 由调用方注入（生产是 async-exec 的 run，测试是记账的假执行器）——
 * 这样既保留了测试注入点，又能共用这段兜底逻辑。
 */
export async function runPipWithCacheFallback(
  runner: (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>,
  pythonExe: string,
  args: string[],
  opts: RunOptions
): Promise<{ result: RunResult; retriedNoCache: boolean }> {
  const first = await runner(pythonExe, args, opts)
  if (first.status === 0) return { result: first, retriedNoCache: false }

  const err = String(first.stderr ?? '')
  const out = String(first.stdout ?? '')
  if (!looksCacheRelated(err, out)) return { result: first, retriedNoCache: false }

  /*
   * 绕缓存重试。
   *
   * 注意**不传 onData**：第一次的输出已经报给界面了，
   * 再报一遍会让进度看着像"重来了一次"（确实是重来了，
   * 但那只会让用户困惑 —— 他以为装好了又从头开始）。
   * 这里把重试的事实交给调用方写日志。
   */
  const retryOpts: RunOptions = { ...opts, onData: undefined }
  const second = await runner(pythonExe, withNoCacheDir(args), retryOpts)
  return { result: second, retriedNoCache: true }
}
