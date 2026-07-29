module.exports = {
  apps: [{
    name: 'desktop-pet-server',
    cwd: __dirname,
    script: 'src/index.js',
    interpreter: 'node',
    instances: 1,
    exec_mode: 'fork',
    time: false,
    merge_logs: true,
    out_file: '/var/log/desktop-pet/server.log',
    error_file: '/var/log/desktop-pet/server.log',
    env: {
      NODE_ENV: 'production',
    },
  }],
};
