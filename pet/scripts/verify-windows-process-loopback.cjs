const fs = require('fs');
const path = require('path');

if (process.platform !== 'win32') {
  console.log('Windows process-loopback verification skipped on non-Windows host.');
  process.exit(0);
}

const executable = path.join(__dirname, '..', 'native', 'windows-process-loopback', 'build', 'Release', 'desktop-pet-process-loopback.exe');
if (!fs.existsSync(executable)) throw new Error(`Missing process-loopback helper: ${executable}`);
const file = fs.readFileSync(executable);
if (file.length < 0x100 || file.readUInt16LE(0) !== 0x5a4d) throw new Error('Helper is not a PE executable');
const peOffset = file.readUInt32LE(0x3c);
if (file.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') throw new Error('Helper has an invalid PE signature');
if (file.readUInt16LE(peOffset + 4) !== 0x8664) throw new Error('Helper must be built for x64');
console.log(`Verified Windows x64 process-loopback helper (${file.length} bytes).`);
