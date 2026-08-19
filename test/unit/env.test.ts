import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ensureEnvFile,
  envPath,
  loadUserEnv,
  readEnvValues,
  setEnvValues,
} from '../../src/config/env.js';

let tempDir: string;
const originalConfigDir = process.env.THEMESEED_CONFIG_DIR;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'themeseed-env-'));
  process.env.THEMESEED_CONFIG_DIR = tempDir;
  delete process.env.UNSPLASH_ACCESS_KEY;
  delete process.env.PEXELS_API_KEY;
});

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env.THEMESEED_CONFIG_DIR;
  else process.env.THEMESEED_CONFIG_DIR = originalConfigDir;
  delete process.env.UNSPLASH_ACCESS_KEY;
  delete process.env.PEXELS_API_KEY;
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('envPath', () => {
  it('sits next to sites.json in the config directory', () => {
    expect(envPath()).toBe(path.join(tempDir, '.env'));
  });
});

describe('ensureEnvFile', () => {
  it('creates a template containing every provider variable, commented out', async () => {
    expect(await ensureEnvFile()).toBe(true);
    const body = await fs.readFile(envPath(), 'utf8');
    for (const key of [
      'UNSPLASH_ACCESS_KEY',
      'PEXELS_API_KEY',
      'OPENAI_API_KEY',
      'XAI_API_KEY',
      'GOOGLE_API_KEY',
      'FAL_KEY',
      'THEMESEED_LOCAL_IMAGE_DIR',
    ]) {
      expect(body).toContain(`# ${key}=`);
    }
    // Commented out means nothing is actually set yet.
    expect(await readEnvValues()).toEqual({});
  });

  it('documents the content engine without prompting for it', async () => {
    await ensureEnvFile();
    const body = await fs.readFile(envPath(), 'utf8');
    expect(body).toContain('# THEMESEED_CONTENT_ENGINE=');
    expect(body).toContain('# ANTHROPIC_API_KEY=');
  });

  it('never overwrites an existing file, because it holds secrets', async () => {
    await fs.writeFile(envPath(), 'UNSPLASH_ACCESS_KEY=mine\n');
    expect(await ensureEnvFile()).toBe(false);
    expect(await fs.readFile(envPath(), 'utf8')).toBe('UNSPLASH_ACCESS_KEY=mine\n');
  });

  it('creates the file readable only by its owner', async () => {
    await ensureEnvFile();
    const stat = await fs.stat(envPath());
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

describe('setEnvValues', () => {
  it('uncomments an existing key in place instead of appending a duplicate', async () => {
    await ensureEnvFile();
    await setEnvValues({ UNSPLASH_ACCESS_KEY: 'abc123' });
    const body = await fs.readFile(envPath(), 'utf8');
    expect(body.match(/^#?\s*UNSPLASH_ACCESS_KEY=/gm)).toHaveLength(1);
    expect(body).toContain('UNSPLASH_ACCESS_KEY=abc123');
    expect(await readEnvValues()).toEqual({ UNSPLASH_ACCESS_KEY: 'abc123' });
  });

  it('leaves the surrounding comments and section headers alone', async () => {
    await ensureEnvFile();
    const before = await fs.readFile(envPath(), 'utf8');
    await setEnvValues({ PEXELS_API_KEY: 'xyz' });
    const after = await fs.readFile(envPath(), 'utf8');
    const comments = (body: string) =>
      body.split('\n').filter((line) => line.startsWith('#') && !/^#\s*[A-Z]/.test(line));
    expect(comments(after)).toEqual(comments(before));
  });

  it('replaces a value that is already set', async () => {
    await ensureEnvFile();
    await setEnvValues({ FAL_KEY: 'first' });
    await setEnvValues({ FAL_KEY: 'second' });
    expect(await readEnvValues()).toEqual({ FAL_KEY: 'second' });
  });

  it('appends a key the template does not mention', async () => {
    await ensureEnvFile();
    await setEnvValues({ SOMETHING_NEW: 'value' });
    expect(await readEnvValues()).toEqual({ SOMETHING_NEW: 'value' });
  });

  it('comments a key back out when given null, discarding the value', async () => {
    await ensureEnvFile();
    // A distinctive value: the template's own prose mentions "secret" when it
    // documents fal.ai's "<id>:<secret>" key format.
    await setEnvValues({ XAI_API_KEY: 'zzz-discard-me-zzz' });
    await setEnvValues({ XAI_API_KEY: null });
    const body = await fs.readFile(envPath(), 'utf8');
    expect(body).not.toContain('zzz-discard-me-zzz');
    expect(body).toContain('# XAI_API_KEY=');
    expect(await readEnvValues()).toEqual({});
  });

  it('quotes a value containing spaces so dotenv reads it back whole', async () => {
    await ensureEnvFile();
    await setEnvValues({ THEMESEED_LOCAL_IMAGE_DIR: '/Users/me/My Pictures' });
    expect(await readEnvValues()).toEqual({
      THEMESEED_LOCAL_IMAGE_DIR: '/Users/me/My Pictures',
    });
  });

  it('creates the file first when it does not exist yet', async () => {
    await setEnvValues({ PEXELS_API_KEY: 'abc' });
    expect(await readEnvValues()).toEqual({ PEXELS_API_KEY: 'abc' });
  });

  it('writes several keys in one call', async () => {
    await ensureEnvFile();
    await setEnvValues({ UNSPLASH_ACCESS_KEY: 'a', FAL_KEY: 'b' });
    expect(await readEnvValues()).toEqual({ UNSPLASH_ACCESS_KEY: 'a', FAL_KEY: 'b' });
  });
});

describe('loadUserEnv', () => {
  it('puts the file contents into process.env', async () => {
    await setEnvValues({ UNSPLASH_ACCESS_KEY: 'from-file' });
    loadUserEnv();
    expect(process.env.UNSPLASH_ACCESS_KEY).toBe('from-file');
  });

  it('does not override a variable already exported in the process', async () => {
    // Someone who exports a key in their shell for one run means it.
    await setEnvValues({ UNSPLASH_ACCESS_KEY: 'from-file' });
    process.env.UNSPLASH_ACCESS_KEY = 'from-shell';
    loadUserEnv();
    expect(process.env.UNSPLASH_ACCESS_KEY).toBe('from-shell');
  });

  it('does nothing and does not throw when the file is absent', () => {
    expect(() => loadUserEnv()).not.toThrow();
  });
});
