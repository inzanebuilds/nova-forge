'use strict';
const assert = require('node:assert/strict');
const { validateBuildInput, zipStored, createBuildWorker } = require('../server/build-worker');

(async () => {
  const good = validateBuildInput({ name: 'Static demo', kind: 'Web application', files: { 'index.html': '<!doctype html><title>Demo</title>' } });
  assert.ok(good.value, 'valid static project should pass validation');
  assert.equal(good.value.files.length, 1);
  assert.match(validateBuildInput({ files: { '../escape.txt': 'bad', 'index.html': 'x' } }).error, /Unsafe file path/);
  assert.match(validateBuildInput({ files: { '.env': 'SECRET=bad', 'index.html': 'x' } }).error, /Restricted file path/);
  assert.match(validateBuildInput({ files: { 'index.html': 'x'.repeat(2 * 1024 * 1024 + 1) } }).error, /2 MB/);
  assert.match(validateBuildInput({ files: { 'src/app.js': 'x' } }).error, /index.html.*package.json/);
  const zip = zipStored([{ name: 'index.html', data: Buffer.from('<h1>ok</h1>') }]);
  assert.equal(zip.readUInt32LE(0), 0x04034b50, 'artifact ZIP should have local file header');
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50, 'artifact ZIP should have end-of-central-directory record');

  const worker = createBuildWorker({ enabled: false, staticBundleEnabled: true });
  assert.equal(worker.status().containerEnabled, false);
  assert.equal(worker.status().staticBundleEnabled, true);
  assert.equal(worker.status().ready.ok, true, 'static packager should be available without Docker');
  const submitted = worker.submit({ name: 'Safe static', kind: 'Web application', files: { 'index.html': '<h1>ok</h1>', 'style.css': 'body{margin:0}' } });
  assert.equal(submitted.status, 202, 'static site should queue without Docker');
  let job;
  for (let i = 0; i < 50; i++) {
    job = worker.get(submitted.job.id);
    if (job && ['succeeded','failed','cancelled'].includes(job.status)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(job.status, 'succeeded', 'static package job should complete');
  assert.match(job.summary, /No project code was executed/);
  const artifact = worker.getArtifact(submitted.job.id);
  assert.ok(artifact && artifact.data.length > 30, 'successful static job should expose a ZIP artifact');
  assert.equal(artifact.data.readUInt32LE(0), 0x04034b50);
  const dynamic = worker.submit({ name: 'Needs compilation', kind: 'Web application', files: { 'package.json': '{"scripts":{"build":"node build.js"}}', 'index.html': '<h1>x</h1>', 'build.js': 'process.exit(0)' } });
  assert.equal(dynamic.status, 503, 'dynamic project must not execute without enabled container worker');
  assert.match(dynamic.error, /Static HTML\/CSS\/JS projects can be packaged without Docker/);
  const fullyDisabled = createBuildWorker({ enabled: false, staticBundleEnabled: false });
  assert.equal(fullyDisabled.submit({ files: { 'index.html': 'x' } }).status, 503);
  console.log('PASS: input validation, traversal/secret/file-size limits, ZIP format, Docker-free static packaging, artifact retrieval, and dynamic-build fail-closed behavior');
})().catch(error => { console.error(error); process.exitCode = 1; });
