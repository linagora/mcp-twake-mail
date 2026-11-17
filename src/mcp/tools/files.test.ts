import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentType, humanSize, localFiles } from './files.js';

describe('localFiles', () => {
  let base: string;
  let root: string;
  let outside: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'mail-files-'));
    root = join(base, 'uploads');
    outside = join(base, 'private');
    mkdirSync(join(root, 'sub'), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(root, 'devis.pdf'), 'pdf');
    writeFileSync(join(outside, 'secret.txt'), 'secret');
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('reads files inside the folder, by relative or absolute path', async () => {
    const files = await localFiles(root, ['devis.pdf', join(root, 'devis.pdf')]);
    expect(files.map((f) => [f.name, f.type, f.size])).toEqual([
      ['devis.pdf', 'application/pdf', 3],
      ['devis.pdf', 'application/pdf', 3],
    ]);
  });

  it('refuses a path outside the folder', async () => {
    await expect(localFiles(root, ['../private/secret.txt'])).rejects.toThrow(/inside .*JMAP_UPLOAD_DIR/);
    await expect(localFiles(root, [join(outside, 'secret.txt')])).rejects.toThrow(/inside .*JMAP_UPLOAD_DIR/);
  });

  it('refuses a symbolic link that leads outside the folder', async () => {
    symlinkSync(join(outside, 'secret.txt'), join(root, 'lien.txt'));
    await expect(localFiles(root, ['lien.txt'])).rejects.toThrow(/inside .*JMAP_UPLOAD_DIR/);
  });

  it('refuses a missing file, a folder and a file over the server limit', async () => {
    await expect(localFiles(root, ['absent.pdf'])).rejects.toThrow(/not found: absent\.pdf/);
    await expect(localFiles(root, ['sub'])).rejects.toThrow(/sub is not a file/);
    await expect(localFiles(root, ['devis.pdf'], 2)).rejects.toThrow(/devis\.pdf is 3 B, over the 2 B the server accepts/);
  });

  it('says when the upload folder does not exist', async () => {
    await expect(localFiles(join(base, 'none'), ['devis.pdf'])).rejects.toThrow(/upload folder .* does not exist/);
  });
});

describe('contentType and humanSize', () => {
  it('guesses common types', () => {
    expect(contentType('a.DOCX')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(contentType('photo.jpeg')).toBe('image/jpeg');
    expect(contentType('a.bin')).toBe('application/octet-stream');
  });

  it('writes sizes for people', () => {
    expect(humanSize(3)).toBe('3 B');
    expect(humanSize(1536)).toBe('1.5 KB');
    expect(humanSize(3 * 1024 * 1024)).toBe('3 MB');
  });
});
