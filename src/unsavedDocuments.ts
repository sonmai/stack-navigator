import { realpath } from 'node:fs/promises';
import { dirname, basename, resolve, relative, isAbsolute, sep } from 'node:path';

interface Document { isDirty: boolean; uri: { scheme: string; fsPath: string } }
interface Notebook extends Document { getCells(): readonly { document: { isDirty: boolean } }[] }

function contains(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === '' || (child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child));
}

// New unsaved files may not exist yet. Resolve their closest existing parent so
// aliases into the repository are still recognized without requiring a saved file.
async function canonical(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
    const parent = dirname(path);
    if (parent === path) { throw error; }
    return resolve(await canonical(parent), basename(path));
  }
}

export async function hasUnsavedRepositoryDocuments(root: string, texts: readonly Document[], notebooks: readonly Notebook[]): Promise<boolean> {
  const candidates = [...texts.filter(doc => doc.isDirty),
    ...notebooks.filter(doc => doc.isDirty || doc.getCells().some(cell => cell.document.isDirty))]
    .filter(doc => ['file', 'vscode-remote'].includes(doc.uri.scheme));
  if (!candidates.length) { return false; }
  const absoluteRoot = resolve(root);
  const canonicalRoot = await canonical(absoluteRoot);
  for (const doc of candidates) {
    const path = resolve(doc.uri.fsPath);
    if (contains(absoluteRoot, path) || contains(canonicalRoot, await canonical(path))) { return true; }
  }
  return false;
}
