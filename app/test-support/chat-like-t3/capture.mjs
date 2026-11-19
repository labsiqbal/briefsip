import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from '../ui-smoke/node_modules/playwright-core/index.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(new URL('../../package.json', import.meta.url));
const { createServer } = require('vite');
const output = fileURLToPath(new URL('../ui-smoke/artifacts/chat-like-t3/', import.meta.url));
const server = await createServer({root,configFile:root+'vite.config.ts',cacheDir:root+'node_modules/.chat-fidelity-vite',server:{host:'127.0.0.1',port:0,watch:null},esbuild:{jsx:'automatic'},resolve:{alias:{react:root+'node_modules/react','react-dom':root+'node_modules/react-dom'}}});
let browser;
const errors=[];const cases=[];
process.once('SIGTERM',async()=>{await browser?.close();await server.close();process.exit(1)});
try {
 await server.listen();
 browser=await chromium.launch({channel:'chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1600,height:1600}});
 page.on('pageerror',error=>errors.push(error.message));
 const base=`http://127.0.0.1:${server.httpServer.address().port}/test-support/chat-like-t3/harness.html`;
 await mkdir(output+'screenshots',{recursive:true});
 for(const kind of ['direct','room']) {
  for(const width of [1600,480]) for(const size of ['compact','default','large','larger']) for(const palette of ['briefsip','github','catppuccin','everforest','solarized','midnight']) for(const theme of ['dark','light']) {
   await page.setViewportSize({width,height:1600});
   await page.goto(base+'?'+new URLSearchParams({kind,size,palette,theme}));
   await page.locator('.briefsip-side .message-body .markdown p').first().waitFor({timeout:15000});
   await page.evaluate(()=>document.fonts.ready);
   // Keep the actual Radix work log expanded in the reference capture.
   if(kind==='room') await page.getByRole('region', { name: 'Reply from Release Lead' }).locator('.room-agent__status').click();
   const disclosure=page.locator('.briefsip-side .turn-activity .k-collapsible__trigger').first();
   if(kind==='direct' && await disclosure.count())await disclosure.click();
   await page.mouse.move(0,0);
   const values=await page.evaluate(()=>{
    const css=(selector)=>{const s=getComputedStyle(document.querySelector('.briefsip-side '+selector));return {fontSize:s.fontSize,lineHeight:s.lineHeight,padding:s.padding,borderRadius:s.borderRadius,maxWidth:s.maxWidth,gap:s.gap,border:s.border,background:s.backgroundColor}};
    return {human:css('.human-bubble'),reply:css('.message-body .markdown p'),heading:css('.markdown :is(h1,h3)'),code:css('.markdown pre'),table:css('.markdown table'),cell:css('.markdown td'),composer:css('.composer'),input:css('.composer__input'),overflow:document.documentElement.scrollWidth>innerWidth+1};
   });
   assert(!values.overflow,`${kind}/${width}/${size}/${palette}/${theme}: page overflow`);
   {
    const scale={compact:.875,default:1,large:1.125,larger:1.25}[size];
    assert.equal(parseFloat(values.human.fontSize),14*scale);
    assert(Math.abs(parseFloat(values.human.lineHeight)-22.75*scale)<.001);
    assert.equal(parseFloat(values.heading.fontSize),20*scale);
    assert.equal(parseFloat(values.code.fontSize),13*scale);
    const match=await page.evaluate(()=>{
     const compare=(a,b,keys)=>keys.map(key=>[key,getComputedStyle(document.querySelector(a))[key],getComputedStyle(document.querySelector(b))[key]]);
     return [...compare('.t3-side .chat-markdown p','.briefsip-side .markdown p',['fontSize','lineHeight']),...compare('.t3-side .chat-markdown h1','.briefsip-side .markdown h1',['fontSize','lineHeight']),...compare('.t3-side .chat-markdown td','.briefsip-side .markdown td',['fontSize','padding','borderBottomWidth']),...compare('.ref-composer','.briefsip-side .composer',['borderRadius']),...compare('.t3-side .chat-markdown pre','.briefsip-side .markdown pre',['fontSize','lineHeight','padding'])];
    });
    for(const [key,t3,briefsip] of match) assert.equal(briefsip,t3,`${kind}/${width}/${size}/${palette}/${theme}: ${key}`);
    values.referenceComparison=match;
   }
   const name=`after-${kind}-${width}-${size}-${palette}-${theme}.png`;
   await page.screenshot({path:output+'screenshots/'+name,fullPage:true,animations:'disabled'});
   cases.push({kind,width,size,palette,theme,screenshot:'screenshots/'+name,...values});
  }
 }
 assert.deepEqual(errors,[]);
 await writeFile(output+'after.json',JSON.stringify({cases,errors},null,2)+'\n');
 console.log(`${cases.length} captures passed`);
}finally{await browser?.close();await server.close()}
