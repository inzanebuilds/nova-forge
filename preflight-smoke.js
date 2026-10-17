'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const html = fs.readFileSync(path.resolve(__dirname, '..', 'NOVA_FORGE.html'), 'utf8');
const start = html.indexOf('function validateProjectFiles(');
const end = html.indexOf('function runPreflight(', start);
assert.ok(start >= 0 && end > start, 'preflight validator must exist');
const source = html.slice(start, end).replace(/function runPreflight\($/, '');
const context = {};
vm.runInNewContext(source + '\nthis.validateProjectFiles = validateProjectFiles;', context);
const validate = context.validateProjectFiles;
const clean = validate({
  'index.html': '<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Test</title></head><body><img src="logo.png" alt="Logo"><script src="app.js"></script></body></html>',
  'logo.png': 'text-placeholder',
  'app.js': 'console.log("ok")'
});
assert.ok(clean.some(c => c.level === 'pass' && c.title === 'Page title found'));
assert.ok(!clean.some(c => c.level === 'error'));
const broken = validate({ 'main.js': 'const x = 1;\nAPI_KEY=hardcoded;\n// TODO later' });
assert.ok(broken.some(c => c.level === 'error' && c.title === 'No HTML entry point'));
assert.ok(broken.some(c => c.level === 'error' && c.title === 'Possible secret in source'));
assert.ok(broken.some(c => c.level === 'info' && c.title === 'TODO marker found'));
const empty = validate({});
assert.equal(empty[0].level, 'error');
const native = validate({ 'MainActivity.kt': 'class MainActivity' }, 'Android app');
assert.ok(!native.some(c => c.level === 'error' && c.title === 'No HTML entry point'));
console.log('PASS: preflight detects missing entry points and secret-like assignments, reports TODOs, and accepts a clean sample');
