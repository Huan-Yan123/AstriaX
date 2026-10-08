const fs=require('fs');const {execFileSync}=require('child_process');
const p='src/main/index.ts';const orig=fs.readFileSync(p,'utf8');
if(!orig.includes('appConfig = getConfig()')){console.error('[FAIL] 锚点失效');process.exit(1)}
fs.writeFileSync(p,'src/main/index.ts',orig.replace('appConfig = getConfig()','appConfig = getConfig()\n  const _probe = appConfig.dataRoot'),'utf8');
let out='',failed=false;
try{out=execFileSync(process.execPath,['scripts/self-check.cjs'],{encoding:'utf8',timeout:600000})}catch(e){failed=true;out=String(e.stdout||'')+String(e.stderr||'')}
fs.writeFileSync(p,orig,'utf8');
const named=/裸的 appConfig/.test(out);
console.log(failed&&named?'[OK] 守卫拦住了并指名原因':'[FAIL] 没拦住 (failed='+failed+', named='+named+')');
for(const l of out.split('\n')) if(/裸的 appConfig/.test(l)) console.log('   '+l.trim());
console.log('已还原');
