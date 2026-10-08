const fs=require('fs'),path=require('path'),{execFileSync}=require('child_process')
const ROOT=path.join(__dirname,'..')
const F=path.join(ROOT,'src','main','update','mirror-store.ts')
const GOOD=`  if (!isPythonSourceFailed(wanted.indexUrl)) return wanted`
const orig=fs.readFileSync(F,'utf8')
if(!orig.includes(GOOD)){console.error('[FAIL] 锚点失效');process.exit(1)}
function run(){try{const o=execFileSync(process.execPath,[path.join(ROOT,'node_modules','vitest','vitest.mjs'),'run','--no-file-parallelism','tests/unit/bad-source-fallback.spec.ts'],{cwd:ROOT,encoding:'utf8',timeout:300000});return{failed:false,out:o}}catch(e){return{failed:true,out:String(e.stdout||'')+String(e.stderr||'')}}}
const bak=F+'.ruler-bak'
let r
try{ fs.copyFileSync(F,bak); fs.writeFileSync(F, orig.replace(GOOD,'  return wanted  // 撤回：不再跳过坏源'),'utf8'); r=run() }
finally{ fs.copyFileSync(bak,F); fs.unlinkSync(bak); console.log('文件已还原') }
const caught=r.failed && /必须换一个可用的源|not\.toBe/.test(r.out)
console.log(caught?'✔ 尺子通过：撤回"跳过坏源"后测试立刻红':'✘ 尺子失败：没抓到')
process.exit(caught?0:1)
