// Read-only review probes. No native desktop actions or production writes.
// reproduced:true means a defect was observed, NOT product acceptance.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createCuUiRegistry } from '../../lib/cu-ui-session.mjs';

function clientHarness() {
  let factory;
  let decodeResolve;
  let fetchReject;
  const timers = new Map();
  let id = 0;
  const box = {
    window: { __ModuleLoader__: { load(def) { factory = def.factory; } } },
    console, AbortController, Response, Blob, TextDecoder, TextEncoder,
    performance: { now: () => 10000 },
    setTimeout(fn, ms) { const key = ++id; timers.set(key, {fn, ms}); return key; },
    clearTimeout(key) { timers.delete(key); },
    fetch(_url, opts) { return new Promise((_resolve, reject) => {
      fetchReject = reject;
      opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('abort'), {name:'AbortError'})));
    }); },
    createImageBitmap() { return new Promise(resolve => { decodeResolve = resolve; }); },
  };
  const raw = readFileSync(new URL('../../client.js', import.meta.url), 'utf8');
  const marker = '    return {\n      inject: ["slots", "locale"],';
  if (!raw.includes(marker)) throw new Error('review instrumentation marker changed');
  const source = raw.replace(marker,
    '    globalThis.__reviewClasses = {SessionStore, PreviewController};\n' + marker);
  vm.runInNewContext(source, box, {filename:'client.js (in-memory review export)'});
  factory(() => ({createElement(){}}));
  return {box,timers,classes:box.__reviewClasses,resolveDecode:v=>decodeResolve(v)};
}

const results=[];
{
  const h=clientHarness();
  const store=new h.classes.SessionStore('chat-a');
  const pending=store.pollNow(false);
  store.stop();
  await pending;
  results.push({id:'R1-unmount-poll',reproduced:h.timers.size>0,
    observation:{mounts:store.mounts,timersAfterStop:h.timers.size}});
}
{
  const h=clientHarness();
  const store=new h.classes.SessionStore('chat-a');
  store.snapshot={cuSessionId:'cu-a',targetGeneration:1};
  const preview=store.preview;
  let draws=0;
  preview.canvas={width:2,height:2,getContext:()=>({drawImage(){draws++;}})};
  preview.running=true; preview.abort=new AbortController();
  preview.present({version:1,cuSessionId:'cu-a',targetGeneration:1,frameId:'old'},new Uint8Array([1]),1);
  preview.close();
  store.snapshot={cuSessionId:'cu-a',targetGeneration:2};
  preview.running=true; preview.abort=new AbortController();
  h.resolveDecode({width:2,height:2,close(){}});
  await Promise.resolve(); await Promise.resolve();
  results.push({id:'R2-late-decode',reproduced:draws>0,
    observation:{drawsOfGeneration1AfterSwitchTo2:draws,status:store.previewInfo.status}});
}
{
  const manager={activeSession:null,sessionGeneration:0,cancelInFlight(){},async stopVisualSession(){
    return {ok:true,cleanupState:'unknown'};
  }};
  const registry=createCuUiRegistry({manager});
  const first=registry.beginAction('chat-a',{tool:'cu_click'});
  await registry.control({hostSessionId:'chat-a',cuSessionId:first.cuSessionId,command:'stop'});
  registry.beginAction('chat-a',{tool:'cu_type'});
  registry.endAction('chat-a',{ok:false,error:'old_click_failed'});
  results.push({id:'R3-old-action-new-session',reproduced:registry.snapshot('chat-a').error==='old_click_failed',
    observation:{state:registry.snapshot('chat-a').state,error:registry.snapshot('chat-a').error}});
}
{
  const manager={activeSession:null,sessionGeneration:0,cancelInFlight(){},async stopVisualSession(){return {ok:true};}};
  const registry=createCuUiRegistry({manager});
  const first=registry.beginAction('chat-a',{tool:'cu_click'});
  const observed=registry.snapshot('chat-a');
  registry.endAction('chat-a',{ok:true});
  const stop=await registry.control({hostSessionId:'chat-a',cuSessionId:first.cuSessionId,
    expectedRevision:observed.revision,command:'stop'});
  results.push({id:'R4-stop-stale-revision',reproduced:stop.status===409,
    observation:{error:stop.error,inputGateClosed:manager.inputGateClosed===true}});
}
console.log(JSON.stringify({scope:'in-memory client and real registry; no desktop input',results},null,2));
