import fs from 'fs-extra';
import os from 'os';
import path from 'path';

/**
 * Create a temporary folder.
 * @param prefix The prefix of the folder name.
 * @returns string
 */
export function createTempFolder(prefix: string): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
}
