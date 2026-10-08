import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureSiteCustomize } from '../../src/main/runtime/python-runtime'
import { testStage } from '../helpers/stage'

/**
 * 内嵌 Python 的致命坑：目录里只要有 `._pth`，解释器就进隔离模式，
 * **完全忽略 PYTHONPATH**（实测：设了依然 ModuleNotFoundError）。
 * 而 AstrBot 是 pip --target 装进各版本目录的，必须让解释器认识那个目录。
 *
 * 解法是在 `Lib\site-packages\sitecustomize.py` 里读 MXBOT_SITE 插 sys.path。
 *
 * 这一组测试盯的是它的**自愈性** —— 光在「装 Python」时写一次是不够的：
 * 用户从旧版本升上来、搬过数据目录、或者手动清过 site-packages，
 * 这个文件都可能不在。那时 AstrBot 会以 ModuleNotFoundError 启动失败，
 * 而报错信息完全指不到真正的原因（用户只会看到"no module named astrbot"）。
 */
describe('sitecustomize 注入（AstrBot 能加载包的前提）', () => {
  let root = ''
  beforeEach(() => {
    root = testStage('mxbot-site-')
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('写出 sitecustomize.py，读 MXBOT_SITE 插 sys.path', () => {
    ensureSiteCustomize(root)
    const f = join(root, 'Lib', 'site-packages', 'sitecustomize.py')
    expect(existsSync(f)).toBe(true)
    const body = readFileSync(f, 'utf8')
    expect(body).toContain('MXBOT_SITE')
    expect(body).toContain('sys.path.insert')
  })

  it('目录不存在时自己建出来（不能假设装 Python 时已经建好）', () => {
    // 给一个干净到连 Lib 都没有的目录
    const fresh = join(root, 'fresh')
    mkdirSync(fresh, { recursive: true })
    ensureSiteCustomize(fresh)
    expect(existsSync(join(fresh, 'Lib', 'site-packages', 'sitecustomize.py'))).toBe(true)
  })

  it('幂等：内容一致时不重写（避免每次启动都无谓写盘）', () => {
    ensureSiteCustomize(root)
    const f = join(root, 'Lib', 'site-packages', 'sitecustomize.py')
    const first = readFileSync(f, 'utf8')
    const t0 = Date.now()
    // 再调两次
    ensureSiteCustomize(root)
    ensureSiteCustomize(root)
    expect(readFileSync(f, 'utf8')).toBe(first)
    void t0
  })

  it('文件被写坏/内容不对时会修回来（升级或手改过的场景）', () => {
    const f = join(root, 'Lib', 'site-packages', 'sitecustomize.py')
    mkdirSync(join(root, 'Lib', 'site-packages'), { recursive: true })
    writeFileSync(f, '# 旧的坏内容\n', 'utf8')
    ensureSiteCustomize(root)
    const body = readFileSync(f, 'utf8')
    expect(body).toContain('MXBOT_SITE')
    expect(body).not.toContain('旧的坏内容')
  })
})
