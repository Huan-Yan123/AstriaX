import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { downloadAppUpdate } from '../../src/main/update/app-update'
import { testStage } from '../helpers/stage'

let root: string
beforeEach(() => { root = testStage('update-download-safe-') })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('更新下载的文件隔离', () => {
  it('同时下载同名安装包，各自使用独立暂存文件', async () => {
    let ready!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => { ready = resolve })
    const finish = new Promise<void>((resolve) => { release = resolve })
    const parts: string[] = []
    const first = downloadAppUpdate({
      dir: root, url: 'https://example.com/setup.exe',
      fetchToFile: async (_url, file) => {
        parts.push(file)
        writeFileSync(file, 'first')
        ready()
        await finish
        return 5
      }
    })
    await started
    const second = downloadAppUpdate({
      dir: root, url: 'https://example.com/setup.exe',
      fetchToFile: async (_url, file) => {
        parts.push(file)
        writeFileSync(file, 'second')
        return 6
      }
    })
    try { await second } finally { release() }
    const saved = await first
    expect(new Set(parts).size).toBe(2)
    expect(readFileSync(saved, 'utf8')).toBe('first')
    expect(readdirSync(root).filter((file) => file.endsWith('.part'))).toEqual([])
  })

  it('下载失败清理自己的残片，并保留已有安装包', async () => {
    writeFileSync(join(root, 'setup.exe'), 'previous-good-installer')
    await expect(downloadAppUpdate({
      dir: root, url: 'https://example.com/setup.exe',
      fetchToFile: async (_url, file) => {
        writeFileSync(file, 'partial')
        throw new Error('连接中断')
      }
    })).rejects.toThrow('连接中断')
    expect(readFileSync(join(root, 'setup.exe'), 'utf8')).toBe('previous-good-installer')
    expect(readdirSync(root).filter((file) => file.endsWith('.part'))).toEqual([])
  })

  it.each(['../outside.exe', 'file.exe:stream', 'CON.exe', 'setup.exe.'])('拒绝非法安装包文件名：%s', async (fileName) => {
    let called = false
    await expect(downloadAppUpdate({
      dir: root, url: 'https://example.com/setup.exe', fileName,
      fetchToFile: async () => { called = true; return 1 }
    })).rejects.toThrow()
    expect(called).toBe(false)
    expect(existsSync(join(root, 'outside.exe'))).toBe(false)
  })
})
