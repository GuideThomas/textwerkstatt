import fs from 'fs';
import path from 'path';
import { config } from '../config';

const UPLOAD_DIR = config.upload.dir;

export function ensureUploadDir(): void {
  if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    console.log(`Created upload directory: ${UPLOAD_DIR}`);
  }
}

export function getFilePath(storedFilename: string): string {
  return path.join(UPLOAD_DIR, storedFilename);
}

export function deleteFile(storedFilename: string): boolean {
  const filePath = getFilePath(storedFilename);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
    return false;
  } catch (err) {
    console.error(`Failed to delete file ${filePath}:`, err);
    return false;
  }
}

