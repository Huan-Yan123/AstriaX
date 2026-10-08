/*
 * 备份的删除与回滚**必须校验路径**。
 *
 * ## 为什么（这是真问题，不是洁癖）
 *
 * `backup:del` 收到的是渲染层给的 `file` 字符串，然后直接
 * `unlinkSync(file)`；`backup:restore` 同理直接
 * `restoreBackup({ dir: rec.dir, file: args.file })` 去读它。
 *
 * 而同一个文件里的 `backup:openFolder` 是**做了**校验的
 * （resolve 之后要求落在备份根目录里，注释里还专门解释了为什么
 * 不能用 startsWith 裸比）。也就是说：同一类入参，一个做了防护、
 * 另两个漏了 —— 典型的「修了一处忘了另两处」。
 *
 * 后果：
 *   - 渲染层一旦被注入（页面里的第三方内容、调试时的 devtools、
 *     或者将来某个不经意的 IPC 转发），就能让主进程删掉**任意文件**。
 *     而这个应用是**自我提权到管理员**跑的，等于「以管理员身份删任意文件」。
 *   - 正常用户也能踩到：备份记录是磁盘上扫出来的，用户在资源管理器里
 *     把它挪走/改名后界面没刷新，再点「删除」就会删到别的东西；
 *     更离谱的是 file 为空串时 `unlinkSync('')` 会在**进程当前目录**上抛
 *     一个看不懂的 ENOENT（打包后 cwd 可能是 System32）。
 *
 * 正确边界：这两个操作只允许作用在 `<dataRoot>\instances\` 底下的
 * `*.tar.gz` / `*.json` 上 —— 那才是备份真正住的地方。
 */
import { describe, it, expect } from 'vitest'
import { buildHandlers } from '../../src/main/ipc'
import { testStage } from '../helpers/stage'
import { rmSync, mkdirSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'

function mk() {
  const root = testStage('acb-backup-guard-')
  mkdirSync(join(root, 'instances', 'NapCat', 'n_1', 'backups'), { recursive: true })
  const h = buildHandlers({ probe: () => true, audit: undefined })
  h['config:set']({ dataRoot: root })
  return { root, h }
}

describe('backup:del / backup:restore 的路径校验', () => {
  it('★不能删数据根外面的文件（应用是管理员权限）', async () => {
    const { root, h } = mk()
    // 一个在数据根外面的「重要文件」
    const outside = join(root, '..', `outside-${Date.now()}.txt`)
    writeFileSync(outside, 'important', 'utf8')

    await expect(
      h['backup:del'](outside),
      '备份删除绝不能碰数据根外面的文件'
    ).rejects.toThrow()
    expect(existsSync(outside), '外面的文件被删掉了！').toBe(true)

    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { force: true })
  })

  it('★不能删非备份文件（备份目录里的 .exe 之类也不能删）', async () => {
    const { root, h } = mk()
    const notBackup = join(root, 'instances', 'NapCat', 'n_1', 'backups', 'evil.exe')
    writeFileSync(notBackup, 'x', 'utf8')

    await expect(h['backup:del'](notBackup), '只该允许删备份归档').rejects.toThrow()
    expect(existsSync(notBackup)).toBe(true)

    rmSync(root, { recursive: true, force: true })
  })

  it('★空字符串不能把整个当前目录当目标（unlinkSync("") 行为很怪）', async () => {
    const { root, h } = mk()
    await expect(h['backup:del']('')).rejects.toThrow()
    rmSync(root, { recursive: true, force: true })
  })

  it('正常的备份文件能删（别把功能一起挡掉）', async () => {
    const { root, h } = mk()
    const bak = join(root, 'instances', 'NapCat', 'n_1', 'backups', '20260101000000-v1.tar.gz')
    writeFileSync(bak, 'gz', 'utf8')
    writeFileSync(bak.replace(/\.tar\.gz$/, '.json'), '{}', 'utf8')

    await h['backup:del'](bak)
    expect(existsSync(bak), '正常备份应该被删掉').toBe(false)

    rmSync(root, { recursive: true, force: true })
  })

  it('★回滚不能读数据根外面的文件', async () => {
    const { root, h } = mk()
    const outside = join(root, '..', `outside-${Date.now()}.tar.gz`)
    writeFileSync(outside, 'not really a backup', 'utf8')

    // 先造一个合法实例，否则会先因「实例不存在」抛错、测不到路径校验
    const instDir = join(root, 'instances', 'NapCat', 'n_1')
    writeFileSync(
      join(instDir, 'instance.json'),
      JSON.stringify({ id: 'n_1', type: 'n', name: 'N', runtimeTag: 'v1' }),
      'utf8'
    )
    writeFileSync(
      join(root, 'instances.json'),
      JSON.stringify({
        instances: [
          {
            id: 'n_1',
            type: 'n',
            name: 'N',
            templateVersion: 1,
            port: 6200,
            dir: instDir,
            status: 'stopped',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z'
          }
        ]
      }),
      'utf8'
    )

    await expect(
      h['backup:restore']({ instanceId: 'n_1', file: outside }),
      '回滚只能读备份目录里的归档'
    ).rejects.toThrow()

    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { force: true })
  })
})

