const { spawnSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npm, ['run', 'build', '--prefix', path.join(root, 'web')], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, PET_CONTROL_BUILD: '1' },
});
process.exit(result.status ?? 1);
