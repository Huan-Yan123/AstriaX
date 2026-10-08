import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { createInstanceRepo } from '../../src/main/store/instance-repo'
import { createInstance, TemplateNotReady } from '../../src/main/instances/create'
import { testStage } from '../helpers/stage'

let root: string
beforeEach(() => {
  root = testStage('acb-create-')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const stubProbe = () => Promise.resolve(true)

function makeTemplate(root: string, type: 'a' | 'n'): string {
  const tpl = join(root, type === 'a' ? 'astrbot-template' : 'napcat-template')
  mkdirSync(join(tpl, 'bin'), { recursive: true })
  writeFileSync(join(tpl, 'bin', 'stub.exe'), 'stub-body', 'utf8')
  return root
}

describe('createInstance（模板复制创建实例）', () => {
  it('复制 runtime、建 data、写 instance.json，并登记仓库', async () => {
    const templatesRoot = makeTemplate(root, 'a')
    const repo = createInstanceRepo({ dataRoot: root })
    const rec = await createInstance({
      type: 'a',
      name: '测试宝',
      templatesRoot,
      dataRoot: root,
      repo,
      probe: stubProbe,
      edition: 'bundled'
    })
    expect(existsSync(join(rec.dir, 'runtime', 'bin', 'stub.exe'))).toBe(true)
    expect(existsSync(join(rec.dir, 'data'))).toBe(true)
    const json = JSON.parse(readFileSync(join(rec.dir, 'instance.json'), 'utf8'))
    expect(json.type).toBe('a')
    expect(json.templateVersion).toBe(1)
    expect(json.id).toBe(rec.id)
    expect(json.port).toBe(rec.port)
    expect(repo.get(rec.id)?.status).toBe('stopped')
  })

  it('pull 版模板缺失抛 TemplateNotReady', async () => {
    const repo = createInstanceRepo({ dataRoot: root })
    await expect(
      createInstance({
        type: 'n',
        name: 'x',
        templatesRoot: root, // 没有 napcat-template
        dataRoot: root,
        repo,
        probe: stubProbe,
        edition: 'pull'
      })
    ).rejects.toBeInstanceOf(TemplateNotReady)
  })

  it('bundled 版模板缺失同样抛 TemplateNotReady（离线包不该缺）', async () => {
    const repo = createInstanceRepo({ dataRoot: root })
    await expect(
      createInstance({
        type: 'a',
        name: 'x',
        templatesRoot: root,
        dataRoot: root,
        repo,
        probe: stubProbe,
        edition: 'bundled'
      })
    ).rejects.toBeInstanceOf(TemplateNotReady)
  })
})
