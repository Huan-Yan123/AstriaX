import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { createProcessManager } from '../../src/main/proc/process-manager'
import { testStage } from '../helpers/stage'

let root: string
beforeEach(() => {
  root = testStage('acb-pmlog-')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('实例日志落盘（PM logFile 管道）', () => {
  it('start 携带 logFile：stdout/stderr 追加到该文件，文件先创建', async () => {
    const logFile = join(root, 'inst.log')
    const pm = createProcessManager()
    const h = await pm.start({
      id: 't1',
      cmd: process.execPath,
      args: ['-e', 'console.log("hello-line"); console.error("err-line"); setTimeout(()=>process.exit(0), 300)'],
      port: 0,
      logFile
    })
    await h.eventually('running', 3000)
    await new Promise((r) => setTimeout(r, 700))
    h.status = 'stopped'
    expect(existsSync(logFile), '日志文件应在启动时即创建').toBe(true)
    const txt = readFileSync(logFile, 'utf8')
    expect(txt).toContain('hello-line')
    expect(txt).toContain('err-line')
    expect(existsSync(logFile)).toBe(true)
  })
})
