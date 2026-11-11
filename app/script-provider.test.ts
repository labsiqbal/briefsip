import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from './server.ts';

test('script provider settings keep identity and credentials isolated, reject busy/revoked changes and preserve receipts', async () => {
  const dir=mkdtempSync(join(tmpdir(),'briefsip-script-provider-')),token=randomBytes(32).toString('base64url'),secret=randomBytes(32).toString('base64url');
  const calls:{model:string;auth:string|undefined}[]=[];
  const provider=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const data=JSON.parse(raw);calls.push({model:data.model,auth:req.headers.authorization});if(data.messages.at(-1).content==='HOLD')return;res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'Done'}}]}));});
  await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));const address=provider.address();assert(address&&typeof address!=='string');
  const options={database:join(dir,'db.sqlite'),scriptToken:token,accounts:[{id:'chosen',name:'Chosen',provider:'openai-compatible',baseURL:`http://127.0.0.1:${address.port}/v1`,apiKey:secret}]};let app=await startApp(options);
  const auth={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
  async function request(path:string,body?:unknown,status?:number,headers?:Record<string,string>):Promise<any>{const res=await fetch(app.origin+path,{method:body?'POST':'GET',headers:headers??{Origin:app.origin,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const result=await res.json();if(status)assert.equal(res.status,status,JSON.stringify(result));else assert(res.ok,JSON.stringify(result));assert(!JSON.stringify(result).includes(secret));return result;}
  async function until(check:()=>Promise<boolean>){for(let n=0;n<200;n++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Timed out');}
  try {
    const a=await request('/api/agents',{id:randomUUID(),name:'Keep name',model:'old',instructions:'Keep instructions'});
    const path=`/api/scripts/agents/${a.id}/provider`,permission=`/api/agents/${a.id}/scripts`,turns=`/api/scripts/agents/${a.id}/turns`;
    await request(path,undefined,403,auth);await request(permission,{id:randomUUID(),revision:0,enabled:true});
    const current=await request(path,undefined,200,auth);assert.equal(current.model,'old');assert.equal(current.accounts.find((row:any)=>row.id==='chosen').configured,true);assert(!JSON.stringify(current).includes('baseURL'));
    const command={id:randomUUID(),revision:a.revision,model:'new',providerAccount:'chosen',backupModel:''};
    await request(path,{...command,enabled:true},400,auth);await request(path,{...command,providerAccount:'missing'},400,auth);await request(path,command,403,{...auth,Origin:app.origin});
    const changed=await request(path,command,200,auth);assert.equal(changed.name,a.name);assert.equal(changed.instructions,a.instructions);assert.equal(changed.provider_account,'chosen');assert.deepEqual(await request(path,command,200,auth),changed);
    await request(path,{...command,id:randomUUID()},409,auth);
    const message={id:randomUUID(),text:'Ready'};await request(turns,message,202,auth);await until(async()=>(await request(turns,undefined,200,auth))[0]?.status==='done');assert.deepEqual(calls,[{model:'new',auth:`Bearer ${secret}`}]);
    const renamed=await request(`/api/agents/${a.id}/edit`,{id:randomUUID(),revision:changed.revision,name:'Renamed',model:changed.model,instructions:changed.instructions});
    assert.deepEqual(await request(path,command,200,auth),changed);assert.equal((await request('/api/agents')).agents[0].name,'Renamed');
    const hold={id:randomUUID(),text:'HOLD'};await request(turns,hold,202,auth);await until(async()=>calls.length===2);
    await request(path,{...command,id:randomUUID(),revision:renamed.revision,model:'busy'},409,auth);
    await request(`/api/agents/${a.id}/turns/${hold.id}/cancel`,{id:randomUUID()});
    await app.close();app=await startApp(options);assert.deepEqual(await request(path,command,200,auth),changed);assert.equal(calls.length,2);
    let finish!:()=>void;const pending=new Promise<number|undefined>((resolve,reject)=>{const req=httpRequest(app.origin+path,{method:'POST',headers:auth},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);const raw=JSON.stringify({...command,id:randomUUID(),revision:renamed.revision});req.write(raw.slice(0,-1));finish=()=>req.end('}');});
    await request(permission,{id:randomUUID(),revision:1,enabled:false});finish();assert.equal(await pending,403);await request(path,command,403,auth);await request(path,undefined,403,auth);
  } finally {await app.close();provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});}
});
