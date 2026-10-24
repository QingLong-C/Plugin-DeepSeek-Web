import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { repairPackage } from './guard.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../node_modules/dsh-tokenfree');
export const name = 'dsh-tokenfree';
export const inject = ['llm'];
export async function apply(ctx, config = {}) {
  const result = repairPackage(packageRoot);
  if (result.repaired.length) console.info(`[tokenfree-compat] restored ${result.repaired.length} files for ${result.version}`);
  const plugin = await import(pathToFileURL(path.join(packageRoot, 'lib/index.js')).href);
  return plugin.apply(ctx, config);
}
