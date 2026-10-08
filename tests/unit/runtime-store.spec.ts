import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, existsSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { createRuntimeStore } from '../../src/main/update/runtime-store'
import { testStage } from '../helpers/stage'

let root: string

beforeEach(() => {
  root = testStage('mx-rt-')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('多版本运行时仓库', () => {
  it('空仓库：两类都返回空列表', () => {
    const st = createRuntimeStore({ dataRoot: root })
    expect(st.list('a')).toEqual([])
    expect(st.list('n')).toEqual([])
  })

  it('登记一个版本后可列出，含 tag / 目录 / 安装时间 / 大小', () => {
    const st = createRuntimeStore({ dataRoot: root })
    st.register({ type: 'a', tag: 'v4.28.0', from: 'AstriaX官方源' })
    const list = st.list('a')
    expect(list).toHaveLength(1)
    expect(list[0].tag).toBe('v4.28.0')
    expect(list[0].from).toBe('AstriaX官方源')
    expect(existsSync(list[0].dir)).toBe(true)
    expect(list[0].installedAt).toBeTruthy()
  })

  it('同 tag 重复登记是幂等的（不产生两条）', () => {
    const st = createRuntimeStore({ dataRoot: root })
    st.register({ type: 'a', tag: 'v4.28.0' })
    st.register({ type: 'a', tag: 'v4.28.0', from: 'again' })
    expect(st.list('a')).toHaveLength(1)
  })

  it('多个版本按版本号倒序（新在前）', () => {
    const st = createRuntimeStore({ dataRoot: root })
    st.register({ type: 'a', tag: 'v4.27.2' })
    st.register({ type: 'a', tag: 'v4.28.0' })
    st.register({ type: 'a', tag: 'v4.9.0' })
    expect(st.list('a').map((v) => v.tag)).toEqual(['v4.28.0', 'v4.27.2', 'v4.9.0'])
  })

  it('A / N 分开存放，互不干扰', () => {
    const st = createRuntimeStore({ dataRoot: root })
    st.register({ type: 'a', tag: 'v4.28.0' })
    st.register({ type: 'n', tag: 'v4.18.19' })
    expect(st.list('a').map((v) => v.tag)).toEqual(['v4.28.0'])
    expect(st.list('n').map((v) => v.tag)).toEqual(['v4.18.19'])
  })

  it('删除指定版本：立刻从列表消失、返回待删路径交给调用方异步删', async () => {
    const st = createRuntimeStore({ dataRoot: root })
    const a = st.register({ type: 'a', tag: 'v4.28.0' })
    st.register({ type: 'a', tag: 'v4.27.2' })
    /*
     * remove 现在**不删文件**，而是先把目录改名藏起来、返回新路径。
     *
     * 为什么：版本目录是几万文件的大目录（AstrBot 的 pip 依赖四万九千多个文件），
     * 同步 rmSync 会独占主进程，界面整个卡死（用户反馈「删各种东西也是半天删不掉」）。
     * 但也不能只摘记录不管目录 —— buildList 会把清单和磁盘目录**合并**展示，
     * 目录还在就会被 scanDisk 找回来，用户看到「点了删除列表里还在」。
     * 所以先同步改名（一瞬间），再异步删文件。
     */
    const trash = st.remove('a', 'v4.28.0')
    expect(trash, '返回的是改名后的待删路径').not.toBe(a.dir)
    expect(trash).toContain('.deleting-')
    expect(st.list('a').map((v) => v.tag), '列表要立刻干净，不能等异步删完').toEqual(['v4.27.2'])
    // 原路径已经不存在（被改名了），所以 scanDisk 不会再把它当版本
    expect(existsSync(a.dir)).toBe(false)
    expect(existsSync(trash), '文件还在待删路径下').toBe(true)

    const { removeDirAsync } = await import('../../src/main/util/workdir')
    await removeDirAsync(trash)
    expect(existsSync(trash), '异步删完之后才真的没了').toBe(false)
    expect(st.list('a').map((v) => v.tag), '删完后列表仍然只有另一个版本').toEqual(['v4.27.2'])
  })

  it('删不存在的版本报错可读', () => {
    const st = createRuntimeStore({ dataRoot: root })
    expect(() => st.remove('a', 'v9.9.9')).toThrow(/没有安装/)
  })

  it('isInstalled / latest 便捷查询', () => {
    const st = createRuntimeStore({ dataRoot: root })
    st.register({ type: 'a', tag: 'v4.28.0' })
    expect(st.isInstalled('a', 'v4.28.0')).toBe(true)
    expect(st.isInstalled('a', 'v4.27.2')).toBe(false)
    expect(st.latest('a')?.tag).toBe('v4.28.0')
    expect(st.latest('n')).toBeUndefined()
  })

  it('清单文件损坏 → 从磁盘目录自愈（不丢已下载的版本）', () => {
    const st = createRuntimeStore({ dataRoot: root })
    st.register({ type: 'a', tag: 'v4.28.0' })
    // 模拟「清单损坏，但目录里有真货」：真实装的版本目录不会是空的
    writeFileSync(join(root, 'runtimes', 'a', 'v4.28.0', 'astrbot.py'), 'x', 'utf8')
    writeFileSync(join(root, 'runtimes.json'), '{ broken', 'utf8')
    const st2 = createRuntimeStore({ dataRoot: root })
    expect(st2.list('a').map((v) => v.tag)).toEqual(['v4.28.0'])
  })

  it('目录里手放的版本目录也会被扫到（自愈/外部拷入）', () => {
    // 手工拷入的版本目录里当然有文件，不会是个空壳
    mkdirSync(join(root, 'runtimes', 'a', 'v4.26.0', 'data'), { recursive: true })
    writeFileSync(join(root, 'runtimes', 'a', 'v4.26.0', 'astrbot.py'), 'x', 'utf8')
    const st = createRuntimeStore({ dataRoot: root })
    expect(st.list('a').map((v) => v.tag)).toContain('v4.26.0')
  })

  it('安装失败留下的**空目录**不能被当成已下载的版本', () => {
    /*
     * 用户报告：「AstrBot 明明没安装完整，却已经出现在『已下载包列表』里，
     * 而且还能成功创建实例」。
     *
     * 根因：安装是先 mkdir 再 pip install，pip 中途失败时目录留在磁盘上，
     * 而列表原来只按「是不是目录」判断，于是空壳被当成可用版本。
     * 用户拿它建实例，启动必然失败还查不出原因。
     */
    mkdirSync(join(root, 'runtimes', 'a', 'v4.99.0'), { recursive: true })
    const st = createRuntimeStore({ dataRoot: root })
    expect(
      st.list('a').map((v) => v.tag),
      '空目录是半失败的残留，不该列出来让人拿去建实例'
    ).not.toContain('v4.99.0')
  })

  it('有 mxbot-runtime.json 标记的就算数（安装成功后写的那个）', () => {
    // 标记是安装成功后才写的，等价于「这个版本装好了」的凭证
    mkdirSync(join(root, 'runtimes', 'n', 'v4.18.19'), { recursive: true })
    writeFileSync(
      join(root, 'runtimes', 'n', 'v4.18.19', 'mxbot-runtime.json'),
      JSON.stringify({ tag: 'v4.18.19', kind: 'node' }),
      'utf8'
    )
    const st = createRuntimeStore({ dataRoot: root })
    expect(st.list('n').map((v) => v.tag)).toContain('v4.18.19')
  })

  it('dirFor 给出该版本的运行目录（实例从这里实例化）', () => {
    const st = createRuntimeStore({ dataRoot: root })
    expect(st.dirFor('a', 'v4.28.0')).toBe(join(root, 'runtimes', 'a', 'v4.28.0'))
  })

  it('占用检查：某版本被实例引用时给出引用者（删除前提示用）', () => {
    const st = createRuntimeStore({ dataRoot: root })
    st.register({ type: 'a', tag: 'v4.28.0' })
    st.setInstanceRefs([{ instanceId: 'i1', type: 'a', tag: 'v4.28.0', name: '主力' }])
    expect(st.refsFor('a', 'v4.28.0').map((r) => r.instanceId)).toEqual(['i1'])
  })
})
