/*
 * ★★ 换版本弹窗的界面形态（主人 2026-09-27：「这个换版本的界面美观吗」）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ## 评审前的问题（截图里一眼可见）
 * ══════════════════════════════════════════════════════════════════════════
 *
 *   · 十几个版本按钮**清一色实心蓝**糊成一片，看不出哪个是当前版本
 *   · 「取消」跟它们混在同一排 —— 它不是选项，却长得像选项
 *   · 最后一行落单右对齐（flex-wrap 的默认行为），看着像 bug
 *   · 每项都挂一个**完全一样**的「28.1 MB」，纯噪音
 *
 * ## 修法
 *
 * AppDialog 增加"选项列表"形态（`choiceList`）：一行一项、左对齐、
 * 当前项打勾 + 浅色底，取消单独留在底部操作行。
 *
 * ## 这条测试守什么（**为什么必须扫源码**）
 *
 * 我第一次只改了 AppDialog 组件（prop、模板、样式全写好了），
 * 却忘了在 App.vue 的 `<AppDialog>` 上绑 `:choice-list` ——
 * 结果真机上一看，**界面一点变化都没有**，还是那排蓝按钮。
 *
 * 而这类"组件写好了、调用方没接线"的 bug，**渲染组件的单测永远抓不到**：
 * 它们直接给 props，组件本身当然是对的。只有扫调用点才照得出来。
 *
 * 这是本项目反复出现的同一类问题（记忆里至少出现过四次：
 * dashboard 预装、Python 源选择器、日志导出、看门狗计数），
 * 所以这里明确用源码守卫钉住。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const APP = () => readFileSync(join(process.cwd(), 'src', 'renderer', 'src', 'App.vue'), 'utf8')
const DIALOG = () =>
  readFileSync(join(process.cwd(), 'src', 'renderer', 'src', 'AppDialog.vue'), 'utf8')

describe('★换版本弹窗：调用方必须把 choiceList 传下去', () => {
  it('App.vue 的 <AppDialog> 绑定了 :choice-list', () => {
    const src = APP()
    const blocks = src.split('<AppDialog').slice(1)
    expect(blocks.length, '找不到 AppDialog 的用法').toBeGreaterThan(0)
    const anyBound = blocks.some((b) => /:choice-list=/.test(b.slice(0, 1200)))
    expect(
      anyBound,
      'App.vue 没有绑定 `:choice-list` —— AppDialog 里写好的列表形态\n' +
        '（一行一项、当前项打勾、取消单独一行）**永远不会生效**，\n' +
        '界面会退回"十几个实心蓝按钮糊成一片"的老样子。'
    ).toBe(true)
  })

  it('chooseOne 设了 choiceList 且把 current 传下去', () => {
    const src = readFileSync(join(process.cwd(), 'src/renderer/src/composables/useLauncherDialogs.ts'), 'utf8')
    const i = src.indexOf('function chooseOne')
    expect(i, '找不到 chooseOne').toBeGreaterThan(0)
    const body = src.slice(i, i + 2000)
    expect(body, 'chooseOne 要设 choiceList: true').toMatch(/choiceList:\s*true/)
    expect(body, 'chooseOne 必须把 current 传给按钮（当前版本要能一眼认出）').toMatch(
      /current:\s*o\.current/
    )
  })

  it('pickVersion 组装选项时给了 current 标记', () => {
    const src = readFileSync(join(process.cwd(), 'src/renderer/src/composables/useInstanceVersions.ts'), 'utf8')
    const i = src.indexOf('const options = shown.map')
    expect(i, '找不到 pickVersion 里的 options 组装').toBeGreaterThan(0)
    const body = src.slice(i, i + 700)
    expect(body, '当前版本必须标记成 current: true').toMatch(/current:\s*v\.tag === current/)
  })
})

describe('★换版本弹窗：AppDialog 侧的实现要点', () => {
  it('有列表形态的模板与样式（不是只有 prop）', () => {
    const src = DIALOG()
    expect(src, '缺少 .choices 列表容器').toContain('class="choices"')
    expect(src, '缺少选项样式').toMatch(/\.choice\s*\{/)
    expect(src, '当前项要有独立样式（形状区分，不靠颜色堆叠）').toMatch(/\.choice\.on/)
    expect(src, '要有勾位占位（保证有勾/没勾的文字起始位置一致）').toContain('class="tick"')
  })

  it('★取消类按钮不许混进选项列表（它不是选项）', () => {
    const src = DIALOG()
    /*
     * `choiceList` 这个 computed 的职责就是**把取消类排除掉**。
     * 判据是 value 为 null/false —— 项目里所有"取消/不选"都这么写。
     */
    const i = src.indexOf('const choiceList = computed')
    expect(i, '找不到 choiceList computed').toBeGreaterThan(0)
    const body = src.slice(i, i + 500)
    expect(body, '选项列表要排除取消类按钮').toMatch(/value\s*!==\s*null/)
    expect(body, '选项列表要排除取消类按钮').toMatch(/value\s*!==\s*false/)
  })

  it('列表自己可滚动（候选可能有几十个）', () => {
    const src = DIALOG()
    const i = src.indexOf('.choices {')
    expect(i, '找不到 .choices 样式').toBeGreaterThan(0)
    const body = src.slice(i, i + 500)
    expect(body, '候选多时要能滚动，否则又会挤出屏幕').toMatch(/overflow-y:\s*auto/)
    expect(body, '要有高度上限').toMatch(/max-height/)
  })
})
