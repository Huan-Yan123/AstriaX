import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readQQVersion, MIN_QQ_BUILD } from '../../src/main/runtime/qq-check'
import { testStage } from '../helpers/stage'

/**
 * QQ 版本读取，逻辑对齐 NapCat 自己（napcat.mjs 的 rQ / nQ / getQQBuildStr）。
 *
 * NapCat 的真实做法（这份实现就是照它写的，避免我们和它对版本的理解不一致）：
 *   rQ(QQ.exe) → <QQ目录>\versions\config.json      （"快速更新"模式的标记文件）
 *   nQ(QQ.exe, curVersion) → <QQ目录>\versions\<curVersion>\resources\app\package.json
 *                           找不到时回落到 <QQ目录>\resources\app\versions\<curVersion>\package.json
 *   getQQBuildStr() = config.curVersion.split("-")[1] ?? packageInfo.buildVersion
 *
 * 关键：版本号形如 "9.9.31-49738"，比的是**破折号后面的构建号**（49738），不是 9.9.31。
 * 本机实测：E:\QQ\versions\config.json → {"curVersion":"9.9.31-49738","buildId":"49738"}
 */
describe('QQ 版本读取（对齐 NapCat 的 rQ / nQ / getQQBuildStr）', () => {
  let root = ''
  beforeEach(() => {
    root = testStage('mxbot-qq-')
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  /** 造出本机那种真实布局 */
  function mkQQ(dir: string, curVersion: string, buildVersion?: string): void {
    const verDir = join(dir, 'versions', curVersion)
    mkdirSync(join(verDir, 'resources', 'app'), { recursive: true })
    writeFileSync(join(dir, 'QQ.exe'), '', 'utf8')
    writeFileSync(
      join(dir, 'versions', 'config.json'),
      JSON.stringify({ baseVersion: curVersion, curVersion, prevVersion: '', buildId: buildVersion ?? '' }),
      'utf8'
    )
    if (buildVersion !== undefined) {
      writeFileSync(
        join(verDir, 'resources', 'app', 'package.json'),
        JSON.stringify({ version: curVersion, buildVersion }),
        'utf8'
      )
    }
  }

  it('首选 config.json 的 curVersion，取破折号后的构建号', () => {
    const dir = join(root, 'QQ')
    mkQQ(dir, '9.9.31-49738', '49738')
    const v = readQQVersion(dir)
    expect(v).toBeDefined()
    expect(v!.version).toBe('9.9.31-49738')
    expect(v!.build).toBe(49738)
  })

  it('curVersion 没破折号时，回落到 package.json 的 buildVersion', () => {
    // NapCat: curVersion.split("-")[1] ?? packageInfo.buildVersion
    const dir = join(root, 'QQ2')
    mkQQ(dir, '9.9.31', '49738')
    const v = readQQVersion(dir)
    expect(v!.build).toBe(49738)
  })

  it('config.json 不存在时，用 package.json 里最新那个版本目录', () => {
    const dir = join(root, 'QQ3')
    const verDir = join(dir, 'versions', '9.9.31-49738', 'resources', 'app')
    mkdirSync(verDir, { recursive: true })
    writeFileSync(join(dir, 'QQ.exe'), '', 'utf8')
    writeFileSync(join(verDir, 'package.json'), JSON.stringify({ version: '9.9.31-49738', buildVersion: '49738' }), 'utf8')
    const v = readQQVersion(dir)
    expect(v!.build).toBe(49738)
  })

  it('package.json 在回落路径里也能找到（resources/app/versions/<ver>/package.json）', () => {
    // NapCat 的 nQ 里那条 fallback
    const dir = join(root, 'QQ4')
    const alt = join(dir, 'resources', 'app', 'versions', '9.9.31-49738')
    mkdirSync(alt, { recursive: true })
    writeFileSync(join(dir, 'QQ.exe'), '', 'utf8')
    writeFileSync(join(dir, 'versions-config-placeholder'), '', 'utf8')
    // 没有 versions/config.json，只有回落路径
    writeFileSync(join(alt, 'package.json'), JSON.stringify({ version: '9.9.31-49738', buildVersion: '49738' }), 'utf8')
    const v = readQQVersion(dir)
    expect(v?.build).toBe(49738)
  })

  it('多版本时取构建号最大的那个（别被旧版本目录骗了）', () => {
    const dir = join(root, 'QQ5')
    for (const [ver, build] of [
      ['9.9.28-30000', '30000'],
      ['9.9.31-49738', '49738'],
      ['9.9.30-40000', '40000']
    ]) {
      const d = join(dir, 'versions', ver, 'resources', 'app')
      mkdirSync(d, { recursive: true })
      writeFileSync(join(d, 'package.json'), JSON.stringify({ version: ver, buildVersion: build }), 'utf8')
    }
    writeFileSync(join(dir, 'QQ.exe'), '', 'utf8')
    const v = readQQVersion(dir)
    expect(v!.build).toBe(49738)
  })

  it('目录不存在 / 空目录 → undefined（不抛异常）', () => {
    expect(readQQVersion(join(root, '不存在'))).toBeUndefined()
    const empty = join(root, 'empty')
    mkdirSync(empty, { recursive: true })
    expect(readQQVersion(empty)).toBeUndefined()
  })

  it('config.json 是坏 JSON 时不炸，回落到 package.json', () => {
    const dir = join(root, 'QQ6')
    const verDir = join(dir, 'versions', '9.9.31-49738', 'resources', 'app')
    mkdirSync(verDir, { recursive: true })
    writeFileSync(join(dir, 'QQ.exe'), '', 'utf8')
    writeFileSync(join(dir, 'versions', 'config.json'), '{ 坏掉的 json', 'utf8')
    writeFileSync(join(verDir, 'package.json'), JSON.stringify({ version: '9.9.31-49738', buildVersion: '49738' }), 'utf8')
    const v = readQQVersion(dir)
    expect(v!.build).toBe(49738)
  })

  it('门槛常量就是 NapCat 签名表里的最低构建号', () => {
    expect(MIN_QQ_BUILD).toBe(40768)
  })
})
