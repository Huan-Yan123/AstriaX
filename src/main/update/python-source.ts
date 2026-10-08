/*
 * AstrBot 的 **Python 源**（pip 索引）—— 与 NapCat 的 GitHub 代理源彻底分开。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ## 为什么必须分开（主人 2026-09-26 的指令）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 主人原话：「把 astrbot 从 GitHub 源剥离，单独做一个 python 源来安装
 * astrbot」+「github 源只有 napcat」。
 *
 * 之前两类运行时**共用同一份镜像源列表**（`MirrorState.pref = {a, n}`），
 * 造成两个实际后果：
 *
 *   1. **AstrBot 根本没有可用的源**：内置的 GitHub 代理（gh-proxy.com /
 *      cors.isteed.cc）是给 NapCat 的 release 资产用的；而 AstrBot 的后端
 *      只在 PyPI（`pip install astrbot`）。用户给 AstrBot 选一个"GitHub
 *      代理源"，那个源**列不出任何 AstrBot 版本**，选它也没有意义 ——
 *      因为 AstrBot 的安装从不经过那些代理。
 *
 *   2. **pip 的索引与界面显示不一致**：pip 实际用硬编码的清华源，而界面
 *      让用户给 AstrBot "选源"。用户选 A、pip 走 B —— 显示与真实行为脱节。
 *
 * 现在：AstrBot 的源就是 **pip 索引源**，界面选什么，pip 就用什么；
 * 版本列表也从同一处读。三者一致。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ## ★ 内置表是**实测**出来的，不是抄来的（scripts/test-python-sources.py）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 2026-09-26 逐个真实请求的结果：
 *
 *   清华 TUNA   https://pypi.tuna.tsinghua.edu.cn/simple/
 *               索引 403 Forbidden；/pypi/{pkg}/json 也 403
 *   阿里云      https://mirrors.aliyun.com/pypi/simple/
 *               索引 SSL 握手超时；/pypi/{pkg}/json 404
 *   腾讯云      https://mirrors.cloud.tencent.com/pypi/simple/
 *               索引 **200 / 742ms**（可用）；但 /pypi/{pkg}/json **404**
 *   PyPI 官方   https://pypi.org/simple/
 *               索引 200 / 827ms；元数据 200 / 1871ms
 *               （astrbot 最新 4.28.1，共 168 个版本）；下载 87 KB/s
 *
 * 教训：**国内镜像的 `/pypi/{pkg}/json` 并不存在** —— 那是我照 PyPI
 * 的路径猜的。所以"列版本"这件事**只有 PyPI 官方能做**（至少现在如此）。
 *
 * 由此形成的可靠方案：
 *   · **列版本** → 永远问 PyPI 官方（唯一有元数据接口的）
 *   · **安装/补依赖** → pip 用用户选的源；默认 PyPI 官方（实测唯一三项全通的）
 *   · 腾讯云索引可用，作为**安装加速**的可选项留在表里
 *     （但它不能列版本，所以 note 里写清楚）
 *
 * 全部为 https。**不内置任何需要密钥的源。**
 */

/** 一个 Python（pip）源 */
export interface PythonSource {
  /** 界面显示名 */
  label: string
  /** pip 的 -i 索引地址（末尾带斜杠） */
  indexUrl: string
  /**
   * 列版本用的 JSON 接口模板（`{pkg}` 会被替换成包名）。
   *
   * **为空表示这个源只能装、不能列版本**（国内镜像基本都是这种）。
   * 列版本会回落到 `METADATA_SOURCE`（PyPI 官方）。
   */
  jsonApi?: string
  /** 备注（界面上的小字说明） */
  note?: string
  /** 是否内置（内置的不能删） */
  builtin?: boolean
  /** 传给 pip 的 --trusted-host（只有非 https 或证书有问题的源才需要） */
  trustedHost?: string
}

/**
 * **元数据源**：列版本唯一可靠的地方（实测只有 PyPI 官方有 /pypi/{pkg}/json）。
 *
 * 为什么不把它和"安装源"混为一谈：用户可以为了速度选腾讯云装包，
 * 但列版本必须仍然问 PyPI —— 否则界面会显示"这个源没有 AstrBot"。
 */
export const METADATA_SOURCE: PythonSource = {
  label: 'Python源',
  indexUrl: 'https://pypi.org/simple/',
  jsonApi: 'https://pypi.org/pypi/{pkg}/json',
  builtin: true
}

/**
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 标签就是**一个名字**，不带括号、不带任何后缀
 *   （主人 2026-09-27：「名称只保留 Python源，腾讯源，不要
 *     Python源（推荐），腾讯源（xxx）这样的」）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 演化过程（值得留档，因为改了三轮才到位）：
 *   ① 最初：`PyPI 官方（推荐）` + note「实测唯一可列版本·下载稳定」
 *   ② 中间：`PyPI 官方（PyPI）` —— 去掉了 note，但括号还留着
 *   ③ 现在：`Python源` —— **名字就是名字**，括号全部去掉
 *
 * 为什么不带括号后缀：
 *   · 括号里放"推荐/实测结论"→ 那是**会变的**（我们的实测≠用户网络），
 *     写死在名字里迟早变成谎言
 *   · 括号里放"PyPI/腾讯云"这种重复信息 → 名字本身已经说了，纯冗余
 *   · 界面上一排源的结构是「**名字** + 实测延迟徽章 + 地址」，
 *     名字只承担"这是哪家"，其余信息各有各的字段，不混在一起
 *
 * 于是 `note` 字段在这个表里**不再使用**（保留字段本身是为了兼容
 * 用户自定义源，他们可能想写点提示）。
 */
