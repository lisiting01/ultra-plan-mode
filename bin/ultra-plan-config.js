#!/usr/bin/env node
const path = require('path');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const http = require('http');

const pkgRoot = path.resolve(__dirname, '..');
const serverDist = path.join(pkgRoot, 'server', 'dist', 'index.js');
const webDist = path.join(pkgRoot, 'web', 'dist');
const PORT = 8787;
const CONFIG_URL = `http://localhost:${PORT}/#/config`;

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"` :
               process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  try { execSync(cmd, { shell: true }); } catch {}
}

function checkRunning() {
  return new Promise(resolve => {
    const req = http.get(`http://localhost:${PORT}/api/config`, res => {
      res.destroy(); resolve(true);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => { req.destroy(); resolve(false); });
  });
}

async function main() {
  if (await checkRunning()) {
    openBrowser(CONFIG_URL);
    return;
  }

  if (!fs.existsSync(webDist)) {
    console.log('[ultra-plan-config] Building frontend...');
    execSync('npm run build', { cwd: path.join(pkgRoot, 'web'), stdio: 'inherit' });
  }
  if (!fs.existsSync(serverDist)) {
    console.log('[ultra-plan-config] Building server...');
    execSync('npm run build', { cwd: path.join(pkgRoot, 'server'), stdio: 'inherit' });
  }

  const env = { ...process.env, ULTRAPLAN_NO_BROWSER: '1' };
  spawn(process.execPath, [serverDist], { stdio: 'ignore', detached: true, env }).unref();

  let retries = 20;
  while (retries-- > 0) {
    await new Promise(r => setTimeout(r, 500));
    if (await checkRunning()) { openBrowser(CONFIG_URL); return; }
  }
  console.error('[ultra-plan-config] Server failed to start');
  process.exit(1);
}

main();
