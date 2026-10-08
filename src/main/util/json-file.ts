import { readFileSync } from 'fs'

/**
 * 读 JSON 文件，**自动去掉 UTF-8 BOM**。
 *
 * 为什么有这个文件（这条注释是拿用户的真实事故换的）：
 *
 * 用户的 AstrBot 实例里，`data\cmd_config.json` 带 UTF-8 BOM
 * （首字符 U+FEFF）—— AstrBot 是 Python 写的，用 `encoding='utf-8-sig'`
 * 写文件就会有 BOM。而 Node 的 `JSON.parse` **不认 BOM**，直接抛
 * `Unexpected token '\uFEFF'`。
 *
 * 后果（用户报告里连着好几条）：
 *   - 点「查看账密」永远显示读不到，因为读取代码是
 *     `JSON.parse(readFileSync(f, 'utf8'))`，抛错被空 catch 吞了
 *   - 界面上就表现为「一直提示获取中」
 *
 * 而这类写法当时散落在 17 处（creds / instance-repo / layout /
 * mirror-store / runtime-store / updater ...），全都没处理 BOM。
 * 与其每处各写一遍 strip，不如统一收口到这里 —— 以后新增读取点
 * 也不会再踩同一个坑。
 *
 * 顺带把「文件不存在/内容损坏」也归一成抛错，由调用方决定怎么处理
 * （原来调用方各自 try/catch，行为不一致）。
 */
export function readJsonFile<T = unknown>(path: string): T {
  return parseJsonLoose<T>(readFileSync(path, 'utf8'))
}

/** 去掉 BOM 再 parse。文本不是从文件读的时候用这个（如命令行输出）。 */
export function parseJsonLoose<T = unknown>(text: string): T {
  // 只去开头那一个 BOM，正文里的 U+FEFF 是合法内容，不能动
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  return JSON.parse(clean) as T
}
