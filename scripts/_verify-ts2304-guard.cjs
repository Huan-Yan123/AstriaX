const fs=require('fs'),path=require('path'),{execFileSync}=require('child_process')
const ROOT=path.join(__dirname,'..')
const F=path.join(ROOT,'src','main','runtime','instance-version.ts')
const GOOD="import { readJsonFile } from '../util/json-file'"
const orig=fs.readFileSync(F,'utf8')
if(!orig.includes(GOOD)){console.error('[FAIL] 锚点失效');process.exit(1)}
const bak=F+'.ruler-bak'
let r
try{
  fs.copyFileSync(F,bak)
  fs.writeFileSync(F, orig.replace(GOOD,'// 撤回：删掉导入'),'utf8')
  console.log('已撤回 readJsonFile 的导入，跑守卫…')
  try{ const o=execFileSync(process.execPath,[path.join(ROOT,'node_modules','vitest','vitest.mjs'),'run','--no-file-parallelism','tests/unit/no-undefined-identifiers.spec.ts'],{cwd:ROOT,encoding:'utf8',timeout:300000}); r={failed:false,out:o} }
  catch(e){ r={failed:true,out:String(e.stdout||'')+String(e.stderr||'')} }
} finally { fs.copyFileSync(bak,F); fs.unlinkSync(bak); console.log('文件已还原') }
const caught = r.failed && /TS2304|readJsonFile/.test(r.out)
console.log(caught ? '✔ 尺子通过：撤掉导入后守卫立刻红' : `✘ 尺子失败（failed=${r.failed}）`)
process.exit(caught?0:1)
