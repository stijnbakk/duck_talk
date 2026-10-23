/**
 * The served folder's files, for a client that keeps its own copy of them.
 *
 * Margin on the iPad edits a vault that Obsidian Sync carries to and from this machine,
 * but Sync only runs there while Obsidian is in front, so Claude's edits arrived late and
 * the iPad went on editing a stale board. With `WATCH_FILES=1` the relay says which files
 * changed (`files_changed`, on every socket) and hands one over on request (`file_get` on
 * a data socket), so the client can bring its copy up to date at once, byte for byte —
 * identical bytes are what keep Sync from seeing a conflict later.
 *
 * Off unless asked for: a relay serving a code repository has no use for it.
 *
 * Only what is inside the served folder, never a dot folder (`.obsidian`, `.duck-talk`,
 * `.git`), never through a symlink that leads out, and nothing over 5 MB.
 */

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync, watch, type FSWatcher } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

export const MAX_FILE_BYTES = 5 * 1024 * 1024;

export function watchingFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['WATCH_FILES'] === '1';
}

/** A path segment the relay never reads or reports: hidden folders and dependencies. */
const hidden = (segment: string) => segment.startsWith('.') || segment === 'node_modules';

/**
 * The absolute path for a client's vault-relative `rel`, or undefined when it may not be
 * read: absolute, escaping with `..`, through a hidden segment, or — once symlinks are
 * resolved — outside `root`. A file that does not exist yet is judged by its folder.
 */
export function confined(root: string, rel: unknown): string | undefined {
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || isAbsolute(rel) || rel.includes('\\')) return undefined;
  const segments = rel.split('/');
  if (segments.some((s) => !s || s === '.' || s === '..' || hidden(s))) return undefined;
  let realRoot: string;
  try { realRoot = realpathSync(root); } catch { return undefined; }
  const target = join(realRoot, ...segments);
  // Resolve the deepest part that exists; whatever is below it cannot be a link yet.
  let probe = target;
  while (!existsSync(probe) && probe !== realRoot) probe = dirname(probe);
  let real: string;
  try { real = realpathSync(probe); } catch { return undefined; }
  const inside = real === realRoot || real.startsWith(realRoot + sep);
  return inside ? target : undefined;
}

export type FileFrame =
  | { type: 'file'; path: string; mtime: number; sha1: string; data: string }
  | { type: 'file'; path: string; missing: true }
  | { type: 'file'; path: string; error: string };

/** The answer to `file_get`. */
export function fileFrame(root: string, rel: unknown): FileFrame {
  const path = typeof rel === 'string' ? rel : '';
  const abs = confined(root, rel);
  if (!abs) return { type: 'file', path, error: 'not allowed' };
  let st;
  try { st = lstatSync(abs); } catch { return { type: 'file', path, missing: true }; }
  if (st.isSymbolicLink()) {
    try { st = statSync(abs); } catch { return { type: 'file', path, missing: true }; }
  }
  if (!st.isFile()) return { type: 'file', path, error: 'not a file' };
  if (st.size > MAX_FILE_BYTES) return { type: 'file', path, error: 'too large' };
  const bytes = readFileSync(abs);
  return { type: 'file', path, mtime: Math.round(st.mtimeMs), sha1: createHash('sha1').update(bytes).digest('hex'), data: bytes.toString('base64') };
}

export interface ListedFile { path: string; sha1: string; mtime: number }

/**
 * The answer to `file_list`: every file under the vault-relative folder `prefix` with its
 * hash, so a client that was away can see which of its copies differ. Same confinement as
 * `file_get`; at most `limit` files, files over 5 MB left out.
 */
export function listFrame(root: string, prefix: unknown, limit = 5000): { type: 'files'; prefix: string; files: ListedFile[]; error?: string } {
  const p = typeof prefix === 'string' ? prefix.replace(/\/+$/, '') : '';
  const dir = confined(root, p);
  if (!dir) return { type: 'files', prefix: p, files: [], error: 'not allowed' };
  const files: ListedFile[] = [];
  const walk = (abs: string, rel: string) => {
    let entries;
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (files.length >= limit || hidden(e.name)) continue;
      const a = join(abs, e.name), r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(a, r);
      else if (e.isFile()) {
        const st = statSync(a);
        if (st.size > MAX_FILE_BYTES) continue;
        files.push({ path: r, sha1: createHash('sha1').update(readFileSync(a)).digest('hex'), mtime: Math.round(st.mtimeMs) });
      }
    }
  };
  walk(dir, p);
  return { type: 'files', prefix: p, files };
}

export interface FilesChanged {
  type: 'files_changed';
  /** Vault-relative paths that exist now (written or created). */
  paths: string[];
  /** Vault-relative paths that are gone (deleted, or the old name of a rename). */
  deleted: string[];
  at: number;
}

/**
 * Collects change events into one `files_changed` per quiet `debounceMs`. Kept apart from
 * the watcher so the batching can be tested without touching a disk.
 */
export class ChangeBatcher {
  private pending = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private readonly root: string;
  private readonly emit: (frame: FilesChanged) => void;
  private readonly debounceMs: number;
  private readonly exists: (abs: string) => boolean;

  constructor(root: string, emit: (frame: FilesChanged) => void, debounceMs = 300, exists: (abs: string) => boolean = existsSync) {
    this.root = root;
    this.emit = emit;
    this.debounceMs = debounceMs;
    this.exists = exists;
  }

  /** A raw event for `rel` (relative to root, either separator). */
  note(rel: string) {
    const clean = rel.split(sep).join('/');
    if (!clean || clean.split('/').some(hidden)) return;
    this.pending.add(clean);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.pending.size) return;
    const paths: string[] = [], deleted: string[] = [];
    for (const p of [...this.pending].sort()) (this.exists(join(this.root, p)) ? paths : deleted).push(p);
    this.pending.clear();
    this.emit({ type: 'files_changed', paths, deleted, at: Date.now() });
  }

  stop() { clearTimeout(this.timer); }
}

/** Watches `root` recursively; returns a stop function. */
export function watchFiles(root: string, emit: (frame: FilesChanged) => void): () => void {
  const batcher = new ChangeBatcher(root, emit);
  let watcher: FSWatcher;
  try {
    watcher = watch(root, { recursive: true }, (_event, name) => {
      if (name) batcher.note(String(name));
    });
  } catch (e) {
    console.error(`could not watch ${root}: ${e}`);
    return () => {};
  }
  watcher.on('error', (e) => console.error(`file watch: ${e}`));
  return () => { batcher.stop(); watcher.close(); };
}

/** For logs: `rel` as the client would name it. */
export const vaultRelative = (root: string, abs: string) => relative(root, abs).split(sep).join('/');
