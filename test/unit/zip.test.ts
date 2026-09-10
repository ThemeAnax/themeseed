import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createZip } from '../../src/core/zip.js';

const dirs: string[] = [];

async function scratch(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'themeseed-zip-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

/** Extracts with the system unzip, so we validate against a real implementation. */
async function roundTrip(entries: Record<string, string | Uint8Array>) {
  const dir = await scratch();
  const zipPath = path.join(dir, 'out.zip');
  await fs.writeFile(zipPath, createZip(entries));
  const out = path.join(dir, 'extracted');
  execFileSync('unzip', ['-q', zipPath, '-d', out]);
  return out;
}

describe('createZip', () => {
  it('produces an archive the system unzip accepts', async () => {
    const out = await roundTrip({ 'a.txt': 'hello' });
    expect(await fs.readFile(path.join(out, 'a.txt'), 'utf8')).toBe('hello');
  });

  it('round-trips binary bytes without corrupting them', async () => {
    // Image bytes are the whole reason this exists; a text-safe encoder that
    // mangles 0x00 or high bytes would pass a string test and ship broken JPEGs.
    const bytes = new Uint8Array(512);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 256;
    const out = await roundTrip({ 'img.bin': bytes });
    const read = new Uint8Array(await fs.readFile(path.join(out, 'img.bin')));
    expect(read).toEqual(bytes);
  });

  it('creates nested directories from slashes in the entry name', async () => {
    const out = await roundTrip({ 'images/2026/09/hero.png': 'x' });
    expect(await fs.readFile(path.join(out, 'images/2026/09/hero.png'), 'utf8')).toBe('x');
  });

  it('stores several entries in one archive', async () => {
    const out = await roundTrip({ 'content.json': '{}', 'images/a.png': 'A' });
    expect(await fs.readFile(path.join(out, 'content.json'), 'utf8')).toBe('{}');
    expect(await fs.readFile(path.join(out, 'images/a.png'), 'utf8')).toBe('A');
  });

  it('handles an empty entry, which a zero-length file would otherwise trip on', async () => {
    const out = await roundTrip({ 'empty.txt': '' });
    expect(await fs.readFile(path.join(out, 'empty.txt'), 'utf8')).toBe('');
  });

  it('passes unzip -t integrity checking', async () => {
    const dir = await scratch();
    const zipPath = path.join(dir, 'out.zip');
    await fs.writeFile(zipPath, createZip({ 'content.json': '{"db":[]}', 'images/x.png': 'y' }));
    // Throws on a bad CRC or a malformed central directory.
    expect(() => execFileSync('unzip', ['-t', zipPath])).not.toThrow();
  });
});
