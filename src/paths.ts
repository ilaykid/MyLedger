import path from 'node:path';

export const APP_ROOT = path.resolve(process.env.MYLEDGER_APP_DIR ?? process.cwd());
export const DATA_ROOT = path.resolve(process.env.MYLEDGER_DATA_DIR ?? process.cwd());

export const appPath = (...parts: string[]) => path.join(APP_ROOT, ...parts);
export const dataPath = (...parts: string[]) => path.join(DATA_ROOT, ...parts);
