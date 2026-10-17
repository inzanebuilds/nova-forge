'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createBuildWorker } = require('./build-worker');

// Optional dependency-free .env loader. Process environment always takes precedence.
function loadEnvFile(file) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || match[1].startsWith('#') || process.env[match[1]] !== undefined) continue;
      let value = match[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      process.env[match[1]] = value;
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
loadEnvFile(path.join(__dirname, '.env'));

const ROOT = path.resolve(__dirname, '..');
const WEB_ROOT = path.join(ROOT, 'web');
const HOST = process.env.NOVA_HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || process.env.NOVA_PORT || 8787);
const MODEL_BASE_URL = (process.env.NOVA_MODEL_BASE_URL || '').replace(/\/+$/, '');
const MODEL_NAME = process.env.NOVA_MODEL_NAME || 'qwen2.5-coder:7b';
const MODEL_API_KEY = process.env.NOVA_MODEL_API_KEY || '';
const ACCESS_TOKEN = process.env.NOVA_ACCESS_TOKEN || '';
const BODY_LIMIT = 64 * 1024;
const BUILD_BODY_LIMIT = 12 * 1024 * 1024;
const buildWorker = createBuildWorker();
const RATE_LIMIT = 30;
const WINDOW_MS = 60_000;
const buckets = new Map();
const allowedOrigins = new Set((process.env.NOVA_ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean));
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8', '.webmanifest':'application/manifest+json', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.ico':'image/x-icon', '.txt':'text/plain; charset=utf-8' };

