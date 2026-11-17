import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentType, humanSize, localFiles, uploadFiles } from './files.js';

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

  it('names a file by what it is, not by the link that leads to it', async () => {
    writeFileSync(join(root, 'cles-privees.txt'), 'keys');
    symlinkSync(join(root, 'cles-privees.txt'), join(root, 'facture.pdf'));
    const [file] = await localFiles(root, ['facture.pdf']);
    expect(file.name).toBe('cles-privees.txt');
    expect(file.type).toBe('text/plain');
  });

  it('keeps control characters out of a file name', async () => {
    writeFileSync(join(root, 'a\nÀ : pirate@x.pdf'), 'x');
    const [file] = await localFiles(root, ['a\nÀ : pirate@x.pdf']);
    expect(file.name).not.toMatch(/[\n\r]/);
  });

  it('answers the same for any path outside the folder, existing or not', async () => {
    const existing = (await localFiles(root, [join(outside, 'secret.txt')]).catch((e: Error) => e.message)) as string;
    const missing = (await localFiles(root, [join(outside, 'absent.txt')]).catch((e: Error) => e.message)) as string;
    expect(missing.replace('absent.txt', 'X')).toBe(existing.replace('secret.txt', 'X'));
    const up = await localFiles(root, ['../private/absent.txt']).catch((e: Error) => e.message);
    expect(up).toMatch(/inside .*JMAP_UPLOAD_DIR/);
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

describe('uploadFiles', () => {
  it('refuses a file that changed after it was checked', async () => {
    const base = mkdtempSync(join(tmpdir(), 'mail-upload-'));
    writeFileSync(join(base, 'devis.pdf'), 'pdf');
    const files = await localFiles(base, ['devis.pdf']);
    writeFileSync(join(base, 'devis.pdf'), 'a much longer content');
    const jmap = { uploadBlob: async () => ({ blobId: 'b' }) };
    await expect(uploadFiles(jmap, files)).rejects.toThrow(/devis\.pdf changed since it was checked/);
    rmSync(base, { recursive: true, force: true });
  });
});
