/**
 * Local folders and files: where attachments are saved (JMAP_DOWNLOAD_DIR) and the only files an
 * e-mail may carry (JMAP_UPLOAD_DIR), resolved through symbolic links so none leads outside.
 */
import { readFile, realpath, stat } from 'fs/promises';
import { homedir } from 'os';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'path';

/** A configured folder: `~` is the home folder; ~/Downloads by default. */
export function localFolder(dir: string | undefined): string {
  if (!dir) return join(homedir(), 'Downloads');
  if (dir === '~' || dir.startsWith('~/')) return join(homedir(), dir.slice(1));
  return resolve(dir);
}

const TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  html: 'text/html',
  ics: 'text/calendar',
  json: 'application/json',
  zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
};

export const contentType = (name: string): string => TYPES[extname(name).slice(1).toLowerCase()] ?? 'application/octet-stream';

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${Number(n.toFixed(1))} ${units[i]}`;
}

export interface LocalFile {
  path: string;
  name: string;
  type: string;
  size: number;
}

/** The files to attach, checked: inside `root` once links are resolved, regular files, within `maxSize`. */
export async function localFiles(root: string, paths: string[], maxSize?: number): Promise<LocalFile[]> {
  const realRoot = await realpath(root).catch(() => {
    throw new Error(`The upload folder ${root} does not exist (JMAP_UPLOAD_DIR): create it and put the files to attach there.`);
  });
  const files: LocalFile[] = [];
  for (const p of paths) {
    const full = isAbsolute(p) ? p : join(root, p);
    const real = await realpath(full).catch(() => {
      throw new Error(`File not found: ${p} (looked in ${root}).`);
    });
    const rel = relative(realRoot, real);
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`${p}: attachments must be inside ${root} (JMAP_UPLOAD_DIR). Copy the file there first.`);
    }
    const s = await stat(real);
    if (!s.isFile()) throw new Error(`${p} is not a file: give a file inside ${root}.`);
    if (maxSize !== undefined && s.size > maxSize) {
      throw new Error(`${basename(real)} is ${humanSize(s.size)}, over the ${humanSize(maxSize)} the server accepts.`);
    }
    files.push({ path: real, name: basename(full), type: contentType(full), size: s.size });
  }
  return files;
}

/** Where drafts take their attachments from (JMAP_UPLOAD_DIR, else the download folder). */
export interface DraftFileOptions {
  uploadDir?: string;
}

/** The largest file the server accepts (RFC 8620 core capability), when it says. */
export function maxSizeUpload(session: { capabilities?: unknown }): number | undefined {
  const core = (session.capabilities as Record<string, { maxSizeUpload?: number }> | undefined)?.['urn:ietf:params:jmap:core'];
  return typeof core?.maxSizeUpload === 'number' ? core.maxSizeUpload : undefined;
}

/** The files a draft asks for, checked against the upload folder and the server limit. */
export function draftFiles(session: { capabilities?: unknown }, options: DraftFileOptions | undefined, paths: string[]): Promise<LocalFile[]> {
  return localFiles(localFolder(options?.uploadDir), paths, maxSizeUpload(session));
}

/** How the approval prompt shows files not uploaded yet. */
export const promptFiles = (files: LocalFile[]) => files.map((f) => ({ name: f.name, type: f.type, size: f.size }));

/** Uploads each file and returns the attachments to put in Email/set. */
export async function uploadFiles(
  jmap: { uploadBlob(data: Uint8Array, type: string): Promise<{ blobId: string }> },
  files: LocalFile[]
): Promise<Array<{ blobId: string; type: string; name: string; disposition: 'attachment' }>> {
  const attachments = [];
  for (const f of files) {
    const blob = await jmap.uploadBlob(await readFile(f.path), f.type);
    attachments.push({ blobId: blob.blobId, type: f.type, name: f.name, disposition: 'attachment' as const });
  }
  return attachments;
}
