/*
 * 卸载时的数据处置。
 *
 * ## 契约变更史（两次，方向相反，都要看清）
 *
 * 第一次：用户报告「卸载脚本遗漏了 "E:\MXBot\data"」。
 *   实测确认：卸载后程序没了、data\ 还在（27.29 MB，含 cache\pip-cache
 *   与 runtimes\a\v4.26.0 / v4.27.1 / v4.28.0）。
 *   根因：build/installer.nsh 里**只有 customInit / customInstall**，
 *   没有 customUnInstall，electron-builder 默认只删自己写进去的文件。
 *   → 于是加了 customUnInstall，真卸载就把数据一起删。
 *
 * 第二次（当前契约）：用户要求
 *   「卸载器加一个是否保留用户数据的选项，默认保留，
 *     还要加个不舍卸载的选项」。
 *   → 于是**默认变成保留**，只有用户在卸载页明确选择、
 *     或命令行带 --delete-app-data，才真的删。
 *
 * ## 为什么这个文件必须跟着改（否则是假绿）
 *
 * 上一版的断言是「customUnInstall 里出现了 RMDir $R1」——
 * 它只看**有没有出现**，不看**在什么条件下出现**。
 * 我把那些 RMDir 移进 `${If} $R2 == "1"`（用户选了删除）之后，
 * 老断言**照样通过**，但它描述的已经是废弃的契约了：
 * 哪怕代码退化成"无条件删"，这条断言也发现不了。
 *
 * 所以现在断言的是**结构与方向**：
 *   - 保留是默认（静默卸载必须不删）
 *   - 删除被"用户明确要求"守住
 *   - 更新时一律不删
 *   - 卸载页三个选项齐备、默认落在保留上
 * 这些比"有没有 RMDir"强得多，也更贴近用户真实要的行为。
 *
 * 其它要守住的老约束：
 *   1. 不能写死 $INSTDIR\data —— 用户能用 config:moveDataRoot 改路径，
 *      所以要读注册表里记的路径（程序侧写入，见 ipc.ts）
 *   2. 程序侧必须在保存配置时把 dataRoot 写进注册表，否则第 1 条是死代码
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

const ROOT = join(__dirname, '..', '..')
const NSH_RAW = readFileSync(join(ROOT, 'build', 'installer.nsh'), 'utf8')
const IPC = readFileSync(join(ROOT, 'src/main/ipc.ts'), 'utf8')

/**
 * 剥掉 NSIS 注释，只留代码。
 *
 * ## 为什么必须这一步（这次真的踩了）
 *
 * `customUnInstall` 里有一段注释，用来说明 electron-builder 注入的
 * `_isUpdated` 宏长什么样 —— 那段注释**正文里就有一个 `!macroend`**：
 *
 *     *   !macro _isUpdated _a _b _t _f
 *     *     ${StdUtils.TestParameter} $R9 "updated"
 *     *     StrCmp "$R9" "true" `${_t}` `${_f}`
 *     *   !macroend
 *
 * 第一版测试用 `NSH.indexOf('!macroend', i)` 找宏的结尾，
 * 于是**停在了注释里那个 `!macroend` 上** —— 拿到的"宏体"只有开头三行，
 * 后面真正的代码一行都没进来，于是一串断言全红。
 *
 * 红得是对的：注释不是代码，绝不该参与结构判定。
 * 这和项目里 `css-tokens.spec.ts` 踩过的是同一个坑（当时是注释里的
 * `var(--accent)` 被当成真实使用）。所以这里统一先剥注释。
 *
 * 覆盖 NSIS 的三种注释形式：
 *   `;` 到行尾、`#` 到行尾、C 风格块注释。
 * 注意：字符串里若出现 `;` 也会被误剥 —— 对这些**结构性**断言无影响
 * （只找指令和分支，不比对文案），而且比"被注释骗到"安全得多。
 */
function stripNsisComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释
    .replace(/^[ \t]*[;#][^\n]*$/gm, '') // 整行注释
    .replace(/([ \t])[;#][^\n]*/g, '$1') // 行尾注释（保留前面的空白，别粘连）
}

const NSH = stripNsisComments(NSH_RAW)

/** customUnInstall 宏体（在**去注释**后的文本里截到对应的 !macroend） */
function customUnInstallBody(): string {
  const i = NSH.indexOf('!macro customUnInstall')
  expect(i, '找不到 customUnInstall').toBeGreaterThan(0)
  const end = NSH.indexOf('!macroend', i)
  expect(end, 'customUnInstall 没有闭合').toBeGreaterThan(i)
  return NSH.slice(i, end)
}

/**
 * 数据处置页的**建页函数体**。
 *
 * 注意页面控件不在 `customUnWelcomePage` 宏里 —— 那个宏只有一行
 * `UninstPage custom un.mxDataPageCreate un.mxDataPageLeave`（注册页面）。
 * 真正创建按钮、读注册表的是 `Function un.mxDataPageCreate`。
 * 第一版我截的是宏体，于是"要有 3 个单选项"拿到 0 个。
 */
function dataPageBody(): string {
  const i = NSH.indexOf('Function un.mxDataPageCreate')
  expect(i, '找不到数据处置页的建页函数').toBeGreaterThan(0)
  const end = NSH.indexOf('Function un.mxPick1', i)
  expect(end, '找不到建页函数的结束位置').toBeGreaterThan(i)
  return NSH.slice(i, end)
}

describe('卸载脚本要连 data 一起清掉', () => {
  it('installer.nsh 里确实有 customUnInstall 宏', () => {
    expect(NSH, '没有 customUnInstall 就是「删程序、留数据」').toContain(
      '!macro customUnInstall'
    )
    // 宏要闭合，别把后面的东西吞进去
    expect(customUnInstallBody(), '宏没有正常内容').toContain('RMDir')
    expect((NSH.match(/!macro\s+customUnInstall/g) ?? []).length, '只允许定义 1 次').toBe(1)
  })

  it('customUnInstall 里真的删了数据目录（不是只写注释）', () => {
    const body = customUnInstallBody()
    const rmDirs = [...body.matchAll(/RMDir\s+\/r\s+"([^"]+)"/gi)].map((m) => m[1])
    expect(rmDirs.length, 'customUnInstall 里一条 RMDir 都没有').toBeGreaterThan(0)
    expect(
      rmDirs.some((d) => /INSTDIR\\data/i.test(d)),
      '要删 $INSTDIR\\data（默认数据目录）'
    ).toBe(true)
  })

  it('★数据目录位置从注册表读，不写死（用户能改 dataRoot）', () => {
    /*
     * 用户在设置里可以把 dataRoot 改到别的盘（config:moveDataRoot）。
     * 那种情况下 $INSTDIR\data 可能已经空了，真正要删的是配置里那个路径。
     * NSIS 解析 JSON 太脆，所以由程序把路径写进注册表，卸载器读它。
     */
    const body = customUnInstallBody()
    expect(body, '要读注册表里的 DataRoot').toMatch(
      /ReadRegStr\s+\$R\d+\s+HKCU\s+"Software\\MXBot"\s+"DataRoot"/
    )
    // 读到的值要真的被用来删目录
    expect(body, '读到的 DataRoot 要用于 RMDir').toMatch(/RMDir\s+\/r\s+"\$R\d+"/)
  })

  it('程序侧会在保存配置时把 dataRoot 写进注册表（否则上面是死代码）', () => {
    expect(IPC, '没有写注册表的代码，卸载器永远读到空值').toContain(
      'recordDataRootForUninstall'
    )
    // 要写进与卸载器读取**完全一致**的键和值名
    expect(IPC).toMatch(/HKCU\\\\Software\\\\MXBot/)
    expect(IPC).toMatch(/'DataRoot'/)
  })

  it('config:set 与 config:moveDataRoot 两条路径都要记录', () => {
    /*
     * 只在 config:set 记：用户改过 dataRoot 后（moveDataRoot）注册表还是旧路径，
     * 卸载会去删已经不存在的老目录，而真正有数据的目录留下。
     *
     * ## 窗口不能写死固定长度
     *
     * 原来这里切的是 `IPC.slice(moveIdx, moveIdx + 1200)`。这个函数
     * 光是解释「为什么要按端口补杀」就有一大段注释，真实长度远超 1200 ——
     * 于是调用被推到窗口外，断言失败，看起来像"代码漏了记录"。
     * 实际是**测试的窗口太窄**（实测：真实函数体 2 万字符，
     * 调用出现在第 1930 字符处）。
     *
     * 靠字符数来界定"一个函数"本来就是在赌注释长度，而这些注释
     * 恰恰是为了讲清安全约束而写的 —— 越写越容易踩。
     * 改成切到**下一个 handler** 为止：这样函数怎么写都不影响判定。
     */
    const setIdx = IPC.indexOf("'config:set': (patch) =>")
    // 注意别把签名写全：真实签名是 (target: string)，多写一个右括号就 indexOf 不到
    const moveIdx = IPC.indexOf("'config:moveDataRoot': async (target")
    expect(setIdx).toBeGreaterThan(0)
    expect(moveIdx).toBeGreaterThan(0)

    const setBody = IPC.slice(setIdx, moveIdx)
    expect(setBody, 'config:set 里要记录').toContain('recordDataRootForUninstall')

    // 下一个 handler 的名字（用来界定 moveDataRoot 的结束）
    const nextIdx = IPC.indexOf("'app:checkUpdate'", moveIdx)
    expect(nextIdx, '找不到 config:moveDataRoot 后面的 handler，无法界定范围').toBeGreaterThan(
      moveIdx
    )
    const moveBody = IPC.slice(moveIdx, nextIdx)
    expect(moveBody, 'config:moveDataRoot 里也要记录').toContain('recordDataRootForUninstall')
  })

  it('写注册表失败不能影响配置保存（不能抛出去）', () => {
    // 注册表被策略锁死时，最坏结果只是「卸载少删一个目录」，
    // 绝不该让用户连设置都存不上。
    const i = IPC.indexOf('function recordDataRootForUninstall')
    expect(i, '找不到这个函数').toBeGreaterThan(0)
    /*
     * ★ 取函数**真正的边界**，不要用固定长度窗口。
     *
     * 原来是 `IPC.slice(i, i + 1200)` —— 而我后来给这个函数加了一段
     * `app.isPackaged` 的前置检查（约 600 字符），函数变长了，
     * 那 1200 字符就**截不到写注册表的那段 try/catch**，
     * 于是这条测试报「必须整段包在 try/catch 里」——
     * **是取样窗口失效，不是代码真的丢了 try**。
     *
     * 改成从函数开头找到**下一个顶层 `}`**（函数结尾）——
     * 函数怎么长都不会漏，也不会因为"刚好长了一点"而假红。
     */
    const rest = IPC.slice(i)
    const end = rest.indexOf('\n}')
    const body = end > 0 ? rest.slice(0, end) : rest
    expect(body, '必须整段包在 try/catch 里').toMatch(/try\s*\{[\s\S]*catch/)
  })

  it('宏不能重复定义（重复会导致 NSIS 编译失败）', () => {
    const count = (NSH.match(/!macro\s+customUnInstall/g) ?? []).length
    expect(count, 'customUnInstall 定义了 ' + count + ' 次，只允许 1 次').toBe(1)
  })
})

/*
 * ── 新契约：默认保留 + 用户可选删除 + 可取消卸载 ──────────────────────
 */
describe('卸载默认保留用户数据（主人要求：默认保留 + 给选项）', () => {
  it('★删除动作被「用户明确要求」守住，而不是无条件执行', () => {
    /*
     * 这是本次最关键的一条。
     *
     * 老契约是"真卸载就删"，新契约是"默认留、用户选才删"。
     * 判据不能是"存不存在 RMDir"（两种契约都有），
     * 而是"RMDir 在不在一个条件分支里，且那个条件表示用户要求删除"。
     */
    const body = customUnInstallBody()
    // 必须有一个"要不要删"的开关变量
    expect(body, '缺少「是否删除」的判定变量 $R2').toMatch(/StrCpy\s+\$R2\s+"0"/)
    expect(body, '缺少按用户选择置位的分支').toMatch(/\$\{If\}\s*\$R2\s*==\s*"1"/)
    /*
     * 所有 RMDir 都必须落在「$R2 == 1」这个分支**之内**。
     * 做法：把宏体按分支切开，确认删除语句不在分支之前。
     */
    const ifIdx = body.indexOf('${If} $R2 == "1"')
    expect(ifIdx, '找不到「用户要求删除」的分支').toBeGreaterThan(0)
    const before = body.slice(0, ifIdx)
    expect(
      /RMDir\s+\/r/i.test(before),
      '「用户要求删除」分支之前就出现了 RMDir —— 意味着存在无条件删除路径'
    ).toBe(false)
  })

  it('★默认值是保留（静默卸载不显示页面时也必须不删）', () => {
    /*
     * 静默卸载（uninst.exe /S）根本不显示数据处置页，
     * 此时 $mxDataChoice 是空串。
     * 只要"决定要不要删"的逻辑把空串当"保留"，静默卸载就是安全的。
     *
     * 反过来：如果哪天有人把默认值改成"1"（删），
     * 用户点一次静默卸载就会静默地丢光数据 —— 这是最危险的一种退化。
     */
    const body = customUnInstallBody()
    // 先假定保留
    expect(body, '必须以「保留」为初始值').toMatch(/StrCpy\s+\$R2\s+"0"/)
    // 只有两个条件能把 $R2 置成 "1"
    const toOne = [...body.matchAll(/StrCpy\s+\$R2\s+"1"/g)].length
    expect(toOne, '$R2 被置为 "1" 的地方应恰好 2 处（命令行 / 页面选择）').toBe(2)
    // 且这两处分别对应 --delete-app-data 与页面的 "2"
    expect(body, '要认 --delete-app-data').toMatch(/TestParameter\}\s*\$R9\s+"delete-app-data"/)
    expect(body, '要认页面上选的「一起删除」($mxDataChoice == "2")').toMatch(
      /\$\{If\}\s*\$mxDataChoice\s*==\s*"2"/
    )
  })

  it('★更新时一律不删（这次改动不能破坏原有保护）', () => {
    const body = customUnInstallBody()
    const upd = body.indexOf('${IfNot} ${isUpdated}')
    expect(upd, '删除逻辑必须包在 ${IfNot} ${isUpdated} 里').toBeGreaterThan(0)
    // 所有 RMDir 都要在 isUpdated 守卫**之内**
    const rmIdx = body.search(/RMDir\s+\/r/i)
    expect(rmIdx, '有 RMDir').toBeGreaterThan(0)
    expect(rmIdx, 'RMDir 出现在 isUpdated 守卫之外 —— 更新会删数据').toBeGreaterThan(upd)
  })

  it('★保留数据时不许删 keep 目录（那里可能藏着唯一一份数据）', () => {
    /*
     * RESTORE 失败时弹框承诺「你的数据还在 $mxKeepDir\payload」。
     * 如果"保留"这条路径也把 keep 删掉，那个承诺就是假的。
     * 所以删 keep 只能在"用户要求删除"的分支里。
     */
    const body = customUnInstallBody()
    const ifIdx = body.indexOf('${If} $R2 == "1"')
    const keepIdx = body.indexOf('RMDir /r "$mxKeepDir"')
    expect(keepIdx, '要删 keep 目录').toBeGreaterThan(0)
    expect(keepIdx, 'RMDir $mxKeepDir 跑到了「用户要求删除」分支之外').toBeGreaterThan(ifIdx)
  })
})

/*
 * ══════════════════════════════════════════════════════════════════════════
 * 覆盖更新 = **原地覆盖**，不做多余的搬家往返（主人 2026-09-24 的要求）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ## 先说清"覆盖"到底是怎么发生的（读 electron-builder 模板确认）
 *
 * installSection.nsh:52 会调用旧卸载器，实际命令行是：
 *     ExecWait '"<旧卸载器>" /S /KEEP_APP_DATA /currentuser --updated _?=<安装目录>'
 *   · `/KEEP_APP_DATA` + `--updated` → 我们的 customUnInstall 跳过删数据
 *   · `_?=` 原地模式 → 保留 $INSTDIR，随后新版文件**直接盖上去**
 * 所以"安装包会把旧版卸掉再装"这个印象是不准确的 —— 文件层面确实是覆盖。
 *
 * ## 那"多余的操作"是什么
 *
 * 是**我们自己**在 customInit 里做的 STASH：把整个 data 目录 Rename 到
 * 安装目录旁边（`<安装目录>-update-keep\payload`），装完再搬回来。
 * 它当年是必需的：**改名前的旧卸载器会无条件 RMDir /r $INSTDIR**，
 * 只能把数据挪到它够不着的地方。
 *
 * 现在卸载器已经带 `--updated` 守卫了，所以对**默认位置**（数据就在
 * `$INSTDIR\data`）来说，这次搬家纯属往返开销。
 *
 * ## 但我不删它 —— 改成"条件搬家"
 *
 * 万一用户机器上跑的是改名前的旧卸载器，搬家就是救命的。
 * 所以保留 STASH，只加一条快路径：**数据在默认位置且指针没迁移过**时跳过。
 * 下面两个用例一个钉"跳过条件"，一个钉"该搬的时候仍然搬"。
 */
describe('★覆盖更新必须走搬家（这条是拿用户数据换来的，不许再加"快路径"）', () => {
  const stashBody = (): string => {
    const i = NSH.indexOf('!macro MXBOT_STASH_KEEP')
    expect(i, '缺少 MXBOT_STASH_KEEP').toBeGreaterThan(0)
    return NSH.slice(i, NSH.indexOf('!macroend', i))
  }

  /*
   * ══════════════════════════════════════════════════════════════════════════
   * ★ 这组测试的前身是**假绿**的（必须记住这个教训）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * 2026-09-26 我曾按"覆盖应该是原地覆盖、不要多余搬家"的思路加了一条
   * `MXBOT_SKIP_STASH` 快路径，并写了三条 vitest 断言。它们**全绿**，
   * 但真机 e2e 是**红的**：
   *
   *     node scripts/test-installer-e2e.cjs
   *     [5] 完整覆盖更新流程
   *       ✘ 覆盖更新后：数据完好 ← config.json / 实例数据 / 运行时 全 GONE
   *
   * 原因：三条断言只匹配**源码里的字符串与出现顺序**，
   * 把 `StrCpy $R8 "1"` 改成恒 "1"（=必定丢数据）它照样全绿。
   *
   * 所以现在的断言改成**方向性**的：
   *   · 绝不允许存在"跳过搬家"的分支（$R8 必须恒为 0）
   *   · 搬家那两条路径（同盘 Rename / 跨盘摘注册表）必须都在
   * 并且这个 describe 的注释里直接写明：**数据安全的最终证据是真机 e2e，
   * 单测只能防"手滑删掉搬家逻辑"**。
   *
   * 真机 e2e：`node scripts/test-installer-e2e.cjs`（CASE 5 是关键那条）
   */
  it('★不许存在"跳过搬家"的分支（$R8 必须恒为 0）', () => {
    const body = stashBody()
    /*
     * 这是最硬的一条：只要有人把 $R8 置成 "1"，数据就会在更新时被
     * electron-builder 的 atomicRMDir 搬进 $PLUGINSDIR 后销毁。
     * 断言"源码里不存在把 $R8 设为 1 的语句"。
     */
    const setsToOne = /\bStrCpy\s+\$R8\s+"1"/.test(body)
    expect(
      setsToOne,
      '出现了把 $R8 置为 "1" 的语句 —— 那会跳过数据搬家，' +
        '而 electron-builder 的 un.atomicRMDir 会把 $INSTDIR\\data 搬进 ' +
        '$PLUGINSDIR 后随进程销毁（用户数据永久丢失）。\n' +
        '真机验证：node scripts/test-installer-e2e.cjs 的 CASE 5。'
    ).toBe(false)

    // 必须有明确的"恒搬家"赋值，防止有人用别的写法绕过上面那条
    expect(body, '$R8 应当被显式置为 "0"（恒走搬家）').toMatch(/\bStrCpy\s+\$R8\s+"0"/)
  })

  it('★搬家逻辑必须完整保留（同盘 Rename + 跨盘摘注册表两条路）', () => {
    const body = stashBody()
    // 同盘：把数据目录改名到 keep
    expect(body, '同盘必须 Rename 数据目录（躲开模板的整目录改名）').toMatch(/Rename\s+"\$R6"/)
    // 跨盘：Rename 会失败，必须退化成"临时摘掉注册表 DataRoot"
    expect(body, '跨盘时要把注册表 DataRoot 临时摘掉').toMatch(/DeleteRegValue\s+HKCU\s+"Software\\MXBot"\s+"DataRoot"/)
    // 记下原位置，装完要放回去
    expect(body, '要记下数据原位置（装完放回去）').toMatch(/origin\.txt/)
  })

  it('★搬家前必须抢救 data-root.txt 指针', () => {
    /*
     * 指针丢了 = 更新完第一次启动退回默认位置、弹首启向导，
     * 用户会以为"更新把数据弄没了"；若他顺手把旧目录删掉，
     * 迁移到别处的真数据就再也想不起来。
     */
    const restoreIdx = NSH.indexOf('!macro MXBOT_RESTORE_KEEP')
    const restoreBody = NSH.slice(restoreIdx, NSH.indexOf('!macroend', restoreIdx))
    expect(restoreBody, 'RESTORE 要把指针放回安装目录').toMatch(/rootpointer\.txt/)

    const stashBody2 = stashBody()
    expect(stashBody2, 'STASH 要先把指针抢救出来').toMatch(
      /MXBOT_ROOT_POINTER|rootpointer\.txt/
    )
  })
})

describe('卸载器界面：数据处置页', () => {
  it('注册了自定义卸载欢迎页（必须早于删除，否则问了也晚了）', () => {
    /*
     * 时机是这一页的全部意义。
     * 卸载器的页面顺序（assistedInstaller.nsh:65-81）：
     *   UNPAGE_WELCOME ← 数据选择放这里
     *   PAGE_INSTALL_MODE
     *   UNPAGE_INSTFILES ← 到这里才开始删
     *   customUninstallPage ← electron-builder 给的钩子，太晚了
     *   UNPAGE_FINISH
     */
    const i = NSH.indexOf('!macro customUnWelcomePage')
    expect(i, '缺少 customUnWelcomePage').toBeGreaterThan(0)
    const body = NSH.slice(i, NSH.indexOf('!macroend', i))
    expect(body, '要用 UninstPage custom 注册自绘页').toMatch(/UninstPage\s+custom\s+un\.\w+/)
    // 确认没有误用"删除之后"的那个钩子
    expect(NSH, '不该把数据选择放在删除之后的 customUninstallPage').not.toContain(
      '!macro customUninstallPage'
    )
  })

  it('三个选项齐备：保留 / 删除 / 先不卸载', () => {
    /*
     * 主人原话：「加一个是否保留用户数据的选项，默认保留，
     *           还要加个不舍卸载的选项」。
     * 三条文案都要真的出现在界面上（不是只在注释里）。
     * 剥注释之后还能找到，才说明它是真的被 CreateRadioButton 用了。
     *
     * 措辞后来又按「卸载器也是一样的，可爱文案」调过一次。
     * 所以这里断言的判据放宽到**语义关键词**，不锁死整句字面：
     * 可爱风还会继续微调措辞，锁死全文会让每次改文案都要改测试，
     * 而真正要守住的是"三个选项都在、危险提示没被可爱吃掉"。
     */
    expect(NSH, '要有「保留数据」选项').toMatch(/留着数据|保留.{0,4}数据/)
    expect(NSH, '要有「连数据一起删掉」选项').toMatch(/连数据一起删|连同.{0,4}数据.{0,4}删/)
    expect(NSH, '要有「先不卸载」选项').toMatch(/先不卸载/)
  })

  it('★危险选项必须把后果说清楚（可爱不能吃掉准确性）', () => {
    /*
     * 这是"可爱文案"最容易踩的坑：把「连数据一起删掉」写成
     * 「一口气全清光光啦~」这种，好看但**没说明后果**。
     * 数据删掉是不可逆的，用户必须看懂。
     *
     * 所以这一条单独钉住：删除选项的文案里要有"找不回来"这类明确措辞。
     * 语气词可以有，但后果不能省。
     */
    const body = dataPageBody()
    // 取「连数据一起删」那个单选项的整行
    const line = body
      .split('\n')
      .find((l) => /NSD_CreateRadioButton/.test(l) && /连数据一起删|连同.{0,4}数据.{0,4}删/.test(l))
    expect(line, '找不到"删除数据"那个选项行').toBeTruthy()
    expect(line, '删除选项必须写明"删了就找不回来"之类的后果').toMatch(
      /找不回来|不可恢复|无法恢复|永久删除/
    )
  })

  it('★默认勾选「保留」', () => {
    const body = dataPageBody()
    // 三个按钮都创建了
    const radios = [...body.matchAll(/NSD_CreateRadioButton/g)].length
    expect(radios, '要有 3 个单选项').toBe(3)
    // 默认值必须是保留，且落在第 1 个按钮上
    expect(body, '默认选中「保留」(mxDataChoice = "1")').toMatch(/StrCpy\s+\$mxDataChoice\s+"1"/)
    expect(body, '默认勾选第 1 个按钮').toMatch(/\$\{NSD_SetState\}\s+\$mxR1\s+\$\{BST_CHECKED\}/)
  })

  it('★三个选项真正互斥（不能同时选中两个）', () => {
    /*
     * NSD_CreateRadioButton 生成的按钮各带 WS_GROUP，按 Win32 规则
     * 会各自成为独立分组 —— 点第二个时第一个不会自动取消。
     * 在"删除数据"这种场景里，能同时选中两个是不可接受的歧义。
     * 所以每个按钮都挂了 onClick 手动管，这里验证三个函数都在。
     */
    for (const n of ['1', '2', '3']) {
      expect(NSH, `缺少 un.mxPick${n}（选项 ${n} 的互斥处理）`).toContain(`Function un.mxPick${n}`)
    }
    const body = NSH.slice(
      NSH.indexOf('Function un.mxPick1'),
      NSH.indexOf('Function un.mxDataPageLeave')
    )
    // 每个 pick 函数都要把另外两个取消
    expect(
      [...body.matchAll(/\$\{NSD_SetState\}\s+\$\w+\s+\$\{BST_UNCHECKED\}/g)].length,
      '每个选项都要把另外两个取消'
    ).toBeGreaterThanOrEqual(6)
  })

  it('★选「先不卸载了」会真的什么都不做就退出', () => {
    const i = NSH.indexOf('Function un.mxDataPageLeave')
    expect(i, '缺少页面离开处理').toBeGreaterThan(0)
    const body = NSH.slice(i, NSH.indexOf('!macro customInit', i))
    // 选第 3 项 → Quit（不是 Abort：Abort 会卡在本页出不去）
    expect(body, '要判断第 3 个选项').toMatch(/\$\{NSD_GetState\}\s+\$mxR3/)
    expect(body, '选「先不卸载」必须 Quit').toMatch(/Quit/)
  })

  it('数据处置页显示的路径与 customUnInstall 用的是同一套规则', () => {
    /*
     * 如果页面说"你的数据在 A"、实际删的却是 B，用户就被误导了。
     * 两处都必须是：先读注册表 DataRoot，空则退回 $INSTDIR\data。
     */
    const page = dataPageBody()
    expect(page, '页面要读注册表 DataRoot').toMatch(
      /ReadRegStr\s+\$R\d+\s+HKCU\s+"Software\\MXBot"\s+"DataRoot"/
    )
    expect(page, '注册表为空时要退回 $INSTDIR\\data').toMatch(/\$INSTDIR\\data/)
  })
})

describe('卸载脚本本身是合法的 NSIS', () => {
  it('所有 !macro 都有配对的 !macroend', () => {
    const macros = (NSH.match(/!macro\s+\w+/g) ?? []).length
    const ends = (NSH.match(/!macroend/g) ?? []).length
    expect(ends, `宏 ${macros} 个但 macroend ${ends} 个`).toBeGreaterThanOrEqual(macros)
  })

  it('没有留下解析 JSON 留下的 StrFunc 依赖（那套又脆又要额外声明）', () => {
    /*
     * 曾经想用 StrLoc/StrRep 抠 config.json，但那需要为卸载器单独
     * 声明 UnStrLoc 之类的函数，稍有差池整个安装包编译不过。
     * 现在改走注册表，这些宏不该再出现。
     */
    const body = customUnInstallBody()
    expect(/\$\{StrLoc\}|\$\{StrRep\}|\$\{TrimNewLines\}/.test(body)).toBe(false)
  })

  it('图标等打包资源仍在（别在改脚本时误删）', () => {
    const yml = readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8')
    expect(yml).toContain('extraResources')
    expect(existsSync(join(ROOT, 'build', 'icon.png'))).toBe(true)
  })
})

describe('安装器界面：只改文案，不改样式', () => {
  /*
   * ## 契约变更史（这一块也变过一次，方向是"收窄"）
   *
   * 第一版我按「安装器界面也要改成软件风格」做了：
   * 自绘欢迎页（26pt 大字 AstriaX）、品牌配色、自绘外壳、
   * 外加从 logo 生成的三张向导图（侧栏/头图）。
   *
   * 主人看过实际界面后说：「那就只改文案，不改图标和样式吧」。
   * 所以现在断言的是**收窄后**的契约：
   *   ✔ 文案是自家的（AstriaX 安装向导 / 安装完成）
   *   ✔ 完成页保留「装完启动」的勾（这是**功能**，不是样式）
   *   ✘ 不再有自绘页面、配色覆盖、向导图
   *
   * 保留「勾」这一条特别重要：它跟样式无关 ——
   * 定义 customFinishPage 会整段跳过默认完成页，连带那个勾一起没了，
   * 用户装完就少一个"立刻打开"的入口。这是功能回归，必须守住。
   */
  it('欢迎页与完成页用的是自家文案', () => {
    expect(NSH, '缺少自定义欢迎页').toContain('!macro customWelcomePage')
    expect(NSH, '缺少自定义完成页').toContain('!macro customFinishPage')
    // 欢迎页标题（主人指定：「直接就写 AstriaX 安装向导」）
    expect(NSH, '欢迎页标题要是「AstriaX 安装向导」').toContain('AstriaX 安装向导')
    // 完成页标题
    expect(NSH, '完成页要有自家标题').toContain('AstriaX 安装完成')
  })

  it('★欢迎页回到原生 MUI 页（主人要求不改样式）', () => {
    /*
     * 自绘页（`Page custom`）属于"改样式"，已被撤掉。
     * 这里针对宏体断言 —— 全文里卸载器的数据处置页仍然合法地
     * 使用 `UninstPage custom`（那是功能，不是安装器样式）。
     */
    const i = NSH.indexOf('!macro customWelcomePage')
    expect(i, '找不到 customWelcomePage').toBeGreaterThan(0)
    const body = NSH.slice(i, NSH.indexOf('!macroend', i))
    expect(body, '欢迎页要用原生 MUI_PAGE_WELCOME').toContain('MUI_PAGE_WELCOME')
    expect(body, '欢迎页不该再用自绘页').not.toContain('Page custom')
  })

  it('★没有留下自绘样式的痕迹（配色覆盖 / 外壳钩子）', () => {
    for (const [needle, why] of [
      ['MUI_BGCOLOR', 'MUI 配色覆盖属于"改样式"'],
      ['MUI_TEXTCOLOR', 'MUI 配色覆盖属于"改样式"'],
      ['MUI_DIRECTORYPAGE_BGCOLOR', 'MUI 配色覆盖属于"改样式"'],
      ['MUI_CUSTOMFUNCTION_GUIINIT', '自绘外壳钩子属于"改样式"'],
      ['MX_UI_', '自绘颜色 define 属于"改样式"']
    ] as Array<[string, string]>) {
      // 注释里提到这些名字（说明历史）是允许的，所以只看**代码行**
      const codeLines = NSH.split('\n').filter((l) => {
        const t = l.trim()
        return !t.startsWith(';') && !t.startsWith('*') && !t.startsWith('/*')
      })
      const hit = codeLines.some((l) => l.includes(needle))
      expect(hit, `${needle} 仍在代码里（${why}）`).toBe(false)
    }
  })

  it('★完成页仍然保留「装完启动」的勾（否则用户少了入口）', () => {
    /*
     * assistedInstaller.nsh 的默认完成页带一个"运行程序"勾，
     * 但一旦定义 customFinishPage，那段默认代码整段被跳过
     * （!ifmacrodef / !else 的关系），勾和它的函数一起消失。
     * 所以必须自己补回来 —— 这是**功能**，不随"不改样式"一起撤。
     */
    expect(NSH, '要定义启动函数').toMatch(/Function\s+mxStartApp/)
    expect(NSH, '要保留运行勾').toContain('MUI_FINISHPAGE_RUN')
    expect(NSH, '运行勾要指向自己的函数').toMatch(/MUI_FINISHPAGE_RUN_FUNCTION\s+"mxStartApp"/)
    // --updated 语义不能丢：覆盖更新后启动要带上它
    expect(NSH, '启动函数要保留 --updated 语义').toMatch(/--updated/)
  })

  it('★electron-builder.yml 不再引用向导图（它们属于"图标和样式"）', () => {
    /*
     * 之前设过 installerSidebar / uninstallerSidebar / installerHeader。
     * 撤掉之后 yml 里不该再出现它们 —— 否则打包又会把品牌图塞进向导，
     * 跟主人"不改样式"的要求相反。
     */
    const yml = readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8')
    const codeLines = yml.split('\n').filter((l) => !l.trim().startsWith('#'))
    for (const key of ['installerSidebar', 'uninstallerSidebar', 'installerHeader']) {
      const hit = codeLines.some((l) => new RegExp(`^\\s*${key}\\s*:`).test(l))
      expect(hit, `yml 里不该再设 ${key}（属于"改样式"）`).toBe(false)
    }
  })

  it('软件自身的图标仍在（那是 logo，主人只说不改安装器样式）', () => {
    const yml = readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8')
    expect(yml).toContain('extraResources')
    expect(existsSync(join(ROOT, 'build', 'icon.png'))).toBe(true)
    // win.icon 指向的图标要在（程序/安装包图标）
    expect(yml, 'win.icon 仍应指向 build/icon.png').toMatch(/icon:\s*build\/icon\.png/)
  })
})
