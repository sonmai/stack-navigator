import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasUnsavedRepositoryDocuments as dirty } from '../src/unsavedDocuments';

const doc = (path: string, scheme = 'file', isDirty = true) => ({ isDirty, uri: { scheme, fsPath: path } });

test('only dirty repository documents block checkout, including new files and remote files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stacknav-dirty-'));
  try {
    assert.equal(await dirty(root, [doc(join(root, 'new', 'file.ts'))], []), true);
    assert.equal(await dirty(root, [doc(join(root, 'remote.ts'), 'vscode-remote')], []), true);
    assert.equal(await dirty(root, [doc(root + '-other/file.ts')], []), false);
    assert.equal(await dirty(root, [doc(join(root, 'draft'), 'untitled')], []), false);
    assert.equal(await dirty(root, [doc(join(root, 'clean.ts'), 'file', false)], []), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('notebook metadata and dirty cells are scoped to their notebook repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stacknav-notebook-'));
  const notebook = (path: string, metadata: boolean, cell: boolean) => ({ ...doc(path, 'file', metadata),
    getCells: () => [{ document: { isDirty: cell } }] });
  try {
    assert.equal(await dirty(root, [], [notebook(join(root, 'n.ipynb'), true, false)]), true);
    assert.equal(await dirty(root, [], [notebook(join(root, 'n.ipynb'), false, true)]), true);
    assert.equal(await dirty(root, [], [notebook(root + '-other/n.ipynb', true, true)]), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('repository aliases and unsaved files under symlinked parents are recognized', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'stacknav-alias-'));
  const root = join(temp, 'repo'), alias = join(temp, 'alias');
  try {
    await mkdir(root); await writeFile(join(root, 'existing.ts'), '');
    await symlink(root, alias, 'dir');
    assert.equal(await dirty(root, [doc(join(alias, 'existing.ts'))], []), true);
    assert.equal(await dirty(root, [doc(join(alias, 'new', 'file.ts'))], []), true);
    assert.equal(await dirty(alias, [doc(join(root, 'existing.ts'))], []), true);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
