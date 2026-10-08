import { join } from 'path'
import { makeStage } from '../../src/main/util/workdir'

/**
 * 测试用的暂存根目录 —— **与真实数据根严格分开**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 为什么必须分开（主人 2026-09-27 实测的后果）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 原来的实现是：
 *
 *     return makeStage(join(process.cwd(), 'data'), tag)
 *                              ^^^^^^^^^^^^^^^^^^^^^^^ 项目**真实** data
 *
 * 设计意图是好的 —— 注释里写着"绝不用 C 盘临时目录"，因为早年用
 * `os.tmpdir()` 真装 Python/NapCat/AstrBot，反复跑把 C 盘吃掉了 70 多 GB。
 *
 * 但它带来两个**实测出来的**后果：
 *
 * ## ① 4.8 万个测试残留堆在真实数据目录里
 *
 * 实测 `data/cache/tmp` 下有 **925 个残留目录 / 48004 个文件 / 940 MB**：
 *     repo- 189、pip- 179、open- 105、tplver- 105、upd- 84、
 *     inst- 42、audit- 42、real- 42 …
 * 全部是测试建的，而**几乎没有一个测试调 cleanStage 清理**
 *（那个函数存在，但没人用）。设计里说"万一清理失败也留在项目里，
 *  能一眼看见"—— 现实是**每个用例都留**，于是从"看得见"变成"淹掉"。
 *
 * ## ② 它是"删东西卡十几分钟"的直接来源之一
 *
 * 主人报告：删完东西磁盘 100%、测速全超时、打包日志变慢、主进程无响应。
 * 一块入门级 SATA SSD（Colorful SL500）在几万个小文件的删除上，
 * 4K 随机写正好是最弱项 —— 而这堆垃圾让**每一次清理都要在这上面刨**。
 *
 * ## 现在：独立的测试根
 *
 *     <项目>\data-test\<runId>\...      ← 测试全部落这里
 *
 * 这样：
 *   · 测试的运行数据、实例、清单**永远进不了真实 data**
 *   · 跑完一整个目录删掉即可（不用逐个用例清）
 *   · 仍在项目内（不碰 C 盘，保留原来那条教训）
 *
 * `runId` 每个进程一个：多个测试进程并行时不互踩，
 * 而且出问题时能看出"这堆东西是哪一次跑出来的"。
 */

/** 本次测试进程的运行 ID（模块加载时确定一次） */
const RUN_ID = `${process.pid}-${Date.now().toString(36)}`

/** 测试用的数据根（**不是**真实 data） */
export function testDataRoot(): string {
  return join(process.cwd(), 'data-test', RUN_ID)
}

export function testStage(tag: string): string {
  return makeStage(testDataRoot(), tag)
}
