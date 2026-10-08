import { describe, expect, it } from 'vitest'
import { runUpdate } from '../../src/main/update/updater'
import { testStage } from '../helpers/stage'
import { createHash } from 'crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

/**
 * `runUpdate` 的收尾步骤：把新版本号写进 instance.json。
 *
 * 这一步的位置很关键 —— 它发生在**运行时已经换血完成之后**
 * （上面的 rename 早已把 stagedRt 换成了 rt）。
 * 如果因为 instance.json 损坏而抛异常，调用方看到的是"更新失败"，
 * 但磁盘上的运行时其实**已经是新的**了：版本标记与实际内容不一致，
 * 之后所有基于标记的判断（要不要更新、备份属于哪版）全都是错的。
 *
 * 所以要求：换标记这步必须容错 —— 文件坏了就退化成空对象继续写，
 * 绝不能让一个收尾动作把前面已经成功的事情报成失败。
 */
describe('runUpdate 收尾容错', () => {
  /**
   * 造一套可跑通 runUpdate 的目录：
   *   <dir>/runtime           老运行时（会被换掉）
   *   <dir>/instance.json     实例元数据（收尾要改它）
   */
  function seed(instanceJson: string | null): { dir: string } {
    const stem = testStage('upd-')
    const dir = join(stem, 'instances', 'AstrBot', 'a_test')
    mkdirSync(join(dir, 'runtime'), { recursive: true })
    writeFileSync(join(dir, 'runtime', 'marker.txt'), 'old-runtime', 'utf8')
    // 备份目录（runUpdate 内会 backupRuntime）
    mkdirSync(join(dir, 'backups'), { recursive: true })
    if (instanceJson !== null) {
      writeFileSync(join(dir, 'instance.json'), instanceJson, 'utf8')
    }
    return { dir }
  }

  /** 组装一次更新的依赖：资产内容固定，sha256 算好喂给 manifest */
  function deps(dir: string, asset: Buffer, version: number): Parameters<typeof runUpdate>[0] {
    const sha = createHash('sha256').update(asset).digest('hex')
    return {
      dir,
      currentTemplateVersion: 1,
      fetchManifest: async () => JSON.stringify({ version, sha256: sha, url: 'x' }),
      fetchAsset: async () => asset,
      // staging 目录里放一份"新运行时"；返回它的路径给换血逻辑
      stageDirectory: (stage: string) => {
        const rt = join(stage, 'runtime')
        mkdirSync(rt, { recursive: true })
        writeFileSync(join(rt, 'marker.txt'), 'new-runtime', 'utf8')
        return stage
      }
    }
  }

  it('正常情况：版本号被写进 instance.json，且原有字段保留', async () => {
    const { dir } = seed(JSON.stringify({ id: 'a_test', name: '我的机器人', templateVersion: 1 }))
    const asset = Buffer.from('payload')
    const r = await runUpdate(deps(dir, asset, 4280))
    expect(r.newVersion).toBe(4280)

    const meta = JSON.parse(readFileSync(join(dir, 'instance.json'), 'utf8')) as {
      id?: string
      templateVersion?: number
    }
    expect(meta.templateVersion).toBe(4280)
    expect(meta.id, '不该把整个文件覆盖成只剩版本号').toBe('a_test')
  })

  it('instance.json 损坏时不抛异常，且仍写上版本号', async () => {
    const { dir } = seed('{"id":"a_test","templateVersion":1') // 截断的坏 JSON
    const asset = Buffer.from('payload')

    await expect(
      runUpdate(deps(dir, asset, 4280)),
      '换标记失败不该把「运行时已换好」报成更新失败'
    ).resolves.toBeTruthy()

    const meta = JSON.parse(readFileSync(join(dir, 'instance.json'), 'utf8')) as {
      templateVersion?: number
    }
    expect(meta.templateVersion, '坏文件也要能写上版本号').toBe(4280)
  })

  it('运行时真的被换成新的了（收尾容错不该影响主流程）', async () => {
    const { dir } = seed('{"id":"a_test","templateVersion":1')
    const asset = Buffer.from('payload')
    await runUpdate(deps(dir, asset, 4280))
    // 换血后 runtime 里应是新内容
    const marker = readFileSync(join(dir, 'runtime', 'marker.txt'), 'utf8')
    expect(marker, '主流程（换运行时）必须照常完成').toBe('new-runtime')
  })

  it('instance.json 不存在时也能走完', async () => {
    const { dir } = seed(null)
    const asset = Buffer.from('payload')
    await expect(runUpdate(deps(dir, asset, 4280))).resolves.toBeTruthy()
  })
})
