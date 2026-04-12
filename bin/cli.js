#!/usr/bin/env node

'use strict';

const path = require('path');

process.chdir(path.resolve(__dirname, '..'));

const args = process.argv.slice(2);
let customPort = null;

for (let i = 0; i < args.length; i += 1) {
  if ((args[i] === '--port' || args[i] === '-p') && args[i + 1]) {
    customPort = parseInt(args[i + 1], 10);
    break;
  }

  const match = args[i].match(/^--port=(\d+)$/);
  if (match) {
    customPort = parseInt(match[1], 10);
    break;
  }
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
  Codex Map — Visual dashboard for your Codex CLI setup

  Usage:
    codex-map              Start the dashboard (default port 3131)
    codex-map -p 8080      Start on a custom port
    codex-map --help       Show help
    codex-map --version    Show version

  Options:
    -p, --port <number>    Port to listen on (default: 3131)
    -h, --help             Show help
    -v, --version          Show version
`);
  process.exit(0);
}

if (args.includes('--version') || args.includes('-v')) {
  const pkg = require('../package.json');
  console.log(pkg.version);
  process.exit(0);
}

if (customPort) process.env.PORT = String(customPort);

require('../server.js');