function send(res, status, data, headers = {}) {
  const body = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
  res.writeHead(status, { 'Content-Type': typeof data === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Content-Length': body.length, 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer', 'Cache-Control':'no-store', ...headers });
  res.end(body);
}
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (allowedOrigins.has(origin)) return true;
  try {
    const u = new URL(origin);
    if (req.headers.host && u.host === req.headers.host) return true;
    return ['localhost','127.0.0.1','[::1]'].includes(u.hostname) && Number(u.port || (u.protocol === 'https:' ? 443 : 80)) === PORT;
  } catch { return false; }
}
function isAuthorized(req) {
  if (!ACCESS_TOKEN) return true;
  const header = String(req.headers.authorization || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const provided = Buffer.from(match[1]);
  const expected = Buffer.from(ACCESS_TOKEN);
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}
function rateLimited(req) {
  const key = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.start >= WINDOW_MS) b = { start: now, count: 0 };
  b.count++; buckets.set(key, b);
  if (buckets.size > 5000) for (const [k,v] of buckets) if (now-v.start >= WINDOW_MS) buckets.delete(k);
  return b.count > RATE_LIMIT;
}
function readJson(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [], tooLarge = false;
    req.on('data', chunk => { if (tooLarge) return; size += chunk.length; if (size > limit) { tooLarge = true; chunks = []; return; } chunks.push(chunk); });
    req.on('end', () => { if (tooLarge) return reject(Object.assign(new Error(`Request body exceeds ${Math.round(limit / 1024)} KB`), { status:413 })); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(Object.assign(new Error('Invalid JSON body'), { status:400 })); } });
    req.on('error', reject);
  });
}
function cleanText(value, max = 6000) { return typeof value === 'string' ? value.trim().slice(0,max) : ''; }
function localReply(message) {
  const m = message.toLowerCase(); const steps = [];
  if (/login|account|auth|sign.?in/.test(m)) steps.push('Define authentication, session expiry, and account recovery. Never store plain-text passwords.');
  if (/database|save|sync|user data/.test(m)) steps.push('Design the data model, storage boundaries, migrations, and backup/restore behavior.');
  if (/android|apk|mobile app/.test(m)) steps.push('Confirm minimum Android version, permissions, offline requirements, and Gradle build prerequisites.');
  if (/game|play|level|score/.test(m)) steps.push('Define the core game loop, controls, state transitions, and a small playable test level.');
  if (/api|backend|server|full.?stack/.test(m)) steps.push('Specify API routes, validation, authentication boundaries, and isolated execution requirements.');
  if (!steps.length) steps.push('Write acceptance criteria, sketch the main screen, implement one vertical slice, and test it before expanding.');
  steps.push('Review changes and create a checkpoint before risky edits.');
  return 'Local planning fallback (not a language model):\n\n' + steps.map((s,i)=>`${i+1}. ${s}`).join('\n') + '\n\nConnect a compatible model in the server environment for model-backed responses.';
}
function makePlan(input) {
  const name = cleanText(input.name, 100) || 'Untitled project';
  const kind = cleanText(input.kind, 80) || 'Web application';
  const description = cleanText(input.description || input.message, 6000);
  const d = description.toLowerCase();
  const tasks = [
    { id:'requirements', title:'Confirm requirements and acceptance criteria', risk:'low' },
    { id:'structure', title:'Create the project structure and starter files', risk:'low' },
    { id:'prototype', title:'Implement the smallest usable prototype', risk:'medium' },
    { id:'verify', title:'Run checks and review accessibility, responsiveness, and errors', risk:'low' },
    { id:'release', title:'Review security and release checklist before publishing', risk:'high', approvalRequired:true }
  ];
  if (/login|auth|password|account/.test(d)) tasks.splice(2,0,{id:'auth-review',title:'Review authentication design and secret handling',risk:'high',approvalRequired:true});
  if (/payment|billing|checkout|subscription/.test(d)) tasks.splice(2,0,{id:'payments-review',title:'Review payment-provider requirements and do not enable live charges without approval',risk:'high',approvalRequired:true});
  if (/database|backend|api|server/.test(d) || /api|backend|full-stack/i.test(kind)) tasks.splice(2,0,{id:'backend',title:'Define API contracts, validation, and data persistence',risk:'medium'});
  if (/android|apk/i.test(kind)) tasks.splice(3,0,{id:'android-review',title:'Review Android permissions, SDK compatibility, and build prerequisites',risk:'high',approvalRequired:true});
  return { id:crypto.randomUUID(), name, kind, description, tasks, status:'draft', generatedBy:'local-planner', createdAt:new Date().toISOString(), warning:'This is a planning scaffold, not a verified implementation. Publishing, destructive actions, payments, and security-sensitive changes require explicit review.' };
}
async function modelChat(system, user) {
  if (!MODEL_BASE_URL) return null;
  const headers = { 'Content-Type':'application/json' };
  if (MODEL_API_KEY) headers.Authorization = `Bearer ${MODEL_API_KEY}`;
  const response = await fetch(`${MODEL_BASE_URL}/chat/completions`, { method:'POST', headers, body:JSON.stringify({ model:MODEL_NAME, temperature:0.2, messages:[{role:'system',content:system},{role:'user',content:user}] }), signal:AbortSignal.timeout(55_000) });
  if (!response.ok) throw new Error(`Model provider returned HTTP ${response.status}`);
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('Model provider returned an empty response');
  return content.trim().slice(0,16000);
}
async function api(req, res, url) {
  if (!originAllowed(req)) return send(res,403,{error:'Origin not allowed'});
  if (req.headers.origin) { res.setHeader('Access-Control-Allow-Origin', req.headers.origin); res.setHeader('Vary', 'Origin'); }
  if (req.method === 'OPTIONS') { res.writeHead(204, {'Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type, Authorization','Vary':'Origin'}); return res.end(); }
  if (rateLimited(req)) return send(res,429,{error:'Rate limit reached. Try again in a minute.'});
  if (url.pathname === '/api/health' && req.method === 'GET') return send(res,200,{ok:true,service:'NOVA FORGE API',version:'0.6.0',mode:MODEL_BASE_URL?'model-enabled':'local-fallback',modelConfigured:Boolean(MODEL_BASE_URL),model:MODEL_BASE_URL?MODEL_NAME:null,apiKeyConfigured:Boolean(MODEL_API_KEY),authRequired:Boolean(ACCESS_TOKEN),buildWorker:buildWorker.status(),warning:'Static packaging does not execute project code. Container builds execute untrusted code and require a hardened private deployment.'});
  if (!isAuthorized(req)) return send(res,401,{error:'Authentication required. Add the workspace access token in NOVA FORGE AI Core.'},{'WWW-Authenticate':'Bearer'});
  if (url.pathname === '/api/builds' && req.method === 'GET') return send(res,200,{ok:true,worker:buildWorker.status(),jobs:buildWorker.list()});
  const buildMatch = url.pathname.match(/^\/api\/builds\/([0-9a-f-]{36})(?:\/(logs|artifact|cancel))?$/i);
  if (buildMatch) {
    const [, id, action] = buildMatch;
    if ((!action || action === 'logs') && req.method === 'GET') { const job = buildWorker.get(id); return job ? send(res,200,{ok:true,job,logs:job.log}) : send(res,404,{error:'Build job not found'}); }
    if (action === 'artifact' && req.method === 'GET') { const artifact = buildWorker.getArtifact(id); if (!artifact) return send(res,409,{error:'Artifact is not available yet. Check the job status first.'}); res.writeHead(200,{'Content-Type':'application/zip','Content-Length':artifact.data.length,'Content-Disposition':'attachment; filename="'+artifact.name+'"','X-Content-Type-Options':'nosniff','Cache-Control':'no-store'}); return res.end(artifact.data); }
    if (action === 'cancel' && req.method === 'POST') { const job = buildWorker.cancel(id); return job ? send(res,200,{ok:true,job}) : send(res,404,{error:'Build job not found'}); }
    if (!action && req.method === 'DELETE') { const result = buildWorker.remove(id); return result.status === 200 ? send(res,200,{ok:true}) : send(res,result.status,{error:result.error}); }
    return send(res,405,{error:'Method not allowed for build route'});
  }
  if (!['/api/chat','/api/plan','/api/builds'].includes(url.pathname)) return send(res,404,{error:'API route not found'});
  if (req.method !== 'POST') return send(res,405,{error:'Use POST for this route'});
  let input;
  try { input = await readJson(req, url.pathname === '/api/builds' ? BUILD_BODY_LIMIT : BODY_LIMIT); } catch (e) { return send(res,e.status||400,{error:e.message||'Invalid request'}); }
  if (url.pathname === '/api/builds') { const result = buildWorker.submit(input); return send(res,result.status,result.job ? {ok:true,job:result.job} : {error:result.error}); }
  if (url.pathname === '/api/chat') {
    const message = cleanText(input.message,6000);
    if (!message) return send(res,400,{error:'Message is required'});
    try {
      const reply = await modelChat('You are NOVA FORGE, a careful coding assistant. Be clear about uncertainty. Do not claim you ran code, built an APK, deployed a site, or inspected files unless the tool actually did so. Ask before destructive actions, publishing, payment activation, or security-sensitive changes.',message);
      return send(res,200,{ok:true,mode:reply?'model':'local-fallback',reply:reply||localReply(message)});
    } catch (e) { return send(res,502,{error:'Model request failed. Check server model configuration.',detail:process.env.NODE_ENV==='development'?String(e.message):undefined}); }
  }
  const name = cleanText(input.name,100), kind = cleanText(input.kind,80), description = cleanText(input.description || input.message,6000);
  if (!description) return send(res,400,{error:'Project description is required'});
  if (MODEL_BASE_URL) {
    try {
      const prompt = `Create a concise software implementation plan. Return valid JSON only with keys name, kind, summary, tasks. tasks is an array of objects with title, risk (low, medium, high), and approvalRequired (boolean). Never instruct automatic publishing, destructive changes, payment activation, or secret exposure. Project name: ${name||'Untitled project'}; type: ${kind||'Web application'}; description: ${description}`;
      const content = await modelChat('Return only valid JSON. Make a practical, incremental plan. High-risk changes must require explicit human approval.',prompt);
      let parsed; try { parsed=JSON.parse(content.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'')); } catch { throw new Error('Model plan was not valid JSON'); }
      if (!Array.isArray(parsed.tasks)) throw new Error('Model plan did not contain tasks');
      return send(res,200,{ok:true,mode:'model',plan:{id:crypto.randomUUID(),name:name||cleanText(parsed.name,100)||'Untitled project',kind:kind||cleanText(parsed.kind,80)||'Web application',description,summary:cleanText(parsed.summary,2000),tasks:parsed.tasks.slice(0,30).map((t,i)=>({id:`task-${i+1}`,title:cleanText(t.title,240)||`Task ${i+1}`,risk:['low','medium','high'].includes(t.risk)?t.risk:'medium',approvalRequired:Boolean(t.approvalRequired)})),status:'draft',generatedBy:'model',createdAt:new Date().toISOString(),warning:'Review the plan before implementation. This response has not executed any tasks.'}});
    } catch (e) { return send(res,502,{error:'Could not generate a model-backed plan.',detail:process.env.NODE_ENV==='development'?String(e.message):undefined}); }
  }
  return send(res,200,{ok:true,mode:'local-fallback',plan:makePlan({name,kind,description})});
}
async function staticFile(req,res,url) {
  if (!['GET','HEAD'].includes(req.method)) return send(res,405,'Method not allowed');
  let pathname;
  try { pathname=decodeURIComponent(url.pathname); } catch { return send(res,400,'Bad URL'); }
  if (pathname === '/') pathname='/index.html';
  let target=path.resolve(WEB_ROOT,'.'+pathname);
  if (!target.startsWith(WEB_ROOT+path.sep) && target!==WEB_ROOT) return send(res,403,'Forbidden');
  let stat;
  try { stat=await fs.promises.stat(target); if(stat.isDirectory()) target=path.join(target,'index.html'); } catch { return send(res,404,'Not found'); }
  try { const data=await fs.promises.readFile(target); res.writeHead(200,{'Content-Type':mime[path.extname(target).toLowerCase()]||'application/octet-stream','Content-Length':data.length,'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cache-Control':path.basename(target)==='index.html'?'no-cache':'public, max-age=300'}); if(req.method==='HEAD')return res.end();res.end(data); } catch { send(res,404,'Not found'); }
}
const server=http.createServer(async(req,res)=>{
  let url;try{url=new URL(req.url,'http://localhost')}catch{return send(res,400,'Bad URL')}
  try { if(url.pathname.startsWith('/api/')) await api(req,res,url); else await staticFile(req,res,url); }
  catch(e){ if(!res.headersSent)send(res,500,{error:'Internal server error'}); else res.destroy(); if(process.env.NODE_ENV==='development')console.error(e); }
});
server.listen(PORT,HOST,()=>console.log(`NOVA FORGE server listening on http://${HOST}:${PORT} (mode: ${MODEL_BASE_URL?'model-enabled':'local-fallback'})`));
function shutdown(){server.close(()=>process.exit(0));setTimeout(()=>process.exit(1),3000).unref();}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
