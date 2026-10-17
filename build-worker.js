'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const MAX_FILES = 200;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
const MAX_JOBS = 10;
const BUILD_TIMEOUT_MS = 5 * 60 * 1000;
const ROOT = path.resolve(__dirname, 'build-workspaces');

function validateBuildInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'Request must be a JSON object.' };
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 100) : 'Untitled project';
  const kind = typeof input.kind === 'string' ? input.kind.trim().slice(0, 80) : 'Web application';
  const source = input.files;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return { error: 'files must be an object mapping relative paths to text content.' };
  const entries = Object.entries(source);
  if (!entries.length) return { error: 'Project has no files.' };
  if (entries.length > MAX_FILES) return { error: `Project exceeds the ${MAX_FILES}-file limit.` };
  const files = [];
  let total = 0;
  for (const [rawName, rawContent] of entries) {
    if (typeof rawName !== 'string' || typeof rawContent !== 'string') return { error: 'Every file path and content must be a string.' };
    const fileName = rawName.replace(/\\/g, '/');
    if (!fileName || fileName.startsWith('/') || /^[A-Za-z]:/.test(fileName) || fileName.includes('\0')) return { error: `Unsafe file path: ${rawName}` };
    const parts = fileName.split('/');
    if (parts.some(part => !part || part === '.' || part === '..')) return { error: `Unsafe file path: ${rawName}` };
    if (parts.some(part => part === '.git' || part === 'node_modules' || /^\.env(?:\.|$)/i.test(part) || /^(?:id_rsa|id_ed25519|known_hosts)$/i.test(part))) return { error: `Restricted file path: ${rawName}` };
    const bytes = Buffer.byteLength(rawContent, 'utf8');
    if (bytes > MAX_FILE_BYTES) return { error: `${rawName} exceeds the 2 MB per-file limit.` };
    total += bytes;
    if (total > MAX_SOURCE_BYTES) return { error: 'Project exceeds the 8 MB total source limit.' };
    files.push({ path: fileName, content: rawContent });
  }
  if (!files.some(f => f.path === 'index.html') && !files.some(f => f.path === 'package.json')) {
    return { error: 'For this worker, include index.html for a static site or package.json for a Node web project.' };
  }
  return { value: { name: name || 'Untitled project', kind: kind || 'Web application', files, allowNetwork: false } };
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zipStored(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dosDate = ((Math.max(1980, now.getFullYear()) - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8); local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10); central.writeUInt16LE(dosTime, 12); central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0, 38); central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}
function safeDisplay(job) {
  return { id: job.id, name: job.name, kind: job.kind, status: job.status, createdAt: job.createdAt, startedAt: job.startedAt || null, finishedAt: job.finishedAt || null, summary: job.summary || '', log: job.log.slice(-200), artifactAvailable: Boolean(job.artifact), error: job.error || null };
}
function dockerReady() {
  const result = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
  return result.status === 0 ? { ok: true, version: String(result.stdout || '').trim() } : { ok: false, detail: result.error?.code === 'ENOENT' ? 'Docker CLI is not installed.' : 'Docker daemon is not available to this server.' };
}
function createBuildWorker(options = {}) {
  const enabled = String(options.enabled ?? process.env.NOVA_BUILD_WORKER_ENABLED ?? 'false').toLowerCase() === 'true';
  const staticBundleEnabled = String(options.staticBundleEnabled ?? process.env.NOVA_STATIC_BUNDLE_ENABLED ?? 'true').toLowerCase() === 'true';
  const allowNetwork = String(options.allowNetwork ?? process.env.NOVA_BUILD_ALLOW_NETWORK ?? 'false').toLowerCase() === 'true';
  const image = String(options.image ?? process.env.NOVA_BUILD_IMAGE ?? 'node:22-alpine');
  const jobs = new Map();
  const queue = [];
  let active = false;

  function status() {
    const runtime = enabled ? dockerReady() : { ok: false, detail: 'Container builds require Docker on a compatible private server.' };
    return {
      enabled: enabled || staticBundleEnabled,
      containerEnabled: enabled,
      staticBundleEnabled,
      networkAllowed: allowNetwork,
      runtime: staticBundleEnabled ? (enabled ? 'static-packager + docker-container' : 'static-packager') : 'docker-container',
      image,
      queueDepth: queue.length,
      active: [...jobs.values()].filter(j => j.status === 'running').length,
      isolation: 'Static packaging never executes project code. Optional container builds use resource limits; network disabled unless explicitly opted in.',
      ready: staticBundleEnabled
        ? { ok: true, detail: enabled ? (runtime.ok ? 'Static packager and Docker worker ready.' : `Static packager ready; container builds unavailable: ${runtime.detail}`) : 'Static packager ready. No Docker is needed for static HTML/CSS/JS projects.' }
        : runtime
    };
  }
  function isStaticOnly(files) {
    const allowed = /\.(?:html?|css|m?js|json|svg|png|jpe?g|gif|webp|ico|txt|xml|webmanifest|md|woff2?|ttf|otf|map)$/i;
    return files.length > 0 && files.some(f => f.path.toLowerCase() === 'index.html') && files.every(f => allowed.test(f.path) && !/(?:^|\/)package(?:-lock)?\.json$/i.test(f.path));
  }
  function submit(input) {
    const checked = validateBuildInput(input);
    if (checked.error) return { status: 400, error: checked.error };
    const staticBundle = staticBundleEnabled && isStaticOnly(checked.value.files);
    if (!staticBundle && !enabled) return { status: 503, error: 'This project needs a container build, but container builds are disabled. Static HTML/CSS/JS projects can be packaged without Docker.' };
    if (!staticBundle) {
      const runtime = dockerReady();
      if (!runtime.ok) return { status: 503, error: runtime.detail };
    }
    if ([...jobs.values()].filter(j => ['queued','running'].includes(j.status)).length >= MAX_JOBS) return { status: 429, error: 'Build queue is full. Wait for an active build to finish or cancel it.' };
    if (jobs.size >= 50) { for (const [oldId, oldJob] of jobs) { if (!['queued','running'].includes(oldJob.status)) { jobs.delete(oldId); if (jobs.size < 40) break; } } }
    const id = crypto.randomUUID();
    const job = { id, name: checked.value.name, kind: checked.value.kind, files: checked.value.files, staticBundle, status: 'queued', createdAt: new Date().toISOString(), log: [staticBundle ? 'Queued for safe static-site packaging; project code will not execute.' : 'Queued for isolated web build.'], summary: 'Waiting for the worker.', artifact: null, error: null, allowNetwork };
    jobs.set(id, job); queue.push(job); pump();
    return { status: 202, job: safeDisplay(job) };
  }
  function pump() {
    if (active) return;
    const job = queue.shift();
    if (!job) return;
    active = true;
    runJob(job).finally(() => { active = false; pump(); });
  }
  async function runJob(job) {
    const work = path.join(ROOT, job.id);
    job.status = 'running'; job.startedAt = new Date().toISOString(); job.summary = job.staticBundle ? 'Packaging static site files.' : 'Preparing isolated build environment.'; job.log.push('Worker started.');
    let child = null, timeout = null;
    try {
      if (job.staticBundle) {
        const entries = job.files.map(file => ({ name: file.path, data: Buffer.from(file.content, 'utf8') }));
        const artifact = zipStored(entries);
        if (artifact.length > MAX_ARTIFACT_BYTES) throw new Error('Static ZIP artifact exceeds the 25 MB download limit.');
        job.artifact = artifact; job.status = 'succeeded'; job.summary = `Static site packaged: ${entries.length} file(s), ${artifact.length} bytes. No project code was executed.`; job.log.push(job.summary);
        return;
      }
      await fs.promises.mkdir(ROOT, { recursive: true, mode: 0o700 });
      await fs.promises.chmod(ROOT, 0o700).catch(() => {});
      await fs.promises.mkdir(work, { recursive: true, mode: 0o777 });
      for (const file of job.files) {
        const target = path.resolve(work, file.path);
        if (!target.startsWith(work + path.sep)) throw new Error('Path safety check rejected a file.');
        await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o777 });
        await fs.promises.writeFile(target, file.content, { mode: 0o666, flag: 'wx' });
      }
      const command = `set -eu; if [ -f package.json ]; then if node -e 'const p=require("./package.json");process.exit((p.dependencies||p.devDependencies)?0:1)'; then if [ -f package-lock.json ]; then npm ci --ignore-scripts --no-audit --no-fund; else npm install --ignore-scripts --no-audit --no-fund; fi; fi; if node -e 'process.exit(require("./package.json").scripts&&require("./package.json").scripts.build?0:1)'; then npm run build; elif [ -f index.html ]; then echo 'No build script; static entry point found.'; else echo 'No build script or static entry point.'; exit 2; fi; elif [ -f index.html ]; then echo 'Static HTML project; no compilation required.'; else echo 'No supported web entry point.'; exit 2; fi`;
      const args = ['run', '--rm', '--init', '--memory=512m', '--cpus=1', '--pids-limit=128', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=128m', '--env', 'npm_config_cache=/tmp/npm-cache', '--user', '1000:1000', '--workdir', '/workspace', '--volume', `${work}:/workspace:rw`, '--network', job.allowNetwork ? 'bridge' : 'none', image, 'sh', '-lc', command];
      job.log.push(`Container image: ${image}`); job.log.push(`Network: ${job.allowNetwork ? 'enabled by explicit server configuration' : 'disabled'}`);
      child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      job.child = child;
      let output = '';
      const collect = (chunk) => { output += chunk.toString('utf8'); if (output.length > 64 * 1024) output = output.slice(-64 * 1024); const lines = output.split(/\r?\n/); output = lines.pop() || ''; for (const line of lines) if (line.trim()) job.log.push(line.slice(0, 1200)); if (job.log.length > 250) job.log.splice(1, job.log.length - 250); };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      const exitCode = await new Promise((resolve, reject) => {
        timeout = setTimeout(() => { job.log.push('Build timed out after five minutes; stopping container process.'); child.kill('SIGTERM'); setTimeout(() => { if (child) child.kill('SIGKILL'); }, 1500).unref(); }, BUILD_TIMEOUT_MS);
        child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
      });
      if (output.trim()) job.log.push(output.trim().slice(-1200));
      if (job.cancelRequested) throw new Error('Build cancelled by request.');
      if (exitCode.code !== 0) throw new Error(`Build container exited with code ${exitCode.code ?? exitCode.signal ?? 'unknown'}.`);
      const artifactEntries = await collectArtifacts(work);
      if (!artifactEntries.length) throw new Error('Build finished but no downloadable files were found.');
      const artifact = zipStored(artifactEntries);
      if (artifact.length > MAX_ARTIFACT_BYTES) throw new Error('Build artifact exceeds the 25 MB download limit.');
      job.artifact = artifact; job.status = 'succeeded'; job.summary = `${artifactEntries.length} file(s) packaged; ${artifact.length} bytes.`; job.log.push(`Artifact ready: ${artifactEntries.length} file(s), ${artifact.length} bytes.`);
    } catch (e) {
      job.status = job.cancelRequested ? 'cancelled' : 'failed'; job.error = String(e.message || e).slice(0, 1000); job.summary = job.error; job.log.push(`ERROR: ${job.error}`);
    } finally {
      if (timeout) clearTimeout(timeout);
      delete job.child; job.finishedAt = new Date().toISOString(); job.files = [];
      await fs.promises.rm(work, { recursive: true, force: true }).catch(() => {});
    }
  }
  async function collectArtifacts(work) {
    const candidates = ['dist', 'build', 'out', 'public'];
    let outputRoot = work;
    for (const candidate of candidates) { const p = path.join(work, candidate); try { if ((await fs.promises.stat(p)).isDirectory()) { outputRoot = p; break; } } catch {} }
    const out = []; let total = 0;
    async function walk(dir, relative = '') {
      const names = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const item of names) {
        if (['node_modules', '.git', '.env', '.cache'].includes(item.name) || item.name.startsWith('.env.')) continue;
        const full = path.join(dir, item.name); const rel = path.posix.join(relative, item.name);
        if (item.isSymbolicLink()) continue;
        if (item.isDirectory()) await walk(full, rel);
        else if (item.isFile()) {
          const stat = await fs.promises.stat(full); total += stat.size;
          if (out.length >= 1000 || total > MAX_ARTIFACT_BYTES) throw new Error('Build output exceeds artifact file/size limits.');
          out.push({ name: rel, data: await fs.promises.readFile(full) });
        }
      }
    }
    await walk(outputRoot);
    return out;
  }
  function get(id) { const job = jobs.get(id); return job ? safeDisplay(job) : null; }
  function list() { return [...jobs.values()].map(safeDisplay).sort((a,b) => b.createdAt.localeCompare(a.createdAt)); }
  function getArtifact(id) { const job = jobs.get(id); return job && job.status === 'succeeded' && job.artifact ? { name: `nova-forge-${id}.zip`, data: job.artifact } : null; }
  function remove(id) { const job = jobs.get(id); if (!job) return { status: 404, error: 'Build job not found' }; if (['queued','running'].includes(job.status)) return { status: 409, error: 'Cancel the active job before removing it.' }; jobs.delete(id); return { status: 200 }; }
  function cancel(id) {
    const job = jobs.get(id); if (!job) return null;
    if (job.status === 'queued') { const index = queue.indexOf(job); if (index >= 0) queue.splice(index, 1); job.status = 'cancelled'; job.finishedAt = new Date().toISOString(); job.summary = 'Cancelled before execution.'; job.log.push(job.summary); job.files = []; }
    else if (job.status === 'running') { job.cancelRequested = true; job.child?.kill('SIGTERM'); }
    return safeDisplay(job);
  }
  return { status, submit, get, list, getArtifact, cancel, remove, validateBuildInput };
}

module.exports = { createBuildWorker, validateBuildInput, zipStored };
