import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Connection } from '../lib/connection.mjs';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cdx-test-'));
process.env.CDX_HOME = tmp;
const { Thread, thread, forget, all } = await import('../lib/threads.mjs');
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
class Socket extends EventEmitter {
  readyState = 1;
  send(data, cb) { this.sent = JSON.parse(data); cb?.(); }
  terminate() { this.readyState = 3; this.emit('close'); }
}
test('RPC resolves, times out, and rejects pending calls on disconnect', async () => {
  const ws = new Socket(), conn = new Connection(ws);
  const p = conn.request('read', {});
  ws.emit('message', JSON.stringify({ id: ws.sent.id, result: { ok: true } }));
  assert.deepEqual(await p, { ok: true });
  await assert.rejects(conn.request('hang', {}, { timeoutMs: 10 }), /outcome unknown/);
  await assert.rejects(conn.request('closed', {}), /closed/);
  const ws2 = new Socket(), c2 = new Connection(ws2);
  const pending = c2.request('read', {}); ws2.terminate();
  await assert.rejects(pending, /closed/);
});
test('corrupt index is reported and preserved', () => {
  fs.writeFileSync(path.join(tmp, 'threads.json'), '{broken');
  assert.throws(() => thread('x'), /cannot read/);
  assert.equal(fs.readFileSync(path.join(tmp, 'threads.json'), 'utf8'), '{broken');
});
test('parallel processes cannot lose index updates', async () => {
  const entries = Array.from({ length: 16 }, (_, i) => ({ name: `t${i}`, id: `id${i}`, cwd: tmp }));
  fs.writeFileSync(path.join(tmp, 'threads.json'), JSON.stringify(entries));
  const moduleUrl = new URL('../lib/threads.mjs', import.meta.url).href;
  await Promise.all(entries.map(e => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `import {forget} from ${JSON.stringify(moduleUrl)}; forget(${JSON.stringify(e.name)});`], { env: process.env });
    let err = ''; child.stderr.on('data', d => err += d);
    child.on('error', reject); child.on('exit', code => code ? reject(new Error(err)) : resolve());
  })));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tmp, 'threads.json'))), []);
});
test('diff includes committed and uncommitted changes since task start', () => {
  const repo = path.join(tmp, 'repo'); fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(repo, 'file'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base');
  const baseCommit = git('rev-parse', 'HEAD');
  fs.appendFileSync(path.join(repo, 'file'), 'committed\n'); git('commit', '-qam', 'change');
  fs.appendFileSync(path.join(repo, 'file'), 'uncommitted\n');
  const diff = new Thread({ name: 't', id: 't', cwd: repo, baseCommit }).diff();
  assert.match(diff, /\+committed/); assert.match(diff, /\+uncommitted/);
});
test('bounded concurrency rejects invalid limits', async () => {
  await assert.rejects(all([], { limit: 0 }), /positive integer/);
  let active = 0, peak = 0;
  const results = await all(Array.from({ length: 8 }, (_, i) => async () => {
    peak = Math.max(peak, ++active); await new Promise(r => setTimeout(r, 2)); active--; return i;
  }), { limit: 2 });
  assert.equal(peak, 2); assert.deepEqual(results, [0,1,2,3,4,5,6,7]);
});
test('failed first turn stays inspectable with native id and duplicate name is blocked', async () => {
  const { start } = await import('../lib/threads.mjs');
  const { closeConnection } = await import('../lib/connection.mjs');
  const original = Connection.open;
  Connection.open = async () => ({ alive: true, close() {}, async request(method) {
    if (method === 'thread/start') return { thread: { id: 'native-id' }, model: 'test' };
    if (method === 'turn/start') throw new Error('simulated failure');
    return {};
  }});
  try {
    await assert.rejects(start({ name: 'failed', prompt: 'test', cwd: tmp }), /task failed retained/);
    const saved = thread('failed').entry;
    assert.equal(saved.id, 'native-id'); assert.equal(saved.startup, 'failed-or-unknown');
    await assert.rejects(start({ name: 'failed', prompt: 'test', cwd: tmp }), /already exists/);
    forget('failed');
  } finally { await closeConnection(); Connection.open = original; }
});
