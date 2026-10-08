import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = join(__dirname, '..', '..')
const ipc = readFileSync(join(ROOT, 'src', 'main', 'ipc.ts'), 'utf8')

/**
 * 取消任务的接线守卫。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 主人 2026-10-08：「不只是 python 安装点击取消没反应，是全部东西的
 *    安装都不能取消」，随后独立审查又抓出 pypi 分支的残留缺口
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ## 为什么必须有源码守卫（而不是只靠函数级测试）
 *
 * 这里守的是**接线**：某个 handler 有没有在关键节点查 `signal.aborted`。
 * 那类缺陷的表现是"功能静默不生效"（取消了却依然登记），
 * 而不是抛一个能被断言捕获的错 —— 函数级测试覆盖不到。
 *
 * 本项目已有同类守卫的先例（`cancel-not-register.spec.ts` 对 importFile、
 * `no-dead-renderer-code.spec.ts` 对渲染层死代码），这里沿用同一手法。
 */
describe('★ 取消接线守卫：所有安装路径都必须能取消', () => {
  /**
   * 取出某个 handler 的**函数体**。
   *
   * 锚点必须用 `'<name>': async`（带冒号+async），不能用 `'<name>'`：
   * 后者会先命中文件上方那个类型声明表（`'runtime:install': HandlerFn<...>`），
   * 于是切出来的片段是类型声明而不是实现 —— 我第一版就是这么写的，
   * 结果守卫报"找不到 store.register"（假红）。
   *
   * ## 为什么用"下一个 handler 锚点"当右边界，而不是固定字符数
   *
   * 这个文件里很多注释被压成**极长的单行**（一行几百到几千字符），
   * 所以"切 30000 字符"和"覆盖到哪一行"完全对不上 ——
   * 我第二版给 `runtime:install` 切 60000 字符仍然够不到它的
   * `store.register`（在文件更靠后的位置），又红了一次。
   *
   * 改成按**下一个 handler 名**切，边界就与内容对齐了，不受注释长度影响。
   */
  function handlerBody(name: string): string {
    const anchor = `'${name}': async`
    const start = ipc.indexOf(anchor)
    expect(start, `找不到 ${name} handler 的实现（锚点 ${anchor}）`).toBeGreaterThan(0)
    /*
     * 右边界：从 start 之后找下一个 `  'xxx': async` 或 `  'xxx': (` 形式。
     * 用正则匹配"行首缩进 + 引号包起来的 handler 名 + 冒号 + 空格 + (async|函数"，
     * 这样注释里出现的 `'store.register'` 之类不会被误当成边界。
     */
    const rest = ipc.slice(start + anchor.length)
    const next = rest.search(/\n\s*'[a-z][a-zA-Z0-9:_-]*':\s*(async|\(|\(p\)|\(id)/)
    return next >= 0 ? rest.slice(0, next) : rest
  }

  it('runtime:install 的 pypi 分支必须在 register 前检查取消', () => {
    /*
     * 审查报告抓出的**严重**缺口：importFile 早就有了 throwIfCancelled，
     * 而 pypi 分支从头到尾不看 signal —— 用户取消后 pip 被杀，
     * 但"本体文件恰好已落盘"会让校验通过，流程继续 register 出一个
     * 装了一半、启动必崩的版本。
     *
     * ## span 要给足（踩过）
     *
     * `runtime:install` 是个**很长的 handler**：pypi 分支（我们关心的）
     * 后面还跟着 zip 分支，两者都有 `store.register`（第 3539 行与 3632 行
     * 那一带）。第一版 span 只给 20000 字符，切出来的窗口刚好停在
     * pypi 分支的 register 之前 → 守卫报"没有任何检查"（假红）。
     * 现在给足 60000，覆盖整个 pypi 分支。
     */
    const body = handlerBody('runtime:install')
    /*
     * ★ 必须匹配**真实调用**，不能匹配注释（这条守卫我调了三轮，坑在这）
     *
     * `body.indexOf('store.register')` 会先命中**注释里**提到的
     * `store.register` —— 而这个 handler 的注释里提到它好几次
     *（"流程继续走到原子替换 + `store.register`" 之类）。
     * 于是切片停在注释处，那里当然没有任何 `signal.aborted` → 假红。
     *
     * 真实调用长这样：`const rec = store.register({ type: ..., tag: ... })`。
     * 用 `store.register({` 匹配（带左括号）就能跳过纯文本提及。
     */
    const registerIdx = body.search(/store\.register\(\{/)
    expect(registerIdx, 'runtime:install 里应当有 store.register({...}) 调用').toBeGreaterThan(0)
    const beforeRegister = body.slice(0, registerIdx)
    const abortedCountBefore = (beforeRegister.match(/signal\.aborted/g) ?? []).length
    expect(
      abortedCountBefore > 0,
      `runtime:install 在 store.register 之前没有任何 signal.aborted 检查 ——\n` +
        `  切片长度=${body.length}，register 位置=${registerIdx}，` +
        `register 之前的 signal.aborted 次数=${abortedCountBefore}\n` +
        `  整个 handler 里的 signal.aborted 次数=${(body.match(/signal\.aborted/g) ?? []).length}\n` +
        `用户取消后仍会登记出装了一半的版本（这正是"取消没用"的残留缺陷）`
    ).toBe(true)
  })

  it('runtime:install 里取消检查至少出现在两个关键节点（pip 后 / register 前）', () => {
    const body = handlerBody('runtime:install')
    const count = (body.match(/signal\.aborted/g) ?? []).length
    expect(
      count,
      `runtime:install 里只找到 ${count} 处 signal.aborted 检查。\n` +
        '至少要两处：① pip 跑完之后（校验本体之前）② store.register 之前。\n' +
        '只查一处的话，"校验本体 + 写 meta"这几秒里的取消会被漏掉。'
    ).toBeGreaterThanOrEqual(2)
  })

  it('python:install 必须登记任务并贯通取消信号', () => {
    const body = handlerBody('python:install')
    expect(body.includes('beginTask('), 'python:install 没有登记任务 → 取消按钮是死的').toBe(true)
    expect(body.includes('endTask('), 'python:install 没有释放任务 → 下次安装会被互锁永久挡住').toBe(true)
    expect(body.includes('signal: pySignal'), 'python:install 的取消信号没有传下去').toBe(true)
  })

  it('runtimes:importFile 的取消语义保持（不能被后续改动悄悄拿掉）', () => {
    const body = handlerBody('runtimes:importFile')
    expect(body.includes('throwIfCancelled'), 'importFile 的取消检查被删了').toBe(true)
  })

  it('★ 收尾段 try 之内的失败必须走 emitError（否则会重复发 error）', () => {
    /*
     * 独立复核抓出的真实缺陷（主人 2026-10-08）：
     *
     * 收尾段那个 try 里的失败有两类发送方式：
     *   · `emitError(...)`   → 有 pipErrored 去重
     *   · 手写 `sendDownloadProgress({phase:'error'})` → 不去重
     *
     * 手写的那种在 try 内抛出后，还会被 catch 再接一次，
     * 于是**用户看到两条 error**，而且第二条"装好了文件"与事实不符
     *（那时 rename 还没成功，文件根本没就位）。
     *
     * 这条守卫断言：收尾段 try 之内的错误发送点全部走 emitError。
     * 用"`替换运行时失败` 这三个字附近必须是 emitError"来定位 ——
     * 那两处正是历史上手写发送的地方。
     */
    const body = handlerBody('runtime:install')
    /*
     * ★ 只数**字符串模板里**的那两处，不能把注释里的提及也算进去
     *
     * 我第一版直接用 `/替换运行时失败/g` 数，结果数出 3 处 ——
     * 第 3 处是**注释里**引用这个文案的地方（说明历史缺陷时提到了它）。
     * 守卫自己把注释当代码，就会报一个假的"有一处没走 emitError"。
     *
     * 真实代码长这样：  const full = `替换运行时失败…`
     * 所以匹配**反引号开头**的模板字面量。
     */
    const occurrences = [...body.matchAll(/`替换运行时失败/g)].length
    expect(
      occurrences,
      '应当有两处"替换运行时失败"（旧 dest 挪不开 + 原子替换失败）'
    ).toBeGreaterThanOrEqual(2)

    /*
     * 逐个检查：从这一处往后 1200 字符内必须有 `emitError(`。
     *
     * 为什么给 1200 而不是 400：这两处后面都跟着**解释性长注释**
     *（说明"为什么要走 emitError"），注释本身就把 `emitError(full)`
     * 推到了几百字符之外。窗口太小会误报"没走 emitError"——
     * 我第一版给 400，结果 checked=1/2（假红）。
     */
    let checked = 0
    for (const m of body.matchAll(/`替换运行时失败/g)) {
      const tail = body.slice(m.index ?? 0, (m.index ?? 0) + 1200)
      if (tail.includes('emitError(')) checked++
    }
    expect(
      checked,
      `有两处"替换运行时失败"没有走 emitError（checked=${checked}/${occurrences}）——\n` +
        '它们位于收尾段的 try 之内，手写发送会被 catch 二次收尾，\n' +
        '用户会看到两条 error，且第二条"装好了文件"是事实错误。'
    ).toBe(occurrences)
  })
})

describe('★ 同名碰撞守卫：生成唯一名字的地方必须带随机后缀', () => {
  /**
   * 审查抓出 5 处 `Date.now()` 命名点可能在同一毫秒内撞名。
   * 撞名的后果从"误导性报错"到"备份互相覆盖"不等，
   * 而且都是**偶发**（取决于时序），最难查 —— 所以用守卫钉住。
   */
  const cases: Array<{ file: string; label: string; pattern: RegExp }> = [
    {
      file: join('src', 'main', 'util', 'workdir.ts'),
      label: 'makeStage 的暂存目录',
      pattern: /makeStage[\s\S]{0,600}?randomBytes/
    },
    {
      file: join('src', 'main', 'update', 'runtime-store.ts'),
      label: '删版本的 .deleting- 目录',
      pattern: /\.deleting-\$\{[^}]*\}-?\$\{?randomBytes/
    },
    {
      file: join('src', 'main', 'update', 'updater.ts'),
      label: '更新的 .update-stage- 目录',
      pattern: /\.update-stage-\$\{[^}]*\}-\$\{randomBytes/
    },
    {
      file: join('src', 'main', 'logs', 'logger.ts'),
      label: '导出日志的 .staging- 目录',
      pattern: /\.staging-\$\{[^}]*\}-\$\{randomBytes/
    }
  ]

  for (const c of cases) {
    it(`${c.label} 必须带随机后缀`, () => {
      const src = readFileSync(join(ROOT, c.file), 'utf8')
      expect(
        c.pattern.test(src),
        `${c.file} 的「${c.label}」只用 Date.now() 生成名字 ——\n` +
          '同一毫秒内两次调用会撞名（mkdir/rename 不报错或归因错误），\n' +
          '请加 randomBytes 随机后缀。'
      ).toBe(true)
    })
  }
})
