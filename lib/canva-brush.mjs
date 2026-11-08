// Canva whiteboard brush control over CDP.
//
// The whiteboard's brush UI is a set of self-drawn React widgets. Clicking by
// screenshot coordinates is unreliable, but every control IS a real DOM node
// with an aria-label and, for the numeric ones, a native <input type="range">.
// Driving those through the page's own DOM (native value setter + input/change
// events) is deterministic and needs no pixel math.
//
// Verified controls (Canva whiteboard, 2026-11):
//   画笔        rail tool button; background rgba(57,70,96,.14) == armed
//   颜色        opens the palette
//   添加新颜色   palette entry that reveals a hex text input (value "#rrggbb")
//   设置        opens brush settings: two <input type=range>
//                 [0] = thickness (default 36 px)
//                 [1] = opacity   (default 50 %)

const SET_TIMEOUT = 2500;

async function evalJson(client, expression) {
  const r = await client.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  try { return JSON.parse(r.result.value); } catch { return r.result.value; }
}

async function waitFor(client, expression, timeout = SET_TIMEOUT) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const v = await evalJson(client, expression);
    if (v) return v;
    await new Promise((r) => setTimeout(r, 120));
  }
  return null;
}

/** True when the brush tool is the active rail tool. */
export async function isBrushArmed(client) {
  const bg = await evalJson(client, `(()=>{const b=[...document.querySelectorAll('[aria-label]')].find(e=>e.getAttribute('aria-label')==='画笔');return b?getComputedStyle(b).backgroundColor:'none'})()`);
  return typeof bg === "string" && /57,\s*70,\s*96/.test(bg);
}

/** Click the rail brush tool once and confirm it is armed. */
export async function armBrush(client) {
  if (await isBrushArmed(client)) return true;
  await evalJson(client, `(()=>{const b=[...document.querySelectorAll('[aria-label]')].find(e=>e.getAttribute('aria-label')==='画笔');if(b){b.click();return 'clicked'}return 'missing'})()`);
  const ok = await waitFor(client, `(()=>{const b=[...document.querySelectorAll('[aria-label]')].find(e=>e.getAttribute('aria-label')==='画笔');return b?/57,\\s*70,\\s*96/.test(getComputedStyle(b).backgroundColor):false})()`);
  return Boolean(ok);
}

/** Open the 设置 popover and return the two range inputs' current values. */
export async function readBrushSettings(client) {
  await evalJson(client, `(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.getAttribute('aria-label')==='设置');if(b)b.click();return 'ok'})()`);
  const vals = await waitFor(client, `(()=>{const rs=[...document.querySelectorAll('input[type=range]')];return rs.length>=2?JSON.stringify(rs.map(r=>r.value)):null})()`);
  return vals ? JSON.parse(vals) : null;
}

/** Set brush thickness (px) and/or opacity (0-100) through the 设置 sliders. */
export async function setBrushStyle(client, { thickness, opacity } = {}) {
  // Ensure the settings popover is open.
  await evalJson(client, `(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.getAttribute('aria-label')==='设置');if(b)b.click();return 'ok'})()`);
  const ready = await waitFor(client, `(()=>{const rs=[...document.querySelectorAll('input[type=range]')].filter(e=>{const r=e.getBoundingClientRect();return r.x>150&&r.x<520&&r.y>450&&r.y<760});return rs.length>=2?true:null})()`);
  if (!ready) throw new Error("brush settings did not open (no range inputs)");
  const applied = await evalJson(client, `(()=>{
    const rs=[...document.querySelectorAll('input[type=range]')].filter(e=>{const r=e.getBoundingClientRect();return r.x>150&&r.x<520&&r.y>450&&r.y<760});
    const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
    const fire=(el,v)=>{setter.call(el,String(v));el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));};
    ${thickness != null ? `fire(rs[0], ${Number(thickness)});` : ""}
    ${opacity != null ? `fire(rs[1], ${Number(opacity)});` : ""}
    return JSON.stringify(rs.map(r=>r.value));
  })()`);
  return applied;
}

/** Close any open popover so the next canvas drag paints instead of hitting UI. */
export async function closePopovers(client) {
  await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
}

/** Set the brush colour to an arbitrary #rrggbb through 颜色 → 添加新颜色 → hex. */
export async function setBrushColor(client, hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error("hex must be #rrggbb");
  // Open palette
  await evalJson(client, `(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.getAttribute('aria-label')==='颜色');if(b)b.click();return 'ok'})()`);
  await new Promise((r) => setTimeout(r, 350));
  // If a preset with this exact colour is present, click it (cheapest path).
  const preset = await evalJson(client, `(()=>{const b=[...document.querySelectorAll('[aria-label]')].find(e=>e.getAttribute('aria-label').toLowerCase()===${JSON.stringify(hex.toLowerCase())});if(!b)return null;b.click();return 'preset'})()`);
  if (preset === "preset") {
    await new Promise((r) => setTimeout(r, 250));
    return { applied: hex, via: "preset" };
  }
  // Otherwise add a new colour and type the hex.
  const added = await evalJson(client, `(()=>{const b=[...document.querySelectorAll('[aria-label]')].find(e=>e.getAttribute('aria-label')==='添加新颜色');if(!b)return null;b.click();return 'add'})()`);
  if (added !== "add") throw new Error("colour palette did not expose 添加新颜色");
  const ok = await waitFor(client, `(()=>{const e=[...document.querySelectorAll('input')].find(x=>x.type==='text'&&/^#[0-9a-f]{6}$/i.test(x.value||''));return e?true:null})()`);
  if (!ok) throw new Error("hex input did not appear");
  await evalJson(client, `(()=>{
    const el=[...document.querySelectorAll('input')].find(x=>x.type==='text'&&/^#[0-9a-f]{6}$/i.test(x.value||''));
    const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
    el.focus(); setter.call(el, ${JSON.stringify(hex)});
    el.dispatchEvent(new Event('input',{bubbles:true}));
    el.dispatchEvent(new Event('change',{bubbles:true}));
    el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,bubbles:true}));
    el.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',code:'Enter',keyCode:13,bubbles:true}));
    return 'typed';
  })()`);
  await new Promise((r) => setTimeout(r, 350));
  const cur = await evalJson(client, `(()=>{const e=[...document.querySelectorAll('[role=img][aria-label]')].find(x=>/^#[0-9a-f]{6}$/i.test(x.getAttribute('aria-label')));return e?e.getAttribute('aria-label'):null})()`);
  return { applied: cur || null, via: "hex", requested: hex };
}

/** Clear every element on the current page (select all + delete twice). */
export async function clearCanvas(client) {
  const click = async (x, y) => {
    await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  };
  const key = async (code, k, vk, mods = 0) => {
    await client.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers: mods, key: k, code, windowsVirtualKeyCode: vk });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: mods, key: k, code, windowsVirtualKeyCode: vk });
  };
  await click(500, 300);
  for (let i = 0; i < 2; i++) {
    await new Promise((r) => setTimeout(r, 200));
    await key("KeyA", "a", 65, 4);
    await new Promise((r) => setTimeout(r, 250));
    await key("Delete", "Delete", 46);
    await new Promise((r) => setTimeout(r, 250));
  }
}
