'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const{BrowserWindow,session}=require('electron');
const{randomUUID}=require('node:crypto');
const{run}=require('./media.cjs');

async function renderSVG(source,destination,settings,job){
  if((await fs.stat(source)).size>20*1024*1024)throw new Error('SVG 超过 20 MB，请先精简。');
  const text=new TextDecoder('utf-8',{fatal:true}).decode(await fs.readFile(source));
  if(/<!DOCTYPE|<!ENTITY/i.test(text))throw new Error('SVG 包含 DTD 或实体定义，请导出为普通 SVG。');
  const isolated=session.fromPartition('relive-svg-'+randomUUID());
  isolated.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  isolated.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!details.url.startsWith('data:')&&!details.url.startsWith('blob:')}));
  const window=new BrowserWindow({width:320,height:240,show:false,webPreferences:{session:isolated,nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false,offscreen:{useSharedTexture:false,deviceScaleFactor:1}}});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',event=>event.preventDefault());
  const frames=path.join(path.dirname(destination),'svg-frames-'+randomUUID());
  await fs.mkdir(frames);
  try{
    const background=settings.background==='#000000'?'#000000':'#FFFFFF';
    const html=`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none';style-src 'unsafe-inline';img-src data: blob:;font-src data:;script-src 'none';connect-src 'none'"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:${background}}svg{display:block;width:100%;height:100%}*{animation-play-state:paused!important}</style></head><body></body></html>`;
    await window.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html));
    const dimensions=await window.webContents.executeJavaScript(`(()=>{
      const parsed=new DOMParser().parseFromString(${JSON.stringify(text)},'image/svg+xml');
      const root=parsed.documentElement;
      if(parsed.querySelector('parsererror')||root.localName!=='svg')throw new Error('不是有效的SVG');
      const vb=(root.getAttribute('viewBox')||'').trim().split(/[ ,\\s]+/).map(Number);
      const get=key=>{const value=root.getAttribute(key)||'';return value.includes('%')?0:parseFloat(value)||0};
      let width=get('width')||(vb.length===4?vb[2]:0)||1080,height=get('height')||(vb.length===4?vb[3]:0)||1080;
      if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0||width/height>100||height/width>100)throw new Error('SVG尺寸不正确');
      const scale=Math.min(1,1920/Math.max(width,height));
      width=Math.max(2,Math.floor(width*scale/2)*2);height=Math.max(2,Math.floor(height*scale/2)*2);
      root.setAttribute('width','100%');root.setAttribute('height','100%');document.body.append(document.importNode(root,true));
      return{width,height};
    })()`);
    window.setContentSize(dimensions.width,dimensions.height);
    window.webContents.setFrameRate(30);
    const count=Math.ceil(settings.svgDuration*30);
    for(let frame=0;frame<count;frame++){
      job.check();
      await window.webContents.executeJavaScript(`(async()=>{const svg=document.querySelector('svg');svg.pauseAnimations();svg.setCurrentTime(${frame/30});document.getAnimations().forEach(a=>{a.pause();a.currentTime=${frame/30*1000}});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));})()`);
      const snapshot=await window.webContents.capturePage({x:0,y:0,width:dimensions.width,height:dimensions.height},{stayHidden:true});
      await fs.writeFile(path.join(frames,String(frame).padStart(6,'0')+'.png'),snapshot.toPNG());
      job.progress({stage:'正在录制 SVG 动画',progress:(frame+1)/count*0.8});
    }
    await run('ffmpeg',['-v','error','-nostdin','-framerate','30','-i',path.join(frames,'%06d.png'),'-vf',`scale=${dimensions.width}:${dimensions.height},format=yuv420p`,'-c:v','libx264','-preset','fast','-crf','18','-movflags','+faststart',destination],job);
  }finally{if(!window.isDestroyed())window.destroy();await fs.rm(frames,{recursive:true,force:true});}
}
module.exports={renderSVG};
