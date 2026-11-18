import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,linkSync,statSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {rustBinary} from './rust-binary.ts';
import {parseSkillFiles,skillFileBytes} from './shared/skill-files.ts';
import {writeSkillZip,readSkillZip} from './shared/skill-zip.ts';

const binary = () => rustBinary('briefsip-server', process.env.BRIEFSIP_RUST_BINARY);
const command = (...args: string[]) => spawnSync(binary(), ['skills', ...args], { encoding: 'utf8' });
function skills(...args: string[]) {
 const result = command(...args);
 if (result.status !== 0) throw new Error(result.stderr);
 return JSON.parse(result.stdout);
}
const discoverSkillDirectories = (path: string): { directory: string; status: string; files: number }[] => skills('list', path);
const exportSkillDirectory = (source: string, output: string) => skills('export', source, output);

test('local skill discovery and export retain bytes without activation or source changes',async()=>{
 const root=mkdtempSync(join(tmpdir(),'briefsip-skill-directory-')),library=join(root,'library'),source=join(library,'fixture-skill');
 mkdirSync(library);mkdirSync(source);mkdirSync(join(source,'assets'));
 const markdown='---\nname: fixture-skill\ndescription: Synthetic local package\n---\nUse assets/example.txt as reference.\n';
 writeFileSync(join(source,'SKILL.md'),markdown);writeFileSync(join(source,'assets','example.txt'),'Exact text\r\n');writeFileSync(join(source,'assets','binary.dat'),Buffer.from([0,255,13,10]));
 writeFileSync(join(source,'run.sh'),`#!/bin/sh\ntouch '${root}/executed'\n`);
 try{
  const before=readdirSync(source),listed=discoverSkillDirectories(library);assert.equal(listed.length,1);assert.equal(listed[0].status,'valid');assert.equal(listed[0].files,4);
  const output=join(root,'package.json');exportSkillDirectory(source,output);assert.equal(statSync(output).mode&0o777,0o600);
  const bundle=JSON.parse(readFileSync(output,'utf8'));assert.equal(bundle.format,'briefsip-skill-folder');assert.equal(bundle.version,1);
  const files=parseSkillFiles(bundle.files).files;assert.deepEqual(Buffer.from(skillFileBytes(files.find(f=>f.path==='assets/binary.dat')!)),Buffer.from([0,255,13,10]));
  assert.equal(files.find(f=>f.path==='assets/example.txt')!.content,'Exact text\r\n');assert.deepEqual(await readSkillZip(writeSkillZip(files)),files);
  assert(!readdirSync(root).includes('executed'));assert.deepEqual(readdirSync(source),before);assert.equal(readFileSync(join(source,'SKILL.md'),'utf8'),markdown);
  assert.throws(()=>exportSkillDirectory(source,output),/File exists/);assert.throws(()=>exportSkillDirectory(source,join(source,'export.json')),/outside the source folder/);
  symlinkSync(source,join(root,'selected'));assert.equal(exportSkillDirectory(join(root,'selected'),join(root,'selected.json')).name,'fixture-skill');
  symlinkSync(source,join(library,'linked'));assert.equal(discoverSkillDirectories(library).find(x=>x.directory==='linked')!.status,'invalid');
  const secret=join(root,'private');writeFileSync(secret,'DO_NOT_IMPORT');symlinkSync(secret,join(source,'leak'));assert.throws(()=>exportSkillDirectory(source,join(root,'check.json')),/Link/);rmSync(join(source,'leak'));
  linkSync(secret,join(source,'hardlink'));assert.throws(()=>exportSkillDirectory(source,join(root,'check.json')),/Unsupported/);rmSync(join(source,'hardlink'));
  writeFileSync(join(source,'.env'),'PRIVATE');assert.throws(()=>exportSkillDirectory(source,join(root,'check.json')),/Hidden entries/);rmSync(join(source,'.env'));
  const exported=command('export',source,join(root,'cli.json'));assert.equal(exported.status,0,exported.stderr);assert.equal(JSON.parse(exported.stdout).files,4);
  const repeat=command('export',source,join(root,'cli.json'));assert.equal(repeat.status,1);assert.equal(repeat.stdout,'');
  writeFileSync(join(source,'SKILL.md'),markdown.replace('description:', 'allowed-tools: shell\ndescription:'));assert.throws(()=>exportSkillDirectory(source,join(root,'check.json')),/Skill uses unsupported tool, activation, or provider rules\./);assert.equal(discoverSkillDirectories(library).find(x=>x.directory==='fixture-skill')!.status,'invalid');
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('local skill directory bounds fail without publishing partial packages',()=>{
 const root=mkdtempSync(join(tmpdir(),'briefsip-skill-limits-')),source=join(root,'limits');mkdirSync(source);writeFileSync(join(source,'SKILL.md'),'---\nname: limits\ndescription: Limits\n---\nReference.');
 try{
  writeFileSync(join(source,'large.bin'),Buffer.alloc(2*1024*1024+48001));const output=join(root,'out.json');assert.throws(()=>exportSkillDirectory(source,output),/package size limit/);assert(!readdirSync(root).includes('out.json'));rmSync(join(source,'large.bin'));
  for(let i=0;i<32;i++)writeFileSync(join(source,`file-${i}.txt`),'text');assert.throws(()=>exportSkillDirectory(source,join(root,'check.json')),/32 file/);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('discovery refuses swapped child links and export resolves selected root once',()=>{
 const root=mkdtempSync(join(tmpdir(),'briefsip-skill-race-')),library=join(root,'library'),outside=join(root,'outside'),source=join(library,'sample'),alias=join(root,'selected');
 mkdirSync(library);mkdirSync(outside);mkdirSync(source);writeFileSync(join(source,'SKILL.md'),'---\nname: sample\ndescription: Source\n---\nUse source.');
 mkdirSync(join(outside,'sample'));writeFileSync(join(outside,'sample','SKILL.md'),'---\nname: sample\ndescription: Outside\n---\nDo not import.');symlinkSync(source,alias);
 try{
  assert.throws(()=>exportSkillDirectory(alias,join(source,'export.json')),/outside the source folder/);
  assert(!readdirSync(source).includes('export.json'));
  rmSync(source,{recursive:true});symlinkSync(join(outside,'sample'),source);
  const result=discoverSkillDirectories(library);assert.equal(result.find(x=>x.directory==='sample')!.status,'invalid');assert(!JSON.stringify(result).includes('Outside'));
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('failed CLI writes leave no final export and retry succeeds',()=>{
 const root=mkdtempSync(join(tmpdir(),'briefsip-skill-write-')),source=join(root,'sample'),output=join(root,'out.json');mkdirSync(source);
 writeFileSync(join(source,'SKILL.md'),'---\nname: sample\ndescription: Write failure\n---\n'+'x'.repeat(3000));
 try{
  const result=spawnSync('bash',['-c','trap "" XFSZ; ulimit -f 1; exec "$@"','skill-export-test',binary(),'skills','export',source,output],{cwd:import.meta.dirname,encoding:'utf8'});
  assert.equal(result.status,1,result.stderr);assert.match(result.stderr,/File too large/);assert.deepEqual(readdirSync(root),['sample']);
  exportSkillDirectory(source,output);assert.equal(JSON.parse(readFileSync(output,'utf8')).format,'briefsip-skill-folder');
 }finally{rmSync(root,{recursive:true,force:true});}
});
