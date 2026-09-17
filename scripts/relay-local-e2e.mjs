#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { once } from 'node:events';
import { register,readRegistration,DEVICE_FILE,describeUrls } from '../dist/relay/registration.js';
import { startClient } from '../dist/relay/client.js';
const root=resolve(import.meta.dirname,'..'),origin='http://127.0.0.1:8799';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){for(let i=0;i<200;i++){if(await fn().catch(()=>false))return;await sleep(100);}throw new Error(label);}
let child,cliChild,client,fake,dir,registration;
const status=async()=>{const r=await fetch(`${origin}/status/${registration.deviceId}`,{headers:{authorization:`Bearer ${registration.agentConnectionToken}`}});assert.equal(r.status,200);return r.json();};
const publicUrl=channel=>`${origin}/mcp/${registration.deviceId}/${channel}/${channel==='readonly'?registration.readonlyMcpToken:registration.agentMcpToken}`;
async function rpc(channel,method,id,params,session){
 const headers={'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-11-25'};
 if(session)headers['mcp-session-id']=session;
 const r=await fetch(publicUrl(channel),{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',...(id===undefined?{}:{id}),method,...(params?{params}:{})})});
 assert.ok(r.ok,`${channel} ${method}: HTTP ${r.status}`);
 const text=await r.text();let body;
 if(text)body=r.headers.get('content-type')?.includes('text/event-stream')?JSON.parse(text.split('\n').find(l=>l.startsWith('data:')).slice(5)):JSON.parse(text);
 assert.ok(!body?.error,`${channel} ${method}: RPC error`);
 console.log(`PASS ${channel} ${method} HTTP ${r.status}`);
 return {body,session:r.headers.get('mcp-session-id')??session};
}
try{
 const probe=createServer();await new Promise((res,rej)=>{probe.once('error',rej);probe.listen(8799,'127.0.0.1',res);});await new Promise(r=>probe.close(r));
 // Suppress the development access log because capability URLs contain secrets.
 child=spawn('npx',['wrangler','dev','--port','8799','--log-level','error'],{cwd:join(root,'relay'),stdio:'ignore',detached:true,env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
 await until(async()=>{const r=await fetch(origin+'/healthz');return r.ok;},'relay readiness timeout');
 console.log('PASS wrangler dev --port 8799 ready');
 if(existsSync(DEVICE_FILE)){registration=await readRegistration();assert.equal(registration.url,origin);console.log('PASS reused existing mode-600 relay device file without modification');}
 else {registration=await register(origin,'local-e2e');console.log('PASS registered device in new mode-600 relay device file');}
 console.log(`deviceId=${registration.deviceId}\n${describeUrls(registration)}`);
 const logs=[];const log=s=>{logs.push(s);console.log(s);};
 cliChild=spawn(process.execPath,[join(root,'dist/cli/index.js'),'relay','start','--url',origin],{cwd:root,stdio:['ignore','pipe','ignore']});
 cliChild.stdout.setEncoding('utf8');
 cliChild.stdout.on('data',data=>process.stdout.write(data));
 await until(async()=>(await status()).online,'client online timeout');
 assert.deepEqual((await status()).channels,['readonly','agent']);console.log('PASS status online channels=readonly,agent');
 for(const channel of ['readonly','agent']){
  const init=await rpc(channel,'initialize',1,{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'relay-e2e',version:'1'}});
  await rpc(channel,'notifications/initialized',undefined,undefined,init.session);
  const tools=await rpc(channel,'tools/list',2,undefined,init.session);const names=tools.body.result.tools.map(t=>t.name);
  if(channel==='readonly')assert.equal(names.length,7);else assert.ok(names.includes('run_agent'));
  console.log(`PASS ${channel} tools (${names.length}): ${names.join(', ')}`);
  if(init.session){const r=await fetch(publicUrl(channel),{method:'DELETE',headers:{'mcp-session-id':init.session,'mcp-protocol-version':'2025-11-25'}});assert.ok(r.ok);console.log(`PASS ${channel} session cleanup HTTP ${r.status}`);}
 }
 cliChild.kill('SIGTERM');await once(cliChild,'exit');cliChild=undefined;
 await until(async()=>!(await status()).online,'CLI offline timeout');console.log('PASS relay start CLI foreground shutdown');
 client=await startClient(registration,{log});await until(async()=>(await status()).online,'reconnect client online timeout');
 client.disconnect();await until(async()=>logs.some(s=>s.startsWith('reconnected'))&&(await status()).online,'reconnect timeout');console.log('PASS forced socket close reconnected and status online');
 client.stop();await until(async()=>!(await status()).online,'offline timeout');
 dir=await mkdtemp(join(tmpdir(),'relay-e2e-'));const tokenFile=join(dir,'fake-token');await writeFile(tokenFile,'fake-local-token',{mode:0o600});
 let deliveries=0;
 fake=createServer((req,res)=>{assert.equal(req.headers.authorization,'Bearer fake-local-token');deliveries++;req.resume();if(deliveries===1){res.writeHead(200,{'content-type':'text/plain'});res.write('first chunk');}else{res.end('ok');}});
 fake.listen(0,'127.0.0.1');await once(fake,'listening');const target=`http://127.0.0.1:${fake.address().port}/mcp`;
 const fakeLogs=[];client=await startClient(registration,{readonlyTokenFile:tokenFile,agentTokenFile:tokenFile,targets:{readonly:target,agent:target},log:s=>{fakeLogs.push(s);console.log(s);}});
 await until(async()=>(await status()).online,'fake online timeout');
 const pending=fetch(publicUrl('readonly'),{method:'POST',body:'{}'}).then(async r=>{try{await r.text();}catch{};return r.status;});
 await until(async()=>deliveries===1&&client.pending.size===1,'fake delivery timeout');
 client.disconnect();await pending;
 await until(async()=>fakeLogs.some(s=>s.startsWith('reconnected'))&&(await status()).online,'fake reconnect timeout');await sleep(500);
 assert.equal(deliveries,1);console.log('PASS no replay: delivered request count=1 after disconnect/reconnect');
 const fresh=await fetch(publicUrl('readonly'),{method:'POST',body:'{}'});assert.equal(await fresh.text(),'ok');assert.equal(deliveries,2);console.log('PASS fresh request after reconnect: total count=2');
 console.log('PASS all local end-to-end assertions');
}catch(error){console.error(`FAIL local end-to-end: ${error instanceof assert.AssertionError?'assertion failed':error?.message==='fetch failed'?'connection unavailable':'step failed'}; no credentials logged`);process.exitCode=1;}
finally{
 client?.stop();
 if(cliChild){cliChild.kill('SIGTERM');await Promise.race([once(cliChild,'exit'),sleep(3000)]);if(cliChild.exitCode===null)cliChild.kill('SIGKILL');}
 if(fake){fake.closeAllConnections();await new Promise(r=>fake.close(r));}
 if(child){try{process.kill(-child.pid,'SIGTERM');}catch{};await Promise.race([once(child,'exit'),sleep(3000)]);try{process.kill(-child.pid,'SIGKILL');}catch{}}
 if(dir)await rm(dir,{recursive:true,force:true});
 console.log('CLEANUP only test relay processes and fake endpoint stopped; existing brokers and tunnels untouched');
}
