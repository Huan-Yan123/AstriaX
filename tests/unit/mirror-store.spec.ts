import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  BUILTIN_MIRRORS,
  loadMirrors,
  saveMirrors,
  addCustomMirror,
  removeCustomMirror,
  setMirrorPref,
  mirrorOrderFor,
  resolveMirrorPrefix,
  resolveFileUrl,
  fileUrlFor
} from '../../src/main/update/mirror-store'
import { testStage } from '../helpers/stage'

let root: string

beforeEach(() => {
  root = testStage('mx-mirror-')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('镜像源仓库', () => {
  it('首次读取：内置源齐全，两类模式都在，偏好默认「自动」', () => {
    const st = loadMirrors(root)
    expect(st.mirrors.filter((m) => m.builtin).length).toBe(BUILTIN_MIRRORS.length)
    expect(st.mirrors.some((m) => m.mode === 'proxy' && m.base === '')).toBe(true)
    expect(st.mirrors.some((m) => m.mode === 'files')).toBe(true)
    expect(st.pref.a).toBe('')
    expect(st.pref.n).toBe('')
  })

  it('自定义源可增可删，拒绝空地址与重复', () => {
    addCustomMirror(root, { label: '我的镜像', base: 'https://my.mirror/' })
    let st = loadMirrors(root)
    expect(st.mirrors.find((m) => m.label === '我的镜像')?.base).toBe('https://my.mirror/')

    expect(() => addCustomMirror(root, { label: '重复', base: 'https://my.mirror/' })).toThrow(/已存在/)
    expect(() => addCustomMirror(root, { label: '空', base: '   ' })).toThrow(/地址/)
    expect(() => addCustomMirror(root, { label: '撞车', base: 'https://gh-proxy.com/' })).toThrow(/已存在/)

    removeCustomMirror(root, 'https://my.mirror/')
    st = loadMirrors(root)
    expect(st.mirrors.some((m) => m.base === 'https://my.mirror/')).toBe(false)
  })

  it('内置源不可删', () => {
    expect(() => removeCustomMirror(root, 'https://gh-proxy.com/')).toThrow(/内置/)
  })

  it('可为 AstrBot / NapCat 各自指定源，指定后排在最前且回退链完整', () => {
    /*
     * 用第一个内置加速源做目标，**不要写死某个具体域名** ——
     * 原来这里写的是 ghproxy.net，后来实测发现它 API 返回 403
     * （列不出可用版本）被移出内置列表，于是 setMirrorPref 设了它、
     * loadMirrors 又因为「这个 base 不在列表里」把偏好丢掉，测试就红了。
     * 那是测试绑死了数据，不是代码有问题。
     */
    const target = BUILTIN_MIRRORS.filter((m) => m.mode === 'proxy' && m.base)[0].base
    const st = setMirrorPref(root, { a: target })
    expect(st.pref.a).toBe(target)

    const order = mirrorOrderFor(root, 'a')
    expect(order[0].base).toBe(target)
    expect(order.length).toBe(loadMirrors(root).mirrors.length)
    expect(new Set(order.map((m) => m.base)).size).toBe(order.length)
    // NapCat 未指定 → 保持原顺序
    expect(mirrorOrderFor(root, 'n')[0].base).toBe(BUILTIN_MIRRORS[0].base)
  })

  it('偏好指向不在列表里的源时静默回落到自动（防止手动改坏 mirrors.json）', () => {
    /*
     * setMirrorPref 不校验，但 loadMirrors 会过滤掉「列表里没有的 base」。
     * 这是有意的：mirrors.json 是纯文本，用户可能手改坏，
     * 与其让下载去试一个不存在的源，不如直接回落成自动。
     */
    setMirrorPref(root, { a: 'https://not-in-list.example/' })
    expect(loadMirrors(root).pref.a).toBe('')
  })

  it('偏好指向已删除的自定义源时回落自动', () => {
    addCustomMirror(root, { label: '临时', base: 'https://tmp.mirror/' })
    setMirrorPref(root, { n: 'https://tmp.mirror/' })
    removeCustomMirror(root, 'https://tmp.mirror/')
    expect(loadMirrors(root).pref.n).toBe('')
  })

  it('配置落盘可读回', () => {
    addCustomMirror(root, { label: 'A', base: 'https://a.mirror/' })
    const file = join(root, 'mirrors.json')
    expect(existsSync(file)).toBe(true)
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { custom: unknown[] }
    expect(raw.custom).toHaveLength(1)
  })

  it('配置文件损坏 → 回落内置源而不是崩', () => {
    writeFileSync(join(root, 'mirrors.json'), '{ broken json', 'utf8')
    const st = loadMirrors(root)
    expect(st.mirrors.length).toBe(BUILTIN_MIRRORS.length)
  })

  it('resolveMirrorPrefix：代理型前缀拼接，空前缀=直连，缺尾斜杠容错', () => {
    expect(resolveMirrorPrefix('https://gh-proxy.com/', 'https://github.com/a/b.zip')).toBe(
      'https://gh-proxy.com/https://github.com/a/b.zip'
    )
    expect(resolveMirrorPrefix('', 'https://github.com/a/b.zip')).toBe('https://github.com/a/b.zip')
    expect(resolveMirrorPrefix('https://my.mirror', 'https://github.com/a/b.zip')).toBe(
      'https://my.mirror/https://github.com/a/b.zip'
    )
  })

  it('文件型镜像：按 index 里的文件名拼直链', () => {
    expect(resolveFileUrl('https://dl.x/mxbot/files/', 'AstrBot-v4.28.0-dashboard.zip')).toBe(
      'https://dl.x/mxbot/files/AstrBot-v4.28.0-dashboard.zip'
    )
    expect(resolveFileUrl('https://dl.x/mxbot/files', 'a.zip')).toBe('https://dl.x/mxbot/files/a.zip')
  })

  it('fileUrlFor：优先用 index.json 的 url，其次按文件名拼', () => {
    const idx = { assets: [{ name: 'AstrBot-v4.28.0-dashboard.zip', url: 'https://cdn.x/a.zip', sha256: 'ff' }] }
    expect(fileUrlFor('https://dl.x/files/', 'AstrBot-v4.28.0-dashboard.zip', idx)).toEqual({
      url: 'https://cdn.x/a.zip',
      sha256: 'ff'
    })
    expect(fileUrlFor('https://dl.x/files/', 'other.zip', idx)).toEqual({
      url: 'https://dl.x/files/other.zip',
      sha256: undefined
    })
    expect(fileUrlFor('https://dl.x/files/', 'x.zip', null).url).toBe('https://dl.x/files/x.zip')
  })
})
