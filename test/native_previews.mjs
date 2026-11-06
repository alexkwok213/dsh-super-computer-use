import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { NativePreviews } from '../lib/native-previews.mjs';

const fixture = `process.stdin.setEncoding('utf8'); process.stdin.on('data', data => {
 for (const line of data.trim().split('\\n')) { const cmd = JSON.parse(line);
 if (cmd.cmd === 'stop') process.exit(0);
 else process.stdout.write(JSON.stringify({event:cmd.cmd})+'\\n'); }
}); process.stdout.write('{"event":"ready"}\\n');`;
function harness() {
 const events=[];
 const children=[];
 const previews=new NativePreviews({launch:()=>{
  const child=spawn(process.execPath,['-e',fixture],{stdio:['pipe','pipe','ignore']});
  children.push(child); return child;
 },onEvent:(identity,event)=>events.push([identity,event]),keepAlive:true});
 return {previews,events,children};
}
const wait = ms => new Promise(resolve=>setTimeout(resolve,ms));
test('closing one native preview leaves the sibling alive and responsive',async()=>{
 const {previews,events,children}=harness();
 try {
  previews.open({targetId:'a',generation:1,windowId:11});
  previews.open({targetId:'b',generation:2,windowId:22});
  await wait(150);
  const exited=once(children[0],'exit');
  previews.close('a'); await exited;
  previews.send('b',{cmd:'ping'}); await wait(80);
  assert.ok(events.some(([id,e])=>id.targetId==='b'&&e.event==='ping'));
  assert.equal(children[1].exitCode,null);
 } finally {previews.close();}
});
test('a replaced preview cannot deliver events to its new incarnation',async()=>{
 const {previews,events,children}=harness();
 try {
  previews.open({targetId:'a',generation:1,windowId:11});
  await wait(100);
  previews.open({targetId:'a',generation:2,windowId:12});
  const before=events.length;
  children[0].stdout.emit('data',Buffer.from('{"event":"stop-target"}\n'));
  assert.equal(events.length,before);
  await wait(100);
  assert.ok(events.some(([id,e])=>id.generation===2&&e.event==='ready'));
 } finally {previews.close();}
});

const { CuSessionManager } = await import('../lib/core.mjs');
test('preview effects use the matching target observation and reject an old generation', () => {
 const manager = new CuSessionManager();
 manager.targets.set('a', {id:'a',pid:101,windowId:11,generation:3});
 manager.targets.set('b', {id:'b',pid:202,windowId:22,generation:4});
 manager.recordSnapshot(101,11,{nodes:[]},{targetId:'a',bounds:{x:10,y:20,width:800,height:400}});
 const sent=[];
 manager.nativePreviews={send:(id,cmd)=>sent.push([id,cmd])};
 const event={phase:'dispatched',kind:'click',clockDomain:'adapter',emittedNs:String(BigInt(Date.now())*1000000n),point:{x:100,y:100},
  target:{targetId:'a',pid:101,windowId:11,targetGeneration:3}};
 manager._previewActionFeedback(event);
 assert.equal(sent.length,1);
 assert.equal(sent[0][0],'a');
 assert.deepEqual(sent[0][1].bounds,{x:10,y:20,width:800,height:400});
 assert.equal(sent[0][1].click,true);
 manager._previewActionFeedback({...event,emittedNs:String(BigInt(Date.now()-5000)*1000000n)});
 manager._previewActionFeedback({...event,clockDomain:'unknown'});
 manager._previewActionFeedback({...event,target:{...event.target,windowId:22}});
 manager._previewActionFeedback({...event,target:{...event.target,targetGeneration:2}});
 manager._previewActionFeedback({...event,target:{targetId:'b',pid:202,windowId:22,targetGeneration:4}});
 assert.equal(sent.length,1);
});

test('the target halo stop routes to its own incarnation only', async () => {
 const {EventEmitter}=await import('node:events');
 const manager=new CuSessionManager();
 const target={id:'a',generation:3,indicators:new Set()};
 const calls=[];
 let options;
 manager.spawnIndicator=(_args,opts)=>{options=opts;return new EventEmitter();};
 manager.stopTarget=async id=>calls.push(id);
 manager._spawnTargetIndicator(target,['halo']);
 assert.equal(options.targetScoped,true);
 options.onEvent({halo:'stopped'});
 await Promise.resolve();
 assert.deepEqual(calls,['a']);
 target.generation=4;
 options.onEvent({halo:'stopped'});
 assert.deepEqual(calls,['a']);
});

test('a new preview reuses a free placement slot without overlapping its sibling', async () => {
 const {previews}=harness();
 const manager=new CuSessionManager();
 manager.ensureScreenIndicator=()=>{};
 manager.nativePreviews=previews;
 for (const [id,windowId] of [['a',11],['b',22],['c',33]]) {
  manager.targets.set(id,{id,windowId,generation:1});
 }
 try {
  manager.startNativePreview(11);
  manager.startNativePreview(22);
  assert.equal(previews.entries.get('b').identity.slot,1);
  manager.stopNativePreview('a');
  manager.startNativePreview(33);
  assert.equal(previews.entries.get('c').identity.slot,0);
  assert.equal(previews.entries.get('b').identity.slot,1);
 } finally {previews.close();}
});

test('closing a preview reports closed without closing the target input gate', () => {
 const manager=new CuSessionManager();
 const target={id:'a',pid:101,windowId:11,generation:3,nativePreview:{status:'live'}};
 manager.targets.set('a',target);
 manager._previewWindows().onEvent({targetId:'a',generation:3}, {event:'close-preview'});
 assert.equal(target.previewDismissed,true);
 assert.equal(target.nativePreview.status,'closed');
 assert.notEqual(target.gateClosed,true);
 assert.notEqual(target.stopped,true);
});

test('preview geometry stays separate from the controlled window and survives live status', () => {
 const manager=new CuSessionManager();
 const target={id:'a',pid:101,windowId:11,generation:3};
 manager.targets.set('a',target);
 const receive=manager._previewWindows().onEvent;
 receive({targetId:'a',generation:3},{event:'preview-geometry',previewWindowId:99,
  frame:{x:1200,y:40,width:320,height:240}});
 receive({targetId:'a',generation:3},{ok:true,preview:'live'});
 assert.equal(target.windowId,11);
 assert.equal(target.nativePreview.windowId,99);
 assert.deepEqual(target.nativePreview.frame,{x:1200,y:40,width:320,height:240});
 assert.equal(target.nativePreview.status,'live');
});
