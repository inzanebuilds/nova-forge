'use strict';
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '..');
const port = 18787;
const server = spawn(process.execPath, [path.join(root,'server','server.js')], { cwd:root, env:{...process.env,NOVA_HOST:'127.0.0.1',NOVA_PORT:String(port),PORT:String(port),NOVA_ACCESS_TOKEN:'smoke-test-token',NOVA_BUILD_WORKER_ENABLED:'false',NOVA_STATIC_BUNDLE_ENABLED:'true'}, stdio:'ignore' });
const base = `http://127.0.0.1:${port}`;
const auth = {'Authorization':'Bearer smoke-test-token'};
const jsonAuth = {'Authorization':'Bearer smoke-test-token','Content-Type':'application/json'};
const wait = ms => new Promise(r=>setTimeout(r,ms));
(async()=>{
  try {
    let ready=false;
    for(let i=0;i<50;i++){try{const r=await fetch(base+'/api/health');if(r.ok){ready=true;break}}catch{} await wait(100)}
    assert.ok(ready,'server should start');
    const page=await fetch(base+'/'); assert.equal(page.status,200,'PWA root should load'); assert.match(await page.text(),/NOVA FORGE/);
    const health=await (await fetch(base+'/api/health')).json(); assert.equal(health.ok,true); assert.equal(health.mode,'local-fallback'); assert.equal(health.authRequired,true); assert.equal(health.buildWorker.containerEnabled,false); assert.equal(health.buildWorker.staticBundleEnabled,true);
    const unauthorized=await fetch(base+'/api/builds'); assert.equal(unauthorized.status,401,'protected APIs should reject missing tokens'); const wrongToken=await fetch(base+'/api/builds',{headers:{Authorization:'Bearer incorrect-token'}}); assert.equal(wrongToken.status,401,'protected APIs should reject incorrect tokens');
    const buildStatus=await fetch(base+'/api/builds',{headers:auth}); assert.equal(buildStatus.status,200); const buildList=await buildStatus.json(); assert.equal(buildList.worker.staticBundleEnabled,true); assert.deepEqual(buildList.jobs,[]);
    const staticBuild=await fetch(base+'/api/builds',{method:'POST',headers:jsonAuth,body:JSON.stringify({name:'Safe static',kind:'Web application',files:{'index.html':'<!doctype html><title>Test</title>','style.css':'body{margin:0}'}})}); assert.equal(staticBuild.status,202); const staticData=await staticBuild.json(); assert.ok(staticData.job.id);
    let completed=null; for(let i=0;i<50;i++){const r=await fetch(base+'/api/builds',{headers:auth}); const d=await r.json(); completed=d.jobs.find(j=>j.id===staticData.job.id); if(completed&&['succeeded','failed'].includes(completed.status))break; await wait(20)} assert.equal(completed.status,'succeeded','static packager should finish without Docker'); assert.equal(completed.artifactAvailable,true);
    const artifactResponse=await fetch(base+'/api/builds/'+staticData.job.id+'/artifact',{headers:auth}); assert.equal(artifactResponse.status,200); const artifactBytes=Buffer.from(await artifactResponse.arrayBuffer()); assert.equal(artifactBytes.readUInt32LE(0),0x04034b50);
    const planRes=await fetch(base+'/api/plan',{method:'POST',headers:jsonAuth,body:JSON.stringify({name:'Smoke App',kind:'Android app',description:'Login and database app'})});
    assert.equal(planRes.status,200); const planData=await planRes.json(); assert.equal(planData.mode,'local-fallback'); assert.ok(planData.plan.tasks.length>=5); assert.ok(planData.plan.tasks.some(t=>t.approvalRequired));
    const chatRes=await fetch(base+'/api/chat',{method:'POST',headers:jsonAuth,body:JSON.stringify({message:'Build a website'})});
    assert.equal(chatRes.status,200); const chat=await chatRes.json(); assert.match(chat.reply,/Local planning fallback/);
    const bad=await fetch(base+'/api/plan',{method:'POST',headers:jsonAuth,body:'{}'}); assert.equal(bad.status,400);
    const oversized=await fetch(base+'/api/plan',{method:'POST',headers:jsonAuth,body:JSON.stringify({description:'x'.repeat(70*1024)})}); assert.equal(oversized.status,413);
    const cors=await fetch(base+'/api/health',{headers:{Origin:'https://untrusted.example'}}); assert.equal(cors.status,403);
    const same=await fetch(base+'/api/health',{headers:{Origin:base}}); assert.equal(same.status,200); assert.equal(same.headers.get('access-control-allow-origin'),base);
    const html=fs.readFileSync(path.join(root,'NOVA_FORGE.html'),'utf8');
    const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]); assert.equal(new Set(ids).size,ids.length,'HTML IDs should be unique');
    const script=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n');
    const handlers=[...html.matchAll(/on(?:click|change|input|submit)="([A-Za-z_$][\w$]*)\(/g)].map(m=>m[1]);
    const functions=[...script.matchAll(/function\s+([\w$]+)\s*\(/g)].map(m=>m[1]);
    assert.deepEqual([...new Set(handlers.filter(h=>!functions.includes(h)))],[],'inline event handlers should resolve to functions');
    const temp=path.join(require('node:os').tmpdir(),'nova-forge-smoke-script.js'); fs.writeFileSync(temp,script);
    const check=spawn(process.execPath,['--check',temp],{stdio:'inherit'}); const exit=await new Promise(resolve=>check.on('exit',resolve)); fs.unlinkSync(temp); assert.equal(exit,0,'client JS syntax should pass');
    const zipTest=spawn(process.execPath,[path.join(__dirname,'zip-smoke.js')],{stdio:'inherit'}); const zipExit=await new Promise(resolve=>zipTest.on('exit',resolve)); assert.equal(zipExit,0,'ZIP writer smoke test should pass');
    const buildTest=spawn(process.execPath,[path.join(__dirname,'build-worker-smoke.js')],{stdio:'inherit'}); const buildExit=await new Promise(resolve=>buildTest.on('exit',resolve)); assert.equal(buildExit,0,'build worker validation tests should pass');
    console.log('PASS: static page, health, bearer-token auth, local plan, chat fallback, static build API/artifact, invalid/oversized request, CORS, unique IDs, inline handlers, client JS syntax, ZIP writer');
  } catch(e) { console.error('FAIL:',e); process.exitCode=1; }
  finally { server.kill('SIGTERM'); }
})();
