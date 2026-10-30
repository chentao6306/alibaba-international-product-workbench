// Inventory every production source file and its API/UI surface for release QA.
// This is a coverage index, not a claim that static parsing proves behavior.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parse } from '@babel/parser';

const output = process.argv[2];
if (!output) throw new Error('An explicit report path is required');
const roots = ['src', 'server', 'electron', 'auth-server', 'website/src'];
const files = [];
function scan(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', 'deploy'].includes(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) scan(file);
    else if (/\.(?:js|jsx|cjs)$/.test(file)) files.push(file);
  }
}
roots.forEach(scan);
const rows = [];
for (const file of files.sort()) {
  const source = fs.readFileSync(file, 'utf8');
  const ast = parse(source, { sourceType: 'unambiguous', plugins: ['jsx'], createParenthesizedExpressions: true });
  const row = { file: file.replaceAll('\\', '/'), bytes: Buffer.byteLength(source),
    sha256: crypto.createHash('sha256').update(source).digest('hex'), imports: [], routes: [], ipc: [], controls: [] };
  const stack = [ast];
  const literal = node => node?.type === 'StringLiteral' ? node.value : '';
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration' || node.type === 'ExportNamedDeclaration') {
      if (node.source) row.imports.push({ source: literal(node.source), line: node.loc.start.line });
    }
    if (node.type === 'CallExpression' && node.callee?.type === 'MemberExpression') {
      const method = node.callee.property?.name, owner = node.callee.object?.name, value = literal(node.arguments[0]);
      if (value.startsWith('/') && ['get', 'post', 'patch', 'put', 'delete'].includes(method) && ['app', 'router'].includes(owner)) row.routes.push({ method, route: value, line: node.loc.start.line });
      if (value && ['handle', 'on', 'invoke', 'send'].includes(method) && /ipc/i.test(owner || '')) row.ipc.push({ method, channel: value, line: node.loc.start.line });
    }
    if (node.type === 'JSXOpeningElement' && ['input', 'select', 'textarea', 'button'].includes(node.name?.name)) {
      const attributes = Object.fromEntries(node.attributes.filter(item => item.type === 'JSXAttribute').map(item => [item.name.name, literal(item.value)]));
      row.controls.push({ element: node.name.name, line: node.loc.start.line, ...Object.fromEntries(Object.entries(attributes).filter(([key]) => ['id', 'type', 'title', 'aria-label', 'placeholder'].includes(key))) });
    }
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'start', 'end', 'tokens', 'comments', 'extra'].includes(key)) continue;
      if (Array.isArray(value)) stack.push(...value);
      else if (value && typeof value === 'object') stack.push(value);
    }
  }
  rows.push(row);
}
const report = { generatedAt: new Date().toISOString(), version: JSON.parse(fs.readFileSync('package.json')).version,
  staticOnly: true, files: rows.length, routes: rows.reduce((n, row) => n + row.routes.length, 0),
  controls: rows.reduce((n, row) => n + row.controls.length, 0), sources: rows };
fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
fs.writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ files: report.files, routes: report.routes, controls: report.controls, output }));
