import { describe, expect, it } from 'vitest'
import { expandArchive, psQuote } from '../../src/main/util/async-exec'
import { testStage } from '../helpers/stage'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'

/**
 * PowerShell 路径转义 —— 这个坑只在「路径含单引号」时暴露，
 * 属于那种真实存在、但很难在开发机上碰到的偶发故障。
 *
 * 背景：Windows 允许路径里出现单引号（例如用户名叫 O'Brien，
 * 数据根就可能是 `D:\O'Brien\MXBot`）。而 PowerShell 的单引号是字符串定界符，
 * 直接把路径塞进 `'${p}'` 会让它提前结束、报
 *   The string is missing the terminator: '
 * 于是解压整个失败 —— 而且错误信息完全指不到真正的原因。
 *
 * 规则很简单：PowerShell 单引号串里，单引号写两遍即可。
 */
describe('PowerShell 路径转义', () => {
  it('psQuote 把单引号写成两个', () => {
    expect(psQuote("D:\\O'Brien\\data")).toBe("'D:\\O''Brien\\data'")
  })

  it('psQuote 不动其他特殊字符（单引号串里它们都是字面量）', () => {
    expect(psQuote('C:\\a$b`c[d]')).toBe("'C:\\a$b`c[d]'")
  })

  it('含空格的路径 OK', () => {
    expect(psQuote('C:\\Program Files\\x')).toBe("'C:\\Program Files\\x'")
  })

  it('真正解压一个名字里带单引号的目录（端到端）', async () => {
    /*
     * 造一个真实场景：目标路径含单引号，把 zip 解开。
     * 这是唯一能证明「转义真的对了」的方式 —— 单测 psQuote 只能证明字符串拼对了，
     * 证明不了 PowerShell 那边真的接受了。
     */
    const root = testStage('quote-e2e-')
    // 注意目录名里的撇号
    const withQuote = join(root, "it's a dir")
    mkdirSync(join(withQuote, 'src'), { recursive: true })
    writeFileSync(join(withQuote, 'src', 'payload.txt'), 'hello-quote', 'utf8')

    // 用 PowerShell 打包（同样要安全转义路径）
    const zip = join(root, 'pack.zip')
    const { runPowerShell } = await import('../../src/main/util/async-exec')
    const pack = await runPowerShell(
      `Compress-Archive -Path ${psQuote(join(withQuote, 'src'))} -DestinationPath ${psQuote(zip)} -Force`
    )
    expect(pack.status, `打包失败：${pack.stderr}`).toBe(0)

    // 解到另一个含单引号的目录
    const out = join(root, "out' dir")
    mkdirSync(out, { recursive: true })
    const r = await expandArchive(zip, out)

    expect(
      r.status,
      `解压失败 —— 说明路径转义没生效。stderr:\n${r.stderr}`
    ).toBe(0)
    // 真的解出来了
    const landed = join(out, 'src', 'payload.txt')
    expect(existsSync(landed), '解压出来的文件应该存在').toBe(true)
    expect(readFileSync(landed, 'utf8')).toBe('hello-quote')
  }, 60000)
})
