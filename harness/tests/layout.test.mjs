import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
const root=process.env.AM4_SOURCE_ROOT||fileURLToPath(new URL('../../',import.meta.url));
test('supported production, test and operator dependencies remain after cleanup',()=>{for(const f of ['AM4-Operations.ps1','Start-AM4.cmd','Start-AM4.ps1','Stop-AM4.cmd','AM4 Operator.cmd','operator/AM4-Operator.exe','operator/Operator-Library.ps1','harness/Lock-Session.ps1','harness/production-settings.json','harness/fixtures/states.json'])assert.ok(existsSync(join(root,f)),f);});
test('active Node module relative imports resolve without historical archives',()=>{for(const directory of ['harness','operator'])for(const file of readdirSync(join(root,directory)).filter(f=>f.endsWith('.mjs'))){const absolute=join(root,directory,file),text=readFileSync(absolute,'utf8');for(const m of text.matchAll(/(?:from\s*|import\s*\()\s*['"](\.\.?\/[^'"]+)['"]/g)){const dependency=fileURLToPath(new URL(m[1],pathToFileURL(absolute)));assert.ok(existsSync(dependency),file+' -> '+m[1]);assert.ok(!dependency.includes('archive'),file);}}});
