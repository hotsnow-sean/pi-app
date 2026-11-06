import { join } from 'node:path'
import { resolveMainOutDir } from './bundle-paths'

export function resolveUtilityEntry(
  entryName: 'worker.mjs' | 'preview.mjs' | 'preview-wsl.mjs',
  appPath?: string,
): string {
  return join(resolveMainOutDir(appPath), entryName)
}
