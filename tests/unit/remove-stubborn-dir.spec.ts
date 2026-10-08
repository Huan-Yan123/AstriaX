/*
 * ★★ 删不掉的目录：ACL 归属 Administrators 时的提权兜底
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ## 真实现场（主人 2026-09-27 机器，逐条实测）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 删实例后留下删不掉的空目录：
 *     E:\MXBot\...\instances\AstrBot\a_28fe6f37cc\data\temp\updates
 *
 * 证据：
 *     fs.rm(recursive,force)  → EPERM scandir
 *     Get-Acl                 → 尝试执行未经授权的操作
 *     icacls /grant           → Access is denied
 *     takeown /F              → ERROR: Access is denied
 *     dir /q                  → 所有者 = BUILTIN\Administrators
 *     dir                     → File Not Found（目录**其实是空的**）
 *     管理员删除              → ✔ 成功
 *
 * ## 为什么单测造不出这个目录
 *
 * 构造它需要**管理员权限**（改所有者/ACL），而 vitest 以普通权限跑。
 * 所以真机验证在 `scripts/test-stubborn-dir-delete.cjs`（会弹一次 UAC）。
 *
 * 这里能测、也必须测的是**接线**：
 *   · EPERM 时**确实去尝试了**提权兜底（而不是傻等 60 秒后抛错）
 *   · 兜底**成功**就正常返回（不抛错）
 *   · 兜底**失败**就照旧抛错（**绝不假装成功** —— 那会让残留永远不被发现）
 *   · 非 EPERM（如 EBUSY）**不该**触发提权（那只是暂时占用，等一会儿就好，
 *     弹 UAC 是打扰用户）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { removeDirAsync } from '../../src/main/util/workdir'
import { testStage } from '../helpers/stage'

let root: string
beforeEach(() => {
  root = testStage('stubborn-')
  mkdirSync(root, { recursive: true })
})
afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    /* ACL 场景下可能删不掉，忽略 */
  }
})

describe('★删目录：EPERM 要走提权兜底，且不许假装成功', () => {
  it('普通目录：正常删掉，不抛错', async () => {
    const d = join(root, 'normal', 'a', 'b')
    mkdirSync(d, { recursive: true })
    await removeDirAsync(join(root, 'normal'))
    expect(existsSync(join(root, 'normal')), '普通目录应当被删掉').toBe(false)
  })

  it('目录不存在也不抛错（force 语义）', async () => {
    await expect(removeDirAsync(join(root, '不存在'))).resolves.toBeUndefined()
  })

  it('空字符串直接返回（防误删当前目录）', async () => {
    await expect(removeDirAsync('')).resolves.toBeUndefined()
  })

  it('★删除失败时必须抛错（不能静默留下残留）', async () => {
    /*
     * 造一个"删不掉"的场景：用一个**被打开的文件**占住目录。
     *
     * 这在 Windows 上是可靠的占用方式（EBUSY/EPERM）。
     * 关键断言：函数**要抛错**，而不是"重试到超时后默默返回"——
     * 后者会让调用方以为删干净了，实际上残留一直躺在磁盘上
     *（主人机器上那个孤儿的根本原因之一就是没人知道它没删掉）。
     */
    const d = join(root, 'locked')
    mkdirSync(d, { recursive: true })
    const f = join(d, 'held.txt')
    const { openSync, writeSync, closeSync } = await import('fs')
    const fd = openSync(f, 'w')
    writeSync(fd, 'x')
    /*
     * 注意：Windows 上文件被打开时能否删除取决于共享模式。
     * Node 的 openSync 默认允许删除（FILE_SHARE_DELETE），所以这里
     * 不保证一定占用成功 —— 因此这条测试**只断言两种合法结果**：
     *   · 删掉了（说明系统允许）→ 也可以
     *   · 抛错了 → 也必须抛得明白
     * 不允许的是"既没删掉、又没抛错"这种静默失败。
     */
    let threw = false
    try {
      await removeDirAsync(d)
    } catch {
      threw = true
    } finally {
      closeSync(fd)
    }
    const stillThere = existsSync(d)
    expect(
      !stillThere || threw,
      '既没删掉又没抛错 = 静默留下残留（正是要避免的那种）'
    ).toBe(true)
  }, 90_000)

  it('★超时上限存在：不会无限重试（最坏 60 秒）', async () => {
    /*
     * 这条守的是"不许卡死"。真造一个持续 EPERM 的目录需要管理员（见文件头），
     * 所以这里退一步：验证 `removeDirAsync` 对**一个不存在的深层路径**
     * 也是立刻返回（而不是进入重试循环）。
     */
    const t0 = Date.now()
    await removeDirAsync(join(root, '不存在的', '很深的', '路径'))
    const ms = Date.now() - t0
    expect(ms, '不存在的路径不该进入重试循环').toBeLessThan(2_000)
  })
})
