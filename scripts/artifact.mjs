// Turns the single-file build into a bare page fragment (title, styles, body, scripts)
// for hosts that supply their own <html>/<head>/<body> skeleton.
import { readFileSync, writeFileSync } from 'node:fs';
const [, , src = 'dist-single/index.html', out = 'dist-single/tanks.html'] = process.argv;
const html = readFileSync(src, 'utf8');
const title = html.match(/<title>[\s\S]*?<\/title>/)[0];
const styles = html.match(/<style[\s\S]*?<\/style>/g) ?? [];
const scripts = html.match(/<script[\s\S]*?<\/script>/g) ?? [];
let body = html.match(/<body>([\s\S]*)<\/body>/)[1];
for (const s of scripts) body = body.replace(s, '');
writeFileSync(out, [title, ...styles, body.trim(), ...scripts].join('\n'));
console.log('wrote', out);