/*
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 「在 instances 下 + .json 结尾」这个条件**不够**（审计抓出的严重问题）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 原来的校验是 `allowExt: ['.tar.gz', '.json']` ——
 * 而实例目录里的**关键文件全都是 `.json`**：
 *
 *   · `<inst>\instance.json`         ← 版本绑定的**唯一真相**
 *   · `<inst>\data\cmd_config.json`  ← AstrBot 账密 + 模型 API key + 插件开关
 *   · `<inst>\config\webui.json`     ← NapCat 的 token / 端口
 *   · `<inst>\config\onebot11_*.json`
 *
 * 它们**全部满足**原来的校验条件，而 `deleteBackup` 会真的 unlink 掉。
 * 这个进程还会自我提权到管理员（NapCat 注入 QQ 需要）——
 * 等于一个**管理员权限下的任意 .json 删除原语**。
 *
 * 修法：改成"备份命名规则 + 直属父目录必须是 backups"双约束。
 * 下面这组用例就是钉住这条边界。
 */
describe('★备份校验不能误放行实例自己的 .json（关键文件）', () => {
  /** 造一个实例目录 + 各种关键 .json */
  function mkInstance() {
    const root = testStage('acb-backup-key-')
    const instDir = join(root, 'instances', 'AstrBot', 'a_1')
    mkdirSync(join(instDir, 'data'), { recursive: true })
    mkdirSync(join(instDir, 'config'), { recursive: true })
    mkdirSync(join(instDir, 'backups'), { recursive: true })

    const files = {
      /** 版本绑定的唯一真相 */
      instanceJson: join(instDir, 'instance.json'),
      /** AstrBot 主配置：账密 + 模型 API key */
      cmdConfig: join(instDir, 'data', 'cmd_config.json'),
      /** NapCat token */
      webui: join(instDir, 'config', 'webui.json')
    }
    writeFileSync(files.instanceJson, '{"runtimeTag":"v4.28.0"}', 'utf8')
    writeFileSync(files.cmdConfig, '{"apiKey":"SECRET"}', 'utf8')
    writeFileSync(files.webui, '{"token":"SECRET"}', 'utf8')

    const h = buildHandlers({ probe: () => true })
    h['config:set']({ dataRoot: root })
    return { root, h, instDir, files }
  }

  it('★不能删 instance.json（版本绑定的唯一真相）', async () => {
    const { root, h, files } = mkInstance()
    await expect(
      h['backup:del'](files.instanceJson),
      'instance.json 是以 .json 结尾、又在 instances 下，但**绝不是备份**'
    ).rejects.toThrow()
    expect(existsSync(files.instanceJson), 'instance.json 被删掉了！').toBe(true)
    rmSync(root, { recursive: true, force: true })
  })

  it('★不能删 AstrBot 主配置 cmd_config.json（含 API key）', async () => {
    const { root, h, files } = mkInstance()
    await expect(
      h['backup:del'](files.cmdConfig),
      'cmd_config.json 里是用户的账密和模型 API key，被删就永久丢失'
    ).rejects.toThrow()
    expect(existsSync(files.cmdConfig), 'cmd_config.json 被删掉了！').toBe(true)
    rmSync(root, { recursive: true, force: true })
  })

  it('★不能删 NapCat 的 webui.json', async () => {
    const { root, h, files } = mkInstance()
    await expect(h['backup:del'](files.webui)).rejects.toThrow()
    expect(existsSync(files.webui), 'webui.json 被删掉了！').toBe(true)
    rmSync(root, { recursive: true, force: true })
  })

  it('★backups 目录里但文件名不是备份形状的，也不许删', async () => {
    /*
     * 光要求"在 backups 目录里"还不够 —— 万一那里被放了别的东西
     *（用户手动塞的、或将来别处写进来的），也不该由备份删除去动它。
     * 所以文件名必须符合 `<14位时间戳>-v<版本>` 的形状。
     */
    const { root, h, instDir } = mkInstance()
    const sneaky = join(instDir, 'backups', 'notes.json')
    writeFileSync(sneaky, '{}', 'utf8')

    await expect(
      h['backup:del'](sneaky),
      'backups 里不合命名规则的文件也不该被删'
    ).rejects.toThrow()
    expect(existsSync(sneaky)).toBe(true)
    rmSync(root, { recursive: true, force: true })
  })

  it('正常的备份仍然能删（别把功能挡掉）', async () => {
    const { root, h, instDir } = mkInstance()
    const bak = join(instDir, 'backups', '20260912141734-v1.tar.gz')
    writeFileSync(bak, 'gz', 'utf8')
    writeFileSync(bak.replace(/\.tar\.gz$/, '.json'), '{}', 'utf8')

    await h['backup:del'](bak)
    expect(existsSync(bak), '合法备份应当被删掉').toBe(false)
    rmSync(root, { recursive: true, force: true })
  })

  it('早期版本那种多一个点的备份名也认（兼容性）', async () => {
    /*
     * backup.ts:50 的注释提过：早期生成过
     * `20260912141734.-v1.tar.gz` 这种时间戳后多一个点的名字。
     * 收紧校验时不能把老备份一起挡掉（用户会删不掉自己的旧备份）。
     */
    const { root, h, instDir } = mkInstance()
    const old = join(instDir, 'backups', '20260912141734.-v1.tar.gz')
    writeFileSync(old, 'gz', 'utf8')

    await h['backup:del'](old)
    expect(existsSync(old), '老命名的备份也应当能删').toBe(false)
    rmSync(root, { recursive: true, force: true })
  })
})
