/*
 * 迁移数据目录之后，**下次启动还能不能找到数据**。
 *
 * ============================================================================
 * 这条链路上原来有个死结（本测试存在的理由）
 * ============================================================================
 *
 * 启动时主进程只从 `defaultDataRoot()`（打包后 = `<安装目录>\data`）读 config.json：
 *
 *   ipc.ts:2630   const saved = readAppConfig(await defaultDataRoot())
 *
 * 而「迁移数据目录」是把 config.json 写到**新目录**里：
 *
 *   ipc.ts:858-862   const cfgPath = join(target, 'config.json')
 *                    writeFileSync(tmp, JSON.stringify(newCfg, null, 2))
 *                    renameSync(tmp, cfgPath)
 *
 * 于是重启之后：
 *
 *   - 旧目录那份 config.json 还在（迁移只复制不删）→ 读到的 dataRoot 还是旧路径
 *     → 用户发现「迁移完又回去了」，新目录变成孤儿
 *   - 用户按提示把旧目录删了 → 读到 undefined → **每次启动都弹首启向导**
 *     （这正是用户报告过的「为什么第一次提示数据目录在哪变成了每次启动都弹」）
 *
 * 修法：安装目录旁放一个 `data-root.txt` 指针，记住上次用的数据目录。
 * 启动时指针优先，没有指针才退回默认位置。
 *
 * 这个测试**直接打真实的 root-pointer 模块**，不是复刻一份逻辑 ——
 * 复刻的话测的就只是我自己的实现，改了产品也不会红（假绿）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  readRootPointer,
  writeRootPointer,
  resolveStartupDataRoot,
  pointerPath,
  ROOT_POINTER_FILE
} from '../../src/main/store/root-pointer'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { testStage } from '../helpers/stage'

let installDir: string
let movedRoot: string

beforeEach(() => {
  /*
   * 临时目录必须落在项目里的 data\cache\tmp（testStage 的约定），
   * 不能用 os.tmpdir() —— 那是 C 盘，而这个项目有个专门的守门测试
   * 盯着「不许往 C 盘写临时文件」（testStage 会保证在数据盘上，
   * 而且每个 tag 一个独立目录，跑完能整批回收）。
   */
  installDir = testStage('acb-inst-')
  movedRoot = testStage('acb-dataroot-')
})
afterEach(() => {
  rmSync(installDir, { recursive: true, force: true })
  rmSync(movedRoot, { recursive: true, force: true })
})

describe('数据目录指针 · 迁移后重启要能找到数据', () => {
  it('★写进去再读出来，是同一条路径', () => {
    expect(writeRootPointer(installDir, movedRoot), '写入居然失败').toBe(true)
    expect(readRootPointer(installDir)).toBe(movedRoot)
  })

  it('★有指针时，启动读的是指针指的那个目录（不是安装目录）', () => {
    writeRootPointer(installDir, movedRoot)
    expect(
      resolveStartupDataRoot(installDir),
      '启动还是读安装目录旁的 data —— 用户迁移完重启就"回到旧目录"了'
    ).toBe(movedRoot)
  })

  it('★没有指针时退回默认位置（全新安装，没迁移过）', () => {
    expect(resolveStartupDataRoot(installDir)).toBe(join(installDir, 'data'))
  })

  it('★指针是空的时候退回默认（不能读到一个空路径）', () => {
    writeFileSync(pointerPath(installDir), '   \n', 'utf8')
    expect(readRootPointer(installDir)).toBeUndefined()
    expect(resolveStartupDataRoot(installDir)).toBe(join(installDir, 'data'))
  })

  it('★指针里前后有空白/换行/BOM 也要能正确解析', () => {
    // 用户用记事本另存 → 会带 BOM；手写 → 可能带行尾
    writeFileSync(pointerPath(installDir), `\uFEFF  ${movedRoot}  \r\n`, 'utf8')
    expect(readRootPointer(installDir)).toBe(movedRoot)
  })

  it('★指针指向的目录已经不存在 → 当作没有指针（别把启动卡死）', () => {
    writeRootPointer(installDir, join(movedRoot, '这个目录不存在'))
    expect(readRootPointer(installDir), '失效的指针必须判无效').toBeUndefined()
    expect(resolveStartupDataRoot(installDir)).toBe(join(installDir, 'data'))
  })

  it('★指针指向的是一个**文件**而不是目录 → 也判无效', () => {
    const f = join(movedRoot, '这是个文件.txt')
    writeFileSync(f, 'x', 'utf8')
    writeRootPointer(installDir, f)
    expect(readRootPointer(installDir)).toBeUndefined()
  })

  it('★数据目录为空串时不该写（避免写出一个空指针）', () => {
    expect(writeRootPointer(installDir, ''), '空路径不该被写入').toBe(false)
    expect(writeRootPointer(installDir, '   ')).toBe(false)
    expect(existsSync(pointerPath(installDir))).toBe(false)
  })

  it('★重复迁移会覆盖指针，永远指向最新那个', () => {
    // 用 testStage 而不是 os.tmpdir()：临时文件不许落在 C 盘（项目约定）
    const second = testStage('acb-dataroot2-')
    try {
      writeRootPointer(installDir, movedRoot)
      writeRootPointer(installDir, second)
      expect(readRootPointer(installDir), '指针没更新到最新的目录').toBe(second)
    } finally {
      rmSync(second, { recursive: true, force: true })
    }
  })

  it('★指针文件里只有路径本身，没有 JSON 包装（纯文本，零解析风险）', () => {
    writeRootPointer(installDir, movedRoot)
    const raw = readFileSync(pointerPath(installDir), 'utf8')
    expect(raw.trim(), '写进了 JSON 之类的东西').toBe(movedRoot)
  })

  it('★不留下临时文件（原子写的中间产物要清干净）', () => {
    writeRootPointer(installDir, movedRoot)
    const leftovers = require('fs')
      .readdirSync(installDir)
      .filter((n: string) => n !== ROOT_POINTER_FILE)
    expect(leftovers, `安装目录里留了临时文件：${leftovers.join(', ')}`).toEqual([])
  })

  it('★安装目录不存在时写入也不该抛（只返回 false）', () => {
    const ghost = join(installDir, '不存在的子目录', '再深一层')
    expect(() => writeRootPointer(ghost, movedRoot)).not.toThrow()
    // mkdirSync recursive 会把它建出来，所以这里应当是 true 且能读回
    expect(readRootPointer(ghost)).toBe(movedRoot)
  })
})
