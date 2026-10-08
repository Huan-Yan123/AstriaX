import { existsSync } from 'fs'
import { describe, expect, it } from 'vitest'
import { readBuiltinVersion } from '../../src/main/runtime/builtin-version'

/**
 * 拿**真实的**运行时包验证版本解析器 —— 不是我自己造的 fixture。
 *
 * 为什么值得单写一条：
 * 自己造的 fixture 只能证明「我按我以为的格式写对了解析」，
 * 证明不了真实包长成那样。NapCat 的 napcat.mjs 是 3MB 的压缩产物，
 * 变量名、语句顺序都可能和我假设的不同；AstrBot 的 wheel 才是安装时真正落地的东西。
 *
 * 这两个目录如果不在（换了机器、清过缓存）就跳过，不让测试因为环境缺失而红。
 */
describe('真实运行时包的版本解析（有则验，无则跳）', () => {
  const NAPCAT_DIR = 'E:\\MX\\launcher-acb\\data\\runtimes\\n\\v4.18.19'
  const ASTRBOT_DIR = 'E:\\MX\\launcher-acb\\data\\cache\\tmp\\astrbot-verify\\extract'

  it('NapCat：从真实 napcat.mjs（3MB 压缩产物）读出 4.18.19', () => {
    if (!existsSync(NAPCAT_DIR)) {
      console.log('  跳过：本机没有 NapCat 运行时目录')
      return
    }
    const v = readBuiltinVersion({ dir: NAPCAT_DIR, type: 'n' })
    expect(v).toBe('4.18.19')
  })

  it('AstrBot：从真实 wheel 解出的目录读出 4.28.0', () => {
    if (!existsSync(ASTRBOT_DIR)) {
      console.log('  跳过：本机没有解出的 AstrBot wheel（先跑一次下载验证）')
      return
    }
    const v = readBuiltinVersion({ dir: ASTRBOT_DIR, type: 'a' })
    expect(v).toBe('4.28.0')
  })
})
