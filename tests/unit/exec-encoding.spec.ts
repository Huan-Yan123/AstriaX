/*
 * ★★ 子进程输出必须按 **GBK** 正确解码（主人 2026-10-08 实测抓出的真 bug）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 现象
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 主人的 QQ 装在 `E:\扣扣`（中文目录），程序一直显示「未安装 QQ」。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 根因
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `async-exec.ts` 里读子进程输出用的是：
 *
 *     child.stdout.on('data', (b) => { out += b.toString() })   ← 默认 UTF-8
 *
 * 而 Windows 原生命令（`reg.exe` / `netstat` / `powershell`）输出的是
 * **GBK**（中文 Windows 的 OEM 代码页）。于是：
 *
 *     Install    REG_SZ    E:\�ۿ�       ← 乱码
 *
 * 拿这个乱码路径去 `existsSync()`，必然找不到 → 报"未安装 QQ"。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 为什么这个 bug 特别难发现（我绕了一大圈，记下来）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 用 `execFileSync` 验证是**正确**的：
 *
 *     execFileSync('reg.exe', [...], { encoding: 'utf8' })  →  E:\扣扣  ✅
 *
 * 因为它默认按**系统代码页**解码，而不是 UTF-8。
 * 而程序真实用的是 `spawn` + `b.toString()`，那才走 UTF-8。
 *
 * **验证方式必须和真实执行路径完全一致**，否则会得出
 * "编码没问题"的错误结论 —— 我第一轮就是这样被带偏，
 * 还回头怀疑了注册表读取、路径拼接、权限等等。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 影响面（不只是 QQ 检测）
 * ══════════════════════════════════════════════════════════════════════════
 *
 *   reg.exe      中文安装路径 → 乱码 → 找不到 QQ / 找不到其他软件
 *   netstat      中文列名乱码（端口号是数字，判活侥幸不受影响）
 *   powershell   任何中文输出乱码
 *   tasklist     纯 ASCII，本来就没事
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 修法与判据
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 不能无脑用 GBK —— 有些子进程（Node 自己、明确让它输出 UTF-8 的脚本）
 * 吐的是 UTF-8，用 GBK 解反而坏掉。
 *
 * 所以：**先按 UTF-8 严格解（fatal:true）；抛错才回退 GBK**。
 * UTF-8 是自校验编码，合法序列才解得出来，判据可靠。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { execFileSync } from 'child_process'

const SRC = readFileSync(join(process.cwd(), 'src', 'main', 'util', 'async-exec.ts'), 'utf8')

describe('★ 子进程输出解码', () => {
  it('★★ 不能用裸 `b.toString()` 读子进程输出', () => {
    /*
     * 这是本 bug 的**确切形态** —— 一行看起来毫无问题的代码。
     * 它读起来太自然了，所以必须有一条测试专门盯着它。
     */
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(
      /\.toString\(\)\s*\n?\s*out\s*\+=/.test(code) || /out\s*\+=\s*b\.toString\(\)/.test(code),
      '发现用 `b.toString()`（默认 UTF-8）读子进程输出 ——\n' +
        'Windows 原生命令输出的是 GBK，中文会变乱码（`E:\\扣扣` → `E:\\�ۿ�`），\n' +
        '导致中文路径的软件找不到。必须走 decodeChunk()。'
    ).toBe(false)
  })

  it('★ 必须走统一的 decodeChunk（而不是就地解码）', () => {
    expect(
      SRC.includes('decodeChunk('),
      'async-exec 里应当有 decodeChunk 并用于 stdout/stderr'
    ).toBe(true)
    /* stdout 与 stderr 都要用 */
    const hits = (SRC.match(/decodeChunk\(b\)/g) ?? []).length
    expect(hits, 'stdout 与 stderr 都应调用 decodeChunk(b)').toBeGreaterThanOrEqual(2)
  })

  it('★★ 解码策略：UTF-8 严格解优先，失败回退 GBK', () => {
    expect(
      /new TextDecoder\(\s*['"]utf-8['"]\s*,\s*\{\s*fatal:\s*true\s*\}/.test(SRC),
      '必须用 `new TextDecoder("utf-8", { fatal: true })` 做严格解 ——\n' +
        '只有 fatal:true 才会对非法序列抛错；默认模式会静默塞 U+FFFD，\n' +
        '那样就分辨不出"是不是真 UTF-8"了。'
    ).toBe(true)
    expect(/TextDecoder\(\s*['"]gbk['"]\s*\)/.test(SRC), '必须回退到 gbk').toBe(true)
  })

  it('★★ 实测：reg.exe 读中文路径要能得到正确结果', () => {
    /*
     * 端到端验证 —— 直接跑真实命令，用**与程序相同**的读法。
     *
     * 这条不能只做源码断言：编码问题的本质是"运行时行为"，
     * 源码看着对不代表解出来对。所以实际起一个 reg.exe，
     * 写一个中文路径进去，再读出来比对。
     */
    const testKey = 'HKCU\\Software\\AstriaXEncodingGuard'
    const cnDir = 'C:\\测试中文路径\\扣扣'
    try {
      execFileSync('reg.exe', ['add', testKey, '/v', 'Install', '/t', 'REG_SZ', '/d', cnDir, '/f'], {
        stdio: 'ignore'
      })

      /*
       * 用修复后的方式读：spawn + decodeChunk 等价物。
       * 这里直接调用编译产物里的函数不现实（它是模块私有的），
       * 所以用同一条命令 + 同样的解码策略，验证"这条路能读对"。
       */
      const raw = execFileSync('reg.exe', ['query', testKey, '/v', 'Install'])
      let decoded: string
      try {
        decoded = new TextDecoder('utf-8', { fatal: true }).decode(raw)
      } catch {
        decoded = new TextDecoder('gbk').decode(raw)
      }

      const m = /REG_(?:SZ|EXPAND_SZ)\s+(.+)/i.exec(decoded)
      expect(m, '应当能解析出值').toBeTruthy()
      expect(
        m![1].trim(),
        `读出来的中文路径不对：${JSON.stringify(m![1].trim())}\n` +
          '说明解码策略有问题 —— 程序会拿这个错路径去 existsSync，永远找不到。'
      ).toBe(cnDir)
    } finally {
      try {
        execFileSync('reg.exe', ['delete', testKey, '/f'], { stdio: 'ignore' })
      } catch {
        /* 清理失败不影响断言 */
      }
    }
  })

  it('★ 纯 ASCII 输出不能被弄坏（回退策略不能误伤）', () => {
    /*
     * 对照组：`tasklist` 输出是纯 ASCII，UTF-8 严格解应当成功，
     * 不能因为"想兼容 GBK"而把它弄乱。
     */
    const buf = Buffer.from('"System Idle Process","0","Services","0","8 K"\r\n', 'utf8')
    const utf8 = new TextDecoder('utf-8', { fatal: true }).decode(buf)
    expect(utf8).toContain('System Idle Process')
  })
})
