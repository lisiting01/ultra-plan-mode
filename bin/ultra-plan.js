#!/usr/bin/env node
const path = require('path');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const readline = require('readline');

const pkgRoot = path.resolve(__dirname, '..');
const serverDist = path.join(pkgRoot, 'server', 'dist', 'index.js');
const webDist = path.join(pkgRoot, 'web', 'dist');

function buildIfNeeded() {
  if (!fs.existsSync(webDist)) {
    console.log('[ultra-plan] Building frontend...');
    execSync('npm run build', { cwd: path.join(pkgRoot, 'web'), stdio: 'inherit' });
  }
  if (!fs.existsSync(serverDist)) {
    console.log('[ultra-plan] Building server...');
    execSync('npm run build', { cwd: path.join(pkgRoot, 'server'), stdio: 'inherit' });
  }
}

buildIfNeeded();

const projectPath = process.cwd();

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('Planning question: ', answer => {
  rl.close();
  const question = answer.trim();
  const serverArgs = [serverDist, projectPath];
  if (question) serverArgs.push(question);
  const child = spawn(process.execPath, serverArgs, { stdio: 'inherit' });
  child.on('exit', code => process.exit(code ?? 0));
});
