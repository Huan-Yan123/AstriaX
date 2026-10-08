import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { patchNapcatWorkerArgv } from '../../src/main/runtime/napcat-patch'
import { testStage } from '../helpers/stage'

/**
 * NapCat 的 worker 启动参数修补。
 * 这条链路的真实现象：实例显示「运行中」，但端口永远不通、WebUI 一片空白，
 * 日志里是 `node.exe: bad option: --no-sandbox` + worker 退出码 9。
 */
describe('patchNapcatWorkerArgv', () => {
  let root = ''

  beforeEach(() => {
    // 故意不用 os.tmpdir 的默认语义做断言，只为拿个隔离目录
    root = testStage('mxbot-napcat-patch-')
    mkdirSync(join(root, 'napcat'), { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function writeMjs(body: string): string {
    const f = join(root, 'napcat', 'napcat.mjs')
    writeFileSync(f, body, 'utf8')
    return f
  }

  it('把 Electron 专有的 --no-sandbox 从 worker 参数里去掉', () => {
    const f = writeMjs(`
      const Hu = t.isElectron;
      du.createWorker(r, o, {
        stdio: Hu ? "pipe" : ["inherit", "pipe", "pipe", "ipc"],
        ...Hu ? {} : { execArgv: ["--no-sandbox"] }
      });
    `)
    const r = patchNapcatWorkerArgv(root)
    expect(r.patched).toBe(true)
    const after = readFileSync(f, 'utf8')
    expect(after).toContain('execArgv: []')
    expect(after).not.toContain('--no-sandbox')
    // 其它逻辑必须原样保留
    expect(after).toContain('stdio: Hu ? "pipe"')
  })

  it('幂等：再补一次不报错、内容不变', () => {
    writeMjs('x = { execArgv: ["--no-sandbox"] }')
    expect(patchNapcatWorkerArgv(root).patched).toBe(true)
    const after1 = readFileSync(join(root, 'napcat', 'napcat.mjs'), 'utf8')
    const second = patchNapcatWorkerArgv(root)
    expect(second.patched).toBe(false)
    expect(second.reason).toContain('无需修补')
    expect(readFileSync(join(root, 'napcat', 'napcat.mjs'), 'utf8')).toBe(after1)
  })

  it('留一份 .mxbot-orig 备份，方便排查', () => {
    writeMjs('y = { execArgv: ["--no-sandbox"] }')
    patchNapcatWorkerArgv(root)
    expect(existsSync(join(root, 'napcat', 'napcat.mjs.mxbot-orig'))).toBe(true)
  })

  it('目标片段出现多次时不乱改（宁可不动）', () => {
    const f = writeMjs('a = { execArgv: ["--no-sandbox"] }\nb = { execArgv: ["--no-sandbox"] }')
    const before = readFileSync(f, 'utf8')
    const r = patchNapcatWorkerArgv(root)
    expect(r.patched).toBe(false)
    expect(r.reason).toContain('不是唯一匹配')
    expect(readFileSync(f, 'utf8')).toBe(before)
  })

  it('不是 NapCat Node 版布局时给出说明而不是抛错', () => {
    rmSync(join(root, 'napcat'), { recursive: true, force: true })
    const r = patchNapcatWorkerArgv(root)
    expect(r.patched).toBe(false)
    expect(r.reason).toContain('napcat.mjs')
  })
})
