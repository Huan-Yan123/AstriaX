/*
 * Bug J：验收旁路 `ACB_DEV_CMD` **不能在生产里生效**
 * ========================================================================
 *
 * ## 坏在哪
 *
 * `defaultCommandFor()`（生成实例启动命令的地方）开头是：
 *
 *     if (process.env.ACB_DEV_CMD) {
 *       return { cmd: process.env.ACB_DEV_CMD, args: ... }
 *     }
 *
 * 这是为了端到端验收注入假运行时而留的旁路。但它**没有环境判断** ——
 * 打包后的成品同样认这个环境变量。
 *
 * 也就是说：任何能在用户机器上设置环境变量的东西都能把
 * 「启动哪个程序」整个替换掉。而 `defaultCommandFor` 的返回值最终会被
 * 拿去 spawn —— 这是本项目里最不该留的口子。
 *
 * ## 判据为什么用 `process.defaultApp`
 *
 *   electron .      → true       （开发态，允许旁路）
 *   打包后的 exe     → undefined  （生产，禁止）
 *   纯 node（单测）  → undefined  （禁止）
 *
 * 这个标志由 electron 自己在启动时设置，**环境变量改不了它**，
 * 所以比 NODE_ENV 之类"用户也能改"的判据可靠。
 *
 * 实测（scripts/_probe-defaultapp.cjs，真跑 electron）：
 *   PROBE_DEFAULTAPP=true
 *   PROBE_IS_PACKAGED=false
 *
 * ## 为什么不能直接删掉这段
 *
 * scripts 里的真机验收靠它注入假运行时；直接删会把那条验收路径一起废掉。
 * 所以是"加环境判断"，不是"删功能"。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { testStage } from '../helpers/stage'
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { defaultCommandFor } from '../../src/main/ipc'

let root: string
const SAVED = { cmd: process.env.ACB_DEV_CMD, args: process.env.ACB_DEV_ARGS }

/**
 * 搭一个**完整**的 AstrBot 环境。
 *
 * 第一版只建了实例目录就去调 defaultCommandFor，结果进真实路径后
 * 抛「AstrBot 运行时结构不对」—— 那是**夹具不全**，不是产物 bug
 * （旁路确实被挡住了，这正是我们要的）。
 * 但断言得区分"被挡后正常走完"和"被挡后崩了"，所以夹具必须齐：
 *   - runtimes.json（store.latest 读它）
 *   - runtimes\a\<tag>\astrbot\（detectLayout 认这个目录）
 *   - runtime\python\python.exe（deps.pythonExe 的来源）
 *   - 实例的 instance.json（runtimeTag 指向那个 tag）
 */
function seedRuntime(tag = 'v9.9.9'): void {
  const rtBase = join(root, 'runtimes')
  const rt = join(rtBase, 'a', tag)
  mkdirSync(join(rt, 'astrbot'), { recursive: true })
  writeFileSync(
    join(rt, 'mxbot-runtime.json'),
    JSON.stringify({ tag, kind: 'pypi', entry: 'astrbot' }),
    'utf8'
  )
  writeFileSync(join(rtBase, 'runtimes.json'), JSON.stringify({ versions: [{ tag, type: 'a' }] }), 'utf8')

  // 内置 Python（resolveLaunchSpec 要求有 pythonExe）
  mkdirSync(join(root, 'runtime', 'python'), { recursive: true })
  writeFileSync(join(root, 'runtime', 'python', 'python.exe'), '', 'utf8')

  // 实例 meta：指向上面这个 tag
  const inst = join(root, 'instances', 'AstrBot', 'a_1')
  mkdirSync(inst, { recursive: true })
  writeFileSync(
    join(inst, 'instance.json'),
    JSON.stringify({ id: 'a_1', name: '测试实例', type: 'a', runtimeTag: tag }),
    'utf8'
  )
}

beforeEach(() => {
  root = testStage('acb-bugj-')
  seedRuntime()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  // 环境变量必须还原，否则会污染同进程里的其它用例
  if (SAVED.cmd === undefined) delete process.env.ACB_DEV_CMD
  else process.env.ACB_DEV_CMD = SAVED.cmd
  if (SAVED.args === undefined) delete process.env.ACB_DEV_ARGS
  else process.env.ACB_DEV_ARGS = SAVED.args
})

function rec() {
  return {
    id: 'a_1',
    name: '测试实例',
    type: 'a' as const,
    dir: join(root, 'instances', 'AstrBot', 'a_1'),
    port: 6100
  }
}

