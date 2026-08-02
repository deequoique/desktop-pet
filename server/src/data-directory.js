import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRODUCTION_DATA_DIR = '/var/lib/desktop-pet';

export function legacyDataDirectory(moduleUrl = import.meta.url) {
  return fileURLToPath(new URL('../data', moduleUrl));
}

export function resolveDataDirectory(env = process.env, moduleUrl = import.meta.url) {
  const configured = String(env.PET_DATA_DIR || '').trim();
  const production = env.NODE_ENV === 'production';
  if (configured) {
    if (production && !path.isAbsolute(configured)) {
      throw new Error(`PET_DATA_DIR must be an absolute path in production: ${configured}`);
    }
    return path.resolve(configured);
  }
  return production ? PRODUCTION_DATA_DIR : legacyDataDirectory(moduleUrl);
}

export function prepareDataDirectory(env = process.env, moduleUrl = import.meta.url) {
  const dataDir = resolveDataDirectory(env, moduleUrl);
  const legacyDataDir = legacyDataDirectory(moduleUrl);
  const registryFile = path.join(dataDir, 'registry.json');
  const legacyRegistryFile = path.join(legacyDataDir, 'registry.json');

  if (env.NODE_ENV === 'production'
    && path.resolve(dataDir) !== path.resolve(legacyDataDir)
    && !fs.existsSync(registryFile)
    && fs.existsSync(legacyRegistryFile)) {
    throw new Error(
      `Legacy server data found at ${legacyDataDir}, but the production data directory ${dataDir} is empty. `
      + 'Stop the server and migrate the entire data directory (registry.json, audio/, and notes/) before restarting.'
    );
  }

  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.accessSync(dataDir, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
  } catch (error) {
    throw new Error(
      `Persistent data directory is not readable, writable, and accessible: ${dataDir}. `
      + 'Create it and grant access to the user that runs the server.',
      { cause: error }
    );
  }

  return dataDir;
}
