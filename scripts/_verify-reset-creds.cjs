const fs=require('fs'),path=require('path'),{execFileSync}=require('child_process')
const ROOT=path.join(__dirname,'..')
const P=path.join(ROOT,'src','main','creds','creds.ts')
const GOOD="if (!candidates.includes(ASTRBOT_DEFAULT_PASSWORD)) candidates.push(ASTRBOT_DEFAULT_PASSWORD)"
const orig=fs.readFileSync(P,'utf8')
if(!orig.includes(GOOD)){console.error('[FAIL] 锚点失效');process.exit(1)}

function run(){
  try{ const o=execFileSync(process.execPath,[path.join(ROOT,'node_modules','vitest','vitest.mjs'),'run','--no-file-parallelism','tests/unit/creds-astrbot-password.spec.ts'],{cwd:ROOT,encoding:'utf8',timeout:300000}); return {failed:false,out:o} }
  catch(e){ return {failed:true,out:String(e.stdout||'')+String(e.stderr||'')} }
}
const bak=P+'.ruler-bak'
let r
try{
  fs.copyFileSync(P,bak)
  fs.writeFileSync(P, orig.replace(GOOD,'// 撤回：不再把默认密码当候选'),'utf8')
  r=run()
} finally { fs.copyFileSync(bak,P); fs.unlinkSync(bak); console.log('文件已还原') }

const caught = r.failed && /重置后的密码就是 astrbot|应该显示 astrbot/.test(r.out)
console.log(caught ? '✔ 尺子通过：撤回修复后测试立刻红' : `✘ 尺子失败：没抓到（failed=${r.failed}）`)
if(!caught){ for(const l of r.out.split('\n').filter(l=>/×|→|astrbot/.test(l)).slice(0,6)) console.log('   '+l.trim()) }
process.exit(caught?0:1)
