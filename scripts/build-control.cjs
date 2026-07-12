const { spawnSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const npmCli = process.env.npm_execpath;
if (!npmCli) {
  console.error('npm_execpath is unavailable; run this script through npm.');
  process.exit(1);
}
const result = spawnSync(process.execPath, [npmCli, 'run', 'build', '--prefix', path.join(root, 'web')], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, PET_CONTROL_BUILD: '1' },
});
if (result.error) console.error(result.error);
process.exit(result.status ?? 1);
