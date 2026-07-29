import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PRODUCTION_DATA_DIR,
  legacyDataDirectory,
  prepareDataDirectory,
  resolveDataDirectory,
} from '../src/data-directory.js';

function withServerRoot(run) {
  const serverRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-data-directory-'));
  const moduleUrl = pathToFileURL(path.join(serverRoot, 'src', 'data-directory.js')).href;
  try { return run({ serverRoot, moduleUrl }); }
  finally { fs.rmSync(serverRoot, { recursive: true, force: true }); }
}

test('production defaults to /var/lib while development keeps package-local data', () => {
  withServerRoot(({ serverRoot, moduleUrl }) => {
    assert.equal(resolveDataDirectory({ NODE_ENV: 'production' }, moduleUrl), PRODUCTION_DATA_DIR);
    assert.equal(
      resolveDataDirectory({ NODE_ENV: 'development' }, moduleUrl),
      path.join(serverRoot, 'data')
    );
    assert.equal(legacyDataDirectory(moduleUrl), path.join(serverRoot, 'data'));
  });
});

test('explicit absolute PET_DATA_DIR overrides defaults', () => {
  withServerRoot(({ serverRoot, moduleUrl }) => {
    const configured = path.join(serverRoot, 'persistent');
    assert.equal(
      resolveDataDirectory({ NODE_ENV: 'production', PET_DATA_DIR: configured }, moduleUrl),
      configured
    );
  });
});

test('production rejects a relative PET_DATA_DIR', () => {
  assert.throws(
    () => resolveDataDirectory({ NODE_ENV: 'production', PET_DATA_DIR: './data' }),
    /PET_DATA_DIR must be an absolute path/
  );
});

test('production refuses an empty target when legacy registry data exists', () => {
  withServerRoot(({ serverRoot, moduleUrl }) => {
    const legacy = path.join(serverRoot, 'data');
    const target = path.join(serverRoot, 'persistent');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'registry.json'), '{"version":2,"rooms":{}}\n');

    assert.throws(
      () => prepareDataDirectory(
        { NODE_ENV: 'production', PET_DATA_DIR: target },
        moduleUrl
      ),
      (error) => {
        assert.match(error.message, /Legacy server data found/);
        assert.match(error.message, new RegExp(legacy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        assert.match(error.message, new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        return true;
      }
    );
    assert.equal(fs.existsSync(target), false);
  });
});

test('production accepts a migrated target and development can use isolated data', () => {
  withServerRoot(({ serverRoot, moduleUrl }) => {
    const legacy = path.join(serverRoot, 'data');
    const target = path.join(serverRoot, 'persistent');
    fs.mkdirSync(legacy, { recursive: true });
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'registry.json'), '{"version":2,"rooms":{"old":{}}}\n');
    fs.writeFileSync(path.join(target, 'registry.json'), '{"version":2,"rooms":{"new":{}}}\n');

    assert.equal(
      prepareDataDirectory({ NODE_ENV: 'production', PET_DATA_DIR: target }, moduleUrl),
      target
    );

    const developmentTarget = path.join(serverRoot, 'development');
    assert.equal(
      prepareDataDirectory({ NODE_ENV: 'development', PET_DATA_DIR: developmentTarget }, moduleUrl),
      developmentTarget
    );
    assert.equal(fs.existsSync(developmentTarget), true);
  });
});

test('startup fails clearly when the target directory cannot be created', () => {
  withServerRoot(({ serverRoot, moduleUrl }) => {
    const blockingFile = path.join(serverRoot, 'not-a-directory');
    fs.writeFileSync(blockingFile, 'blocked');
    const target = path.join(blockingFile, 'data');
    assert.throws(
      () => prepareDataDirectory(
        { NODE_ENV: 'production', PET_DATA_DIR: target },
        moduleUrl
      ),
      /Persistent data directory is not readable, writable, and accessible/
    );
  });
});
