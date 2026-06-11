const { resolve } = require('path');
const { pathToFileURL } = require('url');
const cryptoMod = require('crypto');
const { webcrypto } = cryptoMod;

if (typeof cryptoMod.getRandomValues !== 'function' && webcrypto?.getRandomValues) {
  cryptoMod.getRandomValues = webcrypto.getRandomValues.bind(webcrypto);
}

if (!globalThis.crypto || typeof globalThis.crypto.getRandomValues !== 'function') {
  globalThis.crypto = webcrypto;
}

const viteBin = resolve(process.cwd(), 'node_modules/vite/bin/vite.js');

import(pathToFileURL(viteBin).href).catch((error) => {
  console.error(error);
  process.exit(1);
});
