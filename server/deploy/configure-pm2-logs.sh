#!/usr/bin/env bash
set -euo pipefail

LOG_DIR="${DESKTOP_PET_LOG_DIR:-/var/log/desktop-pet}"
APP_USER="${DESKTOP_PET_APP_USER:-ubuntu}"

sudo install -d -m 0750 -o "$APP_USER" -g "$APP_USER" "$LOG_DIR"
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 20M
pm2 set pm2-logrotate:retain 7
pm2 set pm2-logrotate:compress true
pm2 set pm2-logrotate:dateFormat YYYY-MM-DD_HH-mm-ss
pm2 set pm2-logrotate:workerInterval 30

echo "PM2 logs configured: 20M per file, 7 retained, compressed."
