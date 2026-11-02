// Reset the control panel password from the server's command line:
//   sudo node /opt/nahuentv/reset-password.js
'use strict';
process.removeAllListeners('warning');
const crypto = require('crypto');
const path = require('path');
const readline = require('readline');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || (require('fs').existsSync('/var/lib/nahuentv') ? '/var/lib/nahuentv' : path.join(__dirname, 'data'));
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('New control panel password (8+ characters): ', (pw) => {
  rl.close();
  if (pw.length < 8) { console.error('Too short. Nothing changed.'); process.exit(1); }
  const db = new DatabaseSync(path.join(DATA_DIR, 'signage.db'));
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
  db.prepare("INSERT INTO settings(key,value) VALUES('admin_password',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(hash);
  console.log('Password changed. All logged-in browsers must log in again.');
});