export const BUILTIN_PYTHON_SOURCES: PythonSource[] = [
  {
    label: 'Python源',
    indexUrl: 'https://pypi.org/simple/',
    jsonApi: 'https://pypi.org/pypi/{pkg}/json',
    builtin: true
  },
  {
    label: '腾讯源',
    indexUrl: 'https://mirrors.cloud.tencent.com/pypi/simple/',
    /*
     * 不填 jsonApi：实测 `/pypi/{pkg}/json` 返回 404。
     * 「能不能列版本」由这个字段**结构性地**决定，不需要再用文字解释。
     */
    builtin: true
  },
  {
    label: '清华源',
    indexUrl: 'https://pypi.tuna.tsinghua.edu.cn/simple/',
    builtin: true
  }
]

/** 默认源（第一个内置项） */
export const DEFAULT_PYTHON_SOURCE = BUILTIN_PYTHON_SOURCES[0]

/**
 * 把 Python 源转成 **pip 命令行参数**。
 *
 * 这是"界面选什么、pip 就用什么"的落点 —— 之前 pip 用的是写死的
 * `PIP_MIRROR_ARGS`（清华源），与界面选择的源无关，属于"显示的和真实行为不一致"。
 * 而清华源实测已 403 —— 那个硬编码会让**所有** pip 安装失败或回落到官方。
 */
export function pythonSourceToPipArgs(src: PythonSource): string[] {
  const args = ['-i', src.indexUrl]
  if (src.trustedHost) args.push('--trusted-host', src.trustedHost)
  return args
}

/**
 * 按 label 或 indexUrl 找一个 Python 源（找不到返回 undefined）。
 *
 * 为什么要能按 indexUrl 找：用户自定义源里存的可能是 indexUrl，
 * 而 mirrors.json 里老数据存的是 label。
 */
export function findPythonSource(
  sources: PythonSource[],
  key: string
): PythonSource | undefined {
  if (!key) return undefined
  const all = [...sources, METADATA_SOURCE]
  return all.find((s) => s.label === key || s.indexUrl === key)
}

/**
 * ★★ 构造 pip 的**源候选链**（首选 → 其余内置 → 用户自定义），用于自动降级。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ## 为什么必须要有这个（主人 2026-09-27 实测的真实故障）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 现象：本地导入 AstrBot 的 whl 报「依赖没装上」，日志里的原始错误是
 *     ERROR: Could not find a version that satisfies the requirement
 *            aiocqhttp>=1.4.4 (from astrbot) (from versions: none)
 *     ERROR: No matching distribution found for aiocqhttp>=1.4.4
 *
 * 查下去发现：用户的配置里 `pref: "清华源"`，而**清华源实测 403
 * Forbidden**（本文件顶部的实测记录早就写着这一点）。
 * 于是 pip 拿着一个 403 的索引去装包 → `(from versions: none)` → 必然失败。
 *
 * 换句话说：**一个源坏了，所有安装就都坏了，而且用户看不出原因。**
 *
 * ## 修法：坏源自动跳过
 *
 * pip 本身**没有**"换个索引再试"的能力（`-i` 只给一个）。
 * 但我们可以在**调用层**做：装失败时换下一个候选源重试。
 *
 * 顺序：**首选源 → 其余内置源（PyPI 官方排在最前）→ 用户自定义源**
 *   · 首选源放第一：尊重用户选择，他可能就是想用加速源
 *   · 内置源按表里顺序（PyPI 官方是第一个 —— 实测三项全通的那个）
 *   · 自定义源垫底：它们最不可控
 *
 * 去重按 indexUrl（同一个源可能既在内置表里、又被用户加过一遍）。
 */
export function pythonSourceCandidates(
  sources: PythonSource[],
  preferred?: PythonSource
): PythonSource[] {
  const out: PythonSource[] = []
  const seen = new Set<string>()
  const push = (s: PythonSource | undefined): void => {
    if (!s || !s.indexUrl) return
    if (seen.has(s.indexUrl)) return
    seen.add(s.indexUrl)
    out.push(s)
  }
  push(preferred)
  for (const s of BUILTIN_PYTHON_SOURCES) push(s)
  for (const s of sources) push(s)
  /*
   * 保底：内置表理论上非空，但万一有人改了它，也不能返回空数组
   *（调用方会拿 candidates[0] 当"主要源"，空数组会炸）。
   */
  push(DEFAULT_PYTHON_SOURCE)
  return out
}

/*
 * ★ `metadataSourceFor` 已删除（第二轮复审的清理）
 *
 * 它原本的作用是"用户选的源若没有元数据接口，就回落到 PyPI 官方"。
 * 但生产代码**从来没有调用过它** —— `version-catalog.ts` 列版本时
 * 直接用 `PYPI_ASTRBOT_JSON` 常量（那是对的：实测只有 PyPI 官方有
 * `/pypi/{pkg}/json` 接口，国内镜像全是 404）。
 *
 * 于是它成了"定义了、有测试、但零生产调用"的死抽象 —— 和第二轮复审
 * 抓到的 `onSourceTried` 同一类。留着它的危害是让人以为"回落机制在起作用"，
 * 而实际靠的是一个常量。删掉，让真实行为一目了然。
 */
