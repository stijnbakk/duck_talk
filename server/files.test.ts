/**
 * The served folder's files: what may be read, and how changes are reported.
 *
 *   npm test
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ChangeBatcher, confined, fileFrame, listFrame, watchingFromEnv, type FilesChanged } from './files.ts';

function vault() {
  const root = mkdtempSync(join(tmpdir(), 'files-test-'));
  mkdirSync(join(root, 'Canvas'));
  mkdirSync(join(root, '.obsidian'));
  writeFileSync(join(root, 'Canvas', 'Home.canvas'), '{"nodes":[],"edges":[]}');
  writeFileSync(join(root, '.obsidian', 'app.json'), '{}');
  const outside = mkdtempSync(join(tmpdir(), 'files-outside-'));
  writeFileSync(join(outside, 'secret.txt'), 'nope');
  symlinkSync(outside, join(root, 'Canvas', 'escape'));
  return { root, outside, done: () => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); } };
}

test('off unless WATCH_FILES=1', () => {
  assert.equal(watchingFromEnv({}), false);
  assert.equal(watchingFromEnv({ WATCH_FILES: '1' }), true);
});

test('only vault-relative paths inside the folder, never hidden ones or links out', () => {
  const v = vault();
  try {
    assert.ok(confined(v.root, 'Canvas/Home.canvas'));
    assert.ok(confined(v.root, 'Canvas/Pieces/New board.canvas'), 'a file that does not exist yet');
    for (const bad of ['/etc/passwd', '../x', 'Canvas/../../x', 'Canvas/./Home.canvas', '.obsidian/app.json',
      'Canvas/.hidden', 'Canvas//Home.canvas', '', 'Canvas\\Home.canvas', 'Canvas/escape/secret.txt', 'node_modules/x', 7]) {
      assert.equal(confined(v.root, bad), undefined, String(bad));
    }
  } finally { v.done(); }
});

test('file_get returns the exact bytes with their hash, or says why not', () => {
  const v = vault();
  try {
    const f = fileFrame(v.root, 'Canvas/Home.canvas');
    assert.ok('data' in f);
    const bytes = Buffer.from(f.data, 'base64');
    assert.equal(bytes.toString(), '{"nodes":[],"edges":[]}');
    assert.equal(f.sha1, createHash('sha1').update(bytes).digest('hex'));
    assert.deepEqual(fileFrame(v.root, 'Canvas/Gone.canvas'), { type: 'file', path: 'Canvas/Gone.canvas', missing: true });
    assert.deepEqual(fileFrame(v.root, '.obsidian/app.json'), { type: 'file', path: '.obsidian/app.json', error: 'not allowed' });
    assert.deepEqual(fileFrame(v.root, 'Canvas/escape/secret.txt'), { type: 'file', path: 'Canvas/escape/secret.txt', error: 'not allowed' });
    assert.deepEqual(fileFrame(v.root, 'Canvas'), { type: 'file', path: 'Canvas', error: 'not a file' });
  } finally { v.done(); }
});

test('changes are batched, split into present and deleted, hidden ones dropped', async () => {
  const frames: FilesChanged[] = [];
  const present = new Set(['/v/Canvas/A.canvas', '/v/Canvas/Pieces/B.canvas']);
  const b = new ChangeBatcher('/v', (f) => frames.push(f), 20, (abs) => present.has(abs));
  b.note('Canvas/A.canvas');
  b.note('Canvas/A.canvas');
  b.note('Canvas/Old.canvas');
  b.note('.obsidian/workspace.json');
  b.note('Canvas/.duck-talk/x');
  b.note('Canvas/Pieces/B.canvas');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0]!.paths, ['Canvas/A.canvas', 'Canvas/Pieces/B.canvas']);
  assert.deepEqual(frames[0]!.deleted, ['Canvas/Old.canvas']);
  b.stop();
});

test('file_list hashes every file under a folder, hidden ones and links out left out', () => {
  const v = vault();
  try {
    mkdirSync(join(v.root, 'Canvas', 'Pieces'));
    writeFileSync(join(v.root, 'Canvas', 'Pieces', 'E01.canvas'), '{}');
    writeFileSync(join(v.root, 'Canvas', '.hidden'), 'x');
    const list = listFrame(v.root, 'Canvas');
    assert.deepEqual(list.files.map((f) => f.path).sort(), ['Canvas/Home.canvas', 'Canvas/Pieces/E01.canvas']);
    assert.equal(list.files.find((f) => f.path === 'Canvas/Pieces/E01.canvas')!.sha1, createHash('sha1').update('{}').digest('hex'));
    assert.equal(listFrame(v.root, '../').error, 'not allowed');
    assert.equal(listFrame(v.root, '.obsidian').error, 'not allowed');
  } finally { v.done(); }
});