describe('Bug J：启动命令旁路不能在生产生效', () => {
  it('★非开发态下 ACB_DEV_CMD 必须被忽略（纯 node = 非开发态）', () => {
    /*
     * 纯 node 下 process.defaultApp 是 undefined，
     * 与"打包后的成品"是**同一个分支** —— 所以这条用例
     * 正好覆盖了生产路径。
     */
    expect(process.defaultApp, '前提：纯 node 下 defaultApp 应为 undefined').toBeUndefined()

    process.env.ACB_DEV_CMD = 'C:\\Windows\\System32\\calc.exe'
    process.env.ACB_DEV_ARGS = '["--evil"]'

    const spec = defaultCommandFor(rec(), root)

    expect(
      spec.cmd,
      'ACB_DEV_CMD 在生产里生效了！\n' +
        '任何能设置环境变量的东西都能把实例的启动命令替换成任意程序 ——\n' +
        '而它会被直接 spawn。这段旁路必须只在开发态生效\n' +
        '（判据用 process.defaultApp，环境变量改不了它）。'
    ).not.toContain('calc.exe')
    expect(
      JSON.stringify(spec.args ?? []),
      'ACB_DEV_ARGS 也不该在生产里被采纳'
    ).not.toContain('--evil')
  })

  it('★生产路径仍然给出**真实**运行时命令（旁路被挡后功能不能瘸）', () => {
    process.env.ACB_DEV_CMD = 'C:\\Windows\\System32\\calc.exe'

    const spec = defaultCommandFor(rec(), root)

    // 必须有 cmd，而且不能是空串 —— 挡掉旁路不等于返回空
    expect(spec.cmd, '挡掉旁路之后没有给出真实命令').toBeTruthy()
    expect(typeof spec.cmd).toBe('string')
  })

  it('生产路径会把已装好的运行时版本拼进命令（不是随手糊一个）', () => {
    const spec = defaultCommandFor(rec(), root)
    // 把真实返回打出来（断言失败时能直接看出结构，不用猜）
    // eslint-disable-next-line no-console
    console.log('LaunchSpec =', JSON.stringify(spec, null, 2))

    /*
     * AstrBot 的 PyPI 形态是 `python -m astrbot run --port N`，
     * 运行时目录通过**环境变量**（PYTHONPATH / MX_PYTHON）传进去，
     * 所以 cmd/args 里不一定出现 runtimes 路径。
     * 真正的判据是：命令确实指向内置 Python，且带 run 子命令 + 端口。
     */
    const all = spec.cmd + ' ' + (spec.args ?? []).join(' ')
    expect(all, '命令应该用内置 Python').toMatch(/python/i)
    expect(all, 'PyPI 形态必须带 run 子命令（不带会走进交互式 CLI 挂住）').toMatch(/\brun\b/)
    expect(all, '端口必须写进命令').toMatch(/6100/)
  })

  it('旁路代码本身要带环境判断（结构断言，防止以后被"顺手简化"掉）', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'main', 'ipc.ts'), 'utf8')

    /*
     * ## 必须去掉注释再断言
     *
     * 这段旁路的注释里**逐字写着** `process.defaultApp`（解释为什么用它当判据）。
     * 直接在原文上匹配的话，即使把真正的判断删掉，注释里的那处
     * 仍然会让断言通过 —— 假绿。
     *
     * 反向验证实测抓到了这一点：拿掉 `&& process.defaultApp` 之后
     * 只有 1 条用例变红，本该也红的这条没有红。
     */
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .split('\n')
      .map((l) => l.replace(/(^|[^:'"`])\/\/.*$/, '$1'))
      .join('\n')

    const i = code.indexOf('export function defaultCommandFor(')
    expect(i, '找不到 defaultCommandFor').toBeGreaterThan(0)
    // 取到函数体结束
    const open = code.indexOf('{', code.indexOf(')', i))
    let depth = 0
    let end = -1
    for (let k = open; k < code.length; k++) {
      if (code[k] === '{') depth++
      else if (code[k] === '}') {
        depth--
        if (depth === 0) {
          end = k + 1
          break
        }
      }
    }
    const body = code.slice(i, end)

    expect(
      /ACB_DEV_CMD/.test(body),
      'ACB_DEV_CMD 旁路不见了 —— 如果是有意删除，请同时确认 scripts 里的真机验收还能跑'
    ).toBe(true)
    expect(
      /process\.defaultApp/.test(body),
      'ACB_DEV_CMD 旁路缺少开发态判断 —— 它会在打包后的成品里同样生效，\n' +
        '等于把一个"任意命令执行"的口子留在了生产环境'
    ).toBe(true)
  })
})
