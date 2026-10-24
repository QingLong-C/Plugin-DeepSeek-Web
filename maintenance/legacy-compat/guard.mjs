import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const base = path.dirname(fileURLToPath(import.meta.url));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const read = file => {
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error(`Expected regular file: ${file}`);
    return fs.readFileSync(file);
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};

export function repairPackage(packageRoot, stateRoot = path.join(base, 'state')) {
  const manifest = JSON.parse(fs.readFileSync(path.join(base, 'manifest.json'), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  if (pkg.name !== manifest.package) throw new Error('TokenFree compatibility guard: unexpected package.');
  const changes = [];
  for (const [relative, rule] of Object.entries(manifest.files)) {
    const target = path.join(packageRoot, relative);
    const before = read(target);
    const payload = fs.readFileSync(path.join(base, 'payload', rule.payload));
    if (hash(payload) !== rule.sha256) throw new Error('TokenFree compatibility guard: damaged repair payload.');
    if (before !== null && hash(before) === rule.sha256) continue;
    if (before === null ? !rule.allowMissing : !rule.acceptedHashes.includes(hash(before))) {
      throw new Error(`TokenFree ${pkg.version}: unrecognized ${relative}; no files patched. Compatibility review required.`);
    }
    changes.push({ target, relative, before, payload });
  }
  if (!changes.length) return { version: pkg.version, repaired: [] };
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  // Validate every replacement and source before changing any installed file.
  const staged = [];
  const committed = [];
  try {
    for (const change of changes) {
      const temporary = `${change.target}.compat-${process.pid}-${crypto.randomUUID()}.mjs`;
      fs.writeFileSync(temporary, change.payload, { mode: 0o600, flag: 'wx' });
      staged.push({ ...change, temporary });
      const check = spawnSync(process.execPath, ['--check', temporary], { encoding: 'utf8', timeout: 10000 });
      if (check.status !== 0) throw new Error(`TokenFree replacement syntax check failed: ${change.relative}`);
    }
    for (const change of staged) {
      const current = read(change.target);
      if (current === null ? change.before !== null : change.before === null || hash(current) !== hash(change.before)) {
        throw new Error('TokenFree files changed during repair; retry after package installation finishes.');
      }
    }
    for (const change of staged) {
      if (change.before !== null) {
        const backup = path.join(stateRoot, `${hash(change.before)}.backup`);
        if (!fs.existsSync(backup)) fs.writeFileSync(backup, change.before, { mode: 0o600, flag: 'wx' });
      }
      fs.renameSync(change.temporary, change.target);
      committed.push(change);
    }
    const result = { version: pkg.version, repaired: changes.map(change => change.relative) };
    fs.writeFileSync(path.join(stateRoot, 'last-repair.json'), JSON.stringify({ at: new Date().toISOString(), ...result }) + '\n', { mode: 0o600 });
    return result;
  } catch (error) {
    for (const change of committed.reverse()) {
      if (change.before === null) fs.unlinkSync(change.target);
      else fs.writeFileSync(change.target, change.before, { mode: 0o600 });
    }
    throw error;
  } finally {
    for (const change of staged) if (fs.existsSync(change.temporary)) fs.unlinkSync(change.temporary);
  }
}
