/*
 * NSIS 脚本测试的**注册表沙箱**。
 *
 * ============================================================================
 * 为什么这是必需的，而不是"小心一点就行"
 * ============================================================================
 *
 * `build/installer.nsh` 里的宏会用**硬编码**的 `HKCU\Software\MXBot\DataRoot`
 * 来决定：
 *   - STASH 保护哪个目录（`ReadRegStr`）→ 然后 `Rename` 它
 *   - 真卸载删哪个目录（`RMDir /r "$R1"`）
 *   - RESTORE 把数据放回哪个位置
 *
 * 也就是说：**任何直接编译运行 installer.nsh 的测试，都会操作真实的数据目录**。
 *
 * 我自己就差点因此搬走用户的数据（实测记录）：
 *   在 `_probe-restore-gate.cjs` 里，我构造的场景是"RESTORE 失败"，
 *   目的是验证 customInit 会不会 Abort。但那个脚本**没有沙箱注册表**，
 *   于是 STASH 里这句：
 *     ReadRegStr $R7 HKCU "Software\MXBot" "DataRoot"
 *   读到了**真实的** `E:\MXBot\data`，把它赋给 `$R6`，接着就要
 *     Rename "E:\MXBot\data" "<sandbox>\MXBot-update-keep\payload"
 *   千钧一发的是：用户此刻正跑着 NapCat（QQ 占着 data 里的文件），
 *   NTFS 拒绝 rename 带打开句柄的目录 → `${Errors}` 置位 →
 *   走"情况 C"分支 → **Abort**。数据没被搬走纯粹是因为**运气好**，
 *   不是因为我的测试安全。
 *
 * 如果用户当时没开 NapCat，那一次运行就会把整个 data 目录搬进沙箱、
 * 然后被沙箱清理删掉 —— 用户的实例、运行时、配置全没。
 *
 * 所以：**注册表沙箱不是"最佳实践"，是这一类测试的前置条件**。
 * 任何编译运行 installer.nsh 的脚本都必须先调 `sandboxRegistry()`。
 *
 * ============================================================================
 * 用法
 * ============================================================================
 *
 *   const { sandboxRegistry } = require('./nsis-sandbox.cjs')
 *   const box = sandboxRegistry()        // 备份 + 清空
 *   try {
 *     box.pointAt(someDir)               // 让 installer 只看见这个目录
 *     ...跑测试...
 *   } finally {
 *     box.restore()                      // 还原真实注册表
 *     box.verify()                       // 断言真的还原了
 *   }
 *
 * `restore()` 会先 delete 再 import —— `reg import` 是合并语义，
 * 不先删干净的话，测试留下的 DataRoot 会残留成"看起来还原了、其实多了个错值"。
 */
const { execFileSync } = require('child_process')
const { existsSync, readdirSync } = require('fs')
const { join } = require('path')

/** 安装器硬编码的注册表键 */
const REG_KEY = 'HKCU\\Software\\MXBot'

function regQuery() {
  try {
    const out = execFileSync('reg', ['query', REG_KEY, '/v', 'DataRoot'], {
      stdio: 'pipe'
    }).toString()
    const m = out.match(/DataRoot\s+REG_SZ\s+(.+)/)
    return m ? m[1].trim() : null
  } catch {
    return null
  }
}

/**
 * 建立注册表沙箱。
 *
 * 返回的对象持有备份文件路径与开跑前的真实值；
 * **务必在 finally 里调 restore() + verify()**。
 */
function sandboxRegistry(backupDir) {
  if (!backupDir) throw new Error('sandboxRegistry 需要 backupDir（放备份文件的地方）')
  const backupFile = join(backupDir, 'regbackup.reg')
  const before = regQuery()

  // 备份（键不存在时 reg export 会失败，那是正常的）
  try {
    execFileSync('reg', ['export', REG_KEY, backupFile, '/y'], { stdio: 'pipe' })
  } catch {
    /* 键本来就没有 */
  }

  const api = {
    key: REG_KEY,
    before,
    backupFile,
    exists: existsSync(backupFile),

    /**
     * 让 installer 只看见 dataDir。
     *
     * 两个视图都写（/reg:32 与 /reg:64）：HKCU\Software\<厂商> 一般不做
     * 重定向，但 NSIS 编出的是 32 位 exe，双保险的代价极小 ——
     * 漏一个视图就可能让 ReadRegStr 读到真实值，用例静默失效。
     *
     * **写完立刻回读校验，对不上就抛异常。**
     *
     * 这一步是整个沙箱的关键：如果只写不验，写入失败（权限、
     * 策略、视图差异）时会**静默**保持真实值，然后安装器照样去动
     * 用户的数据 —— 测试看起来"跑过了"，事故已经发生。
     * 抛异常保证"宁可不跑，也不要在没沙箱的情况下跑"。
     */
    pointAt(dataDir) {
      for (const view of ['/reg:64', '/reg:32']) {
        try {
          execFileSync('reg', ['delete', REG_KEY, '/f', view], { stdio: 'pipe' })
        } catch {
          /* 不存在 */
        }
      }
      for (const view of ['/reg:64', '/reg:32']) {
        try {
          execFileSync(
            'reg',
            ['add', REG_KEY, '/v', 'DataRoot', '/t', 'REG_SZ', '/d', dataDir, '/f', view],
            { stdio: 'pipe' }
          )
        } catch {
          /* 某些系统上 32 位视图不可写，忽略 */
        }
      }

      const now = regQuery()
      if (now !== dataDir) {
        throw new Error(
          `注册表沙箱没生效，已中止以免动到真实数据。\n` +
            `      期望 DataRoot=${dataDir}\n` +
            `      实际 DataRoot=${now ?? '(无)'}\n` +
            `      真实值（已备份）=${before ?? '(无)'}`
        )
      }
      return api
    },

    /** 把真实注册表还回去 */
    restore() {
      try {
        execFileSync('reg', ['delete', REG_KEY, '/f'], { stdio: 'pipe' })
      } catch {
        /* 不存在就算了 */
      }
      if (api.exists && existsSync(backupFile)) {
        try {
          execFileSync('reg', ['import', backupFile], { stdio: 'pipe' })
        } catch {
          /* 下面 verify 会报出来 */
        }
      }
    },

    /** 断言真的还原了；返回错误信息数组（空 = OK） */
    verify() {
      const after = regQuery()
      const problems = []
      if (before !== after) {
        problems.push(
          `注册表没还原！开跑前 DataRoot=${before ?? '(无)'}，收尾后=${after ?? '(无)'}` +
            `\n      备份文件：${api.exists ? backupFile : '(无备份，原本没有该键)'}`
        )
      }
      return problems
    }
  }

  return api
}

/** 递归数文件数（读不动的目录跳过）—— 用来断言"真实数据只增不减" */
function countFiles(dir) {
  let n = 0
  const walk = (d, depth) => {
    if (depth > 10) return
    let ents
    try {
      ents = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      if (e.isDirectory()) walk(join(d, e.name), depth + 1)
      else n++
    }
  }
  walk(dir, 0)
  return n
}

module.exports = { sandboxRegistry, countFiles, REG_KEY, regQuery }
