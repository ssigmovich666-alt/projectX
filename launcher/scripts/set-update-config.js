'use strict';
// Записывает адрес репозитория в update-config.json перед сборкой.
// Берёт owner/repo из аргументов или из переменной GITHUB_REPOSITORY (owner/repo),
// которую GitHub Actions выставляет автоматически. Так exe знает, откуда брать обновления.

const fs = require('node:fs');
const path = require('node:path');

const arg = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : ''; };

let owner = arg('--owner');
let repo = arg('--repo');
const manifest = arg('--manifest') || '';

if ((!owner || !repo) && process.env.GITHUB_REPOSITORY && process.env.GITHUB_REPOSITORY.includes('/')) {
  [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');
}
if (!owner || !repo) {
  if (manifest) { owner = owner || ''; repo = repo || ''; }
  else { console.error('Нужно указать --owner и --repo (или задать GITHUB_REPOSITORY / --manifest).'); process.exit(1); }
}

const config = { owner, repo, manifest, enabled: true, coreDirName: 'FunPayCardinal-main' };
const text = JSON.stringify(config, null, 2) + '\n';
const root = path.join(__dirname, '..');
fs.writeFileSync(path.join(root, 'update-config.json'), text);
fs.writeFileSync(path.join(root, 'src', 'update-config.json'), text);
console.log('update-config.json ->', `${owner}/${repo}`, manifest ? `(manifest: ${manifest})` : '');
