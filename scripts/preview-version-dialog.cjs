#!/usr/bin/env node
/*
 * 「换个版本」弹窗的**视觉预览**（收起态 + 展开态）。
 *
 * ## 为什么单独做预览
 *
 * 走真实流程要：装 NapCat 运行时 → 建实例 → 点卡片菜单 → 点「换个版本」，
 * 一路几分钟，还会改动主人的数据目录。而这次评审的**只有弹窗的样子** ——
 * 它是纯展示组件（props 进、事件出），完全可以脱离后端单独渲染。
 *
 * 用法：node scripts/preview-version-dialog.cjs
 * 然后用浏览器打开 data/cache/tmp/dialog-preview.html
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, 'data', 'cache', 'tmp', 'dialog-preview.html')

/* 与真实场景同形：NapCat 源上 30 个版本、当前用的是 v4.18.19 */
const current = 'v4.18.19'
const tags = [
  'v4.18.28', 'v4.18.27', 'v4.18.26', 'v4.18.18', 'v4.18.15', 'v4.18.14',
  'v4.18.13', 'v4.18.12', 'v4.18.11', 'v4.18.9', 'v4.18.8'
]
const shown = [{ tag: current, sizeMB: 28.1, local: true }, ...tags.map((t) => ({ tag: t, sizeMB: 28.1 }))]
shown.sort((a, b) => (a.tag === current ? -1 : b.tag === current ? 1 : 0))

/* 全部一样的大小不显示（那是噪音）—— 与 pickVersion 里的逻辑一致 */
const sizeVaries = new Set(shown.map((v) => v.sizeMB)).size > 1
const options = shown.map((v) => {
  const bits = [v.tag]
  if (v.local && v.tag !== current) bits.push('已装')
  if (sizeVaries && v.sizeMB) bits.push(`${v.sizeMB} MB`)
  return { text: bits.join('  '), value: v.tag, current: v.tag === current }
})

const CSS = `
  :root {
    --ink: #1f2430; --ink-soft: #5a6172; --hairline: #e6e8ef;
    --primary: #2f6bd8; --primary-deep: #1f4fa8; --danger: #d64545;
    --radius-ctrl: 8px;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px; display: flex; gap: 40px; align-items: flex-start;
    background: linear-gradient(135deg, #eef2fa, #dfe7f5);
    font-family: "Microsoft YaHei UI", "Segoe UI", sans-serif;
  }
  .cap { font-size: 12px; color: var(--ink-soft); margin-bottom: 10px; text-align: center; }
  .dlg {
    width: 380px; background: #fff; border-radius: 18px; padding: 20px 22px 16px;
    box-shadow: 0 18px 48px rgba(20, 24, 34, 0.22);
  }
  h3 { margin: 0 0 8px; font-size: 15.5px; color: var(--ink); }
  .body { margin: 0; font-size: 13px; line-height: 1.65; color: var(--ink-soft); white-space: pre-line; }
  .picker { margin-top: 14px; }
  .picked {
    display: flex; align-items: center; gap: 10px; width: 100%; text-align: left;
    padding: 9px 12px; border-radius: 10px; border: 1px solid var(--hairline);
    background: #fff; color: var(--ink); font-size: 13px;
    font-variant-numeric: tabular-nums; cursor: pointer;
  }
  .picker.open .picked { border-color: var(--primary); background: #2f6bd808; }
  .caret { flex: 0 0 auto; font-size: 9px; color: var(--ink-soft); line-height: 1; }
  .choices { margin-top: 6px; display: flex; flex-direction: column; gap: 6px;
    max-height: 38vh; overflow-y: auto; scrollbar-gutter: stable; }
  .choice {
    display: flex; align-items: center; gap: 10px; width: 100%; text-align: left;
    padding: 9px 12px; border-radius: 10px; border: 1px solid var(--hairline);
    background: #fff; color: var(--ink); font-size: 13px;
    font-variant-numeric: tabular-nums; cursor: pointer;
  }
  .choice.on { border-color: var(--primary); background: #2f6bd810;
    color: var(--primary-deep); font-weight: 600; }
  .choice.current { border-color: #cbd6ea; background: #f4f7fd; }
  .tick { width: 14px; flex: 0 0 14px; text-align: center; color: var(--primary); font-weight: 700; }
  .ctext { flex: 1 1 auto; min-width: 0; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; }
  .nowtag { flex: 0 0 auto; font-size: 11px; font-weight: 400; color: var(--ink-soft);
    border: 1px solid var(--hairline); border-radius: 6px; padding: 1px 6px; background: #fff; }
  .row { display: flex; justify-content: flex-end; flex-wrap: wrap; align-items: center;
    gap: 8px; margin-top: 16px; }
  .btn { border-radius: var(--radius-ctrl); padding: 8px 18px; font-size: 13px;
    border: 1px solid var(--hairline); background: #fff; color: var(--ink-soft); cursor: pointer; }
  .btn.main { border: none; background: var(--primary); color: #fff; }
  .btn:disabled { opacity: .45; cursor: not-allowed; }
`

const BODY_TEXT = `数据和配置都会保留。\n切换会先停掉实例，完成后自动重启。`

/** 渲染一个候选行 */
const row = (o, selected) => `        <button class="choice${selected ? ' on' : ''}${o.current ? ' current' : ''}">
          <span class="tick">${selected ? '✓' : ''}</span>
          <span class="ctext">${o.text}</span>
          ${o.current ? '<span class="nowtag">当前</span>' : ''}
        </button>`

/** 收起态：没选任何项 → 「切换」是灰的 */
const collapsed = `<div class="dlg">
  <h3>「NapCat 实例」切换到哪个版本？</h3>
  <p class="body">${BODY_TEXT}</p>
  <div class="picker">
    <button class="picked"><span class="ctext">${current}</span><span class="caret">▼</span></button>
  </div>
  <div class="row">
    <button class="btn main" disabled title="先在上面选一个版本">切换</button>
    <button class="btn">取消</button>
  </div>
</div>`

/** 展开态 + 已选中 v4.18.26 → 「切换」可点 */
const expanded = `<div class="dlg">
  <h3>「NapCat 实例」切换到哪个版本？</h3>
  <p class="body">${BODY_TEXT}</p>
  <div class="picker open">
    <button class="picked"><span class="ctext">v4.18.26</span><span class="caret">▲</span></button>
    <div class="choices">
${options.map((o) => row(o, o.value === 'v4.18.26')).join('\n')}
    </div>
  </div>
  <div class="row">
    <button class="btn main" title="确认切换到这个版本">切换</button>
    <button class="btn">取消</button>
  </div>
</div>`

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>换版本弹窗预览</title><style>${CSS}</style></head>
<body>
  <div><div class="cap">① 收起态（默认）—— 只显示当前版本，「切换」是灰的</div>${collapsed}</div>
  <div><div class="cap">② 展开态 + 已选中一个 → 「切换」可点</div>${expanded}</div>
</body></html>`

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, html, 'utf8')
console.log('已生成预览：', OUT)
console.log('候选数：', options.length)
