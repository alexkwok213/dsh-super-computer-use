// Drive repeated real actions on the demo window through the cu_* tool layer for
// N seconds (used to film a demo). Connects to the installed service.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { CuSessionManager } from "../../lib/core.mjs";
import { registerCuTools } from "../../lib/index.mjs";
const seconds = Number(process.argv[2] || 28);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tools = new Map();
const ctx = { tools: { register(d){tools.set(d.name,d);return ()=>{};}, }, get(){return undefined;} };
const manager = new CuSessionManager();
manager.writeActivity = () => {};
registerCuTools({ ctx, manager, config: { autoSession: false, observeBudgetMs: 0 } });
const run = { signal: new AbortController().signal, agent: { options: { provider: "e2e", model: "e2e" } } };
const call = (n,a={}) => tools.get(n).execute(a, run);
const txt = (s) => (Array.isArray(s?.lines)?s.lines.join("\n"):"");
const counter = (s) => { const m=/Demo Button (\d+)/.exec(txt(s)); return m?Number(m[1]):-1; };
(async () => {
  let w=null;
  for (let i=0;i<40&&!w;i++){ await sleep(150); const o=await manager.exec(["windows"]).catch(()=>null); w=(o?.windows??[]).find(x=>x.title==="cu demo window"&&x.windowId>0)??null; }
  if(!w){ console.error("no demo"); process.exit(1); }
  await call("cu_session",{action:"start",windowId:w.windowId,pid:w.pid,appName:"Demo",dockDsh:false,splitScreen:false,preview:false});
  const end=Date.now()+seconds*1000; let n=0;
  while(Date.now()<end){
    const s=await call("cu_snapshot",{pid:w.pid,windowId:w.windowId,full:true});
    const before=counter(s); const line=(s.lines??[]).find(l=>l.includes("Demo Button"));
    if(line){ await call("cu_click",{pid:w.pid,windowId:w.windowId,ref:line.split(" ")[0],observe:false,expect:{query:`Demo Button ${before+1}`,timeoutMs:1500}}); }
    const fl=(s.lines??[]).find(l=>l.includes("AXTextField")&&!l.includes("AXSecureTextField"));
    if(fl){ await call("cu_type",{pid:w.pid,windowId:w.windowId,ref:fl.split(" ")[0],text:`t${n}-${Date.now().toString(36)}`,mode:"type",observe:false,expect:{query:`t${n}`,timeoutMs:1500}}); }
    n++; await sleep(900);
  }
  await call("cu_session",{action:"stop"});
  const events = manager.eventLog?.events ?? [];
  writeFileSync(process.argv[3] || "/tmp/loop_events.jsonl", events.map((e)=>JSON.stringify(e)).join("\n")+"\n");
  console.log(JSON.stringify({ok:true,cycles:n,eventCount:events.length,phases:events.map(e=>e.phase)}));
})();
