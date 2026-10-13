import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';

const files=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
const patterns=[
  ['GitHub credential',/gh[pousr]_[A-Za-z0-9]{30,}/],
  ['GitHub fine-grained credential',/github_pat_[A-Za-z0-9_]{40,}/],
  ['Provider credential',/sk-(?:proj-|svcacct-|ant-api\d+-)?[A-Za-z0-9_-]{40,}/],
  ['AWS access key',/(?:AKIA|ASIA)[A-Z0-9]{16}/],
  ['Private key',new RegExp('-----BEGIN '+ '(?:RSA |EC |OPENSSH )?PRIVATE KEY-----')]
];
const forbidden=/^(?:data|node_modules|tmp|\.vercel|\.codex|\.agents|\.impeccable)\/|(?:^|\/)\.env(?:\.|$)|\.(?:sqlite(?:-wal|-shm)?|key|pem)$/;
let failed=false;
for(const file of files){
  if(file!=='.env.example'&&forbidden.test(file)){console.error(`Private/generated path tracked: ${file}`);failed=true;}
  const bytes=readFileSync(file);if(bytes.subarray(0,8000).includes(0))continue;
  const text=bytes.toString('utf8');
  for(const [label,pattern] of patterns)if(pattern.test(text)){console.error(`Possible ${label}: ${file} (value redacted)`);failed=true;}
}
if(failed)process.exitCode=1;
else console.log(`Secret-pattern and private-path checks passed for ${files.length} tracked files. Binary document text requires separate inspection.`);
