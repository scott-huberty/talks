// Local visual QA using an isolated headless Chrome, not a personal browser profile.
// Usage: node gatlinburg-2026/qa.mjs [URL]
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '.qa');
await mkdir(out, {recursive: true});
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=9223', '--remote-debugging-address=127.0.0.1',
  `--user-data-dir=${path.join(out,'chrome-profile')}`, 'about:blank'
], {stdio:'ignore'});
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
let socket;
try {
  let tabs;
  for (let i=0;i<60;i++) {
    try { tabs = await (await fetch('http://127.0.0.1:9223/json/list')).json(); if(tabs.length) break; } catch {}
    await pause(500);
  }
  if(!tabs?.length) throw new Error('Isolated Chrome did not start');
  socket = new WebSocket(tabs.find(t => t.type==='page').webSocketDebuggerUrl);
  await new Promise((resolve,reject) => {socket.onopen=resolve;socket.onerror=reject;});
  let id=0;
  const pending=new Map();
  socket.onmessage=event => {
    const msg=JSON.parse(event.data);
    if(pending.has(msg.id)) {
      const {resolve,reject}=pending.get(msg.id);pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  };
  const send=(method,params={}) => new Promise((resolve,reject) => {
    const current=++id;pending.set(current,{resolve,reject});
    socket.send(JSON.stringify({id:current,method,params}));
  });
  const evaluate=async expression => {
    const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if(r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:1600,height:900,deviceScaleFactor:1,mobile:false});
  await send('Page.navigate',{url:process.argv[2] || 'http://localhost:4321/gatlinburg-2026/'});
  for(let i=0;i<80;i++) {
    if(await evaluate('typeof Reveal !== "undefined" && Reveal.isReady()')) break;
    await pause(250);
  }
  await evaluate('document.fonts.ready.then(() => true)');
  const slides=await evaluate('Reveal.getSlides().map(s => ({id:s.id,title:s.querySelector("h1,h2")?.innerText}))');
  const report=[];
  for(let i=0;i<slides.length;i++) {
    await evaluate(`Reveal.slide(${i}); true`);
    await pause(350);
    const geometry=await evaluate(`(() => {
      const slide=Reveal.getCurrentSlide();
      const nodes=[...slide.querySelectorAll('h1,h2,h3,p,li,img,table')].filter(e=>!e.closest('aside'));
      const overflow=nodes.filter(e=>{
        const r=e.getBoundingClientRect();return r.width>0 && (r.left < 0 || r.right > innerWidth || r.top < 0 || r.bottom > innerHeight-25);
      }).map(e=>({tag:e.tagName,text:e.innerText?.slice(0,100),rect:e.getBoundingClientRect().toJSON()}));
      const title=slide.querySelector('h2');
      const wrapped=title ? title.offsetHeight / parseFloat(getComputedStyle(title).lineHeight) > 1.6 : false;
      const broken=[...slide.querySelectorAll('img')].filter(e=>!e.complete || !e.naturalWidth).map(e=>e.src);
      return {overflow,wrapped,broken};
    })()`);
    const shot=await send('Page.captureScreenshot',{format:'png'});
    await writeFile(path.join(out,`slide-${String(i+1).padStart(2,'0')}.png`),Buffer.from(shot.data,'base64'));
    report.push({slide:i+1,...slides[i],...geometry});
  }
  await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
} finally {
  socket?.close();
  chrome.kill('SIGTERM');
}
