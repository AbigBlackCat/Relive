'use strict';
const path = require('node:path');
const {spawn} = require('node:child_process');
const {pathToFileURL} = require('node:url');

class Cancelled extends Error { constructor() { super('已取消'); this.name='Cancelled'; } }
class Job {
  constructor(progress=()=>{}) { this.progress=progress; this.cancelled=false; this.child=null; }
  cancel() { this.cancelled=true; this.child?.kill(); }
  check() { if(this.cancelled) throw new Cancelled(); }
}
function tool(name) {
  if(process.env['RELIVE_'+name.toUpperCase()]) return process.env['RELIVE_'+name.toUpperCase()];
  const suffix=process.platform==='win32'?'.exe':'';
  const root=path.resolve(__dirname,'../..');
  const base=process.resourcesPath && !process.defaultApp ? path.join(process.resourcesPath,'bin') : process.platform==='win32' ? path.join(root,'desktop/vendor/win32-x64') : path.join(root,'Resources/bin');
  return path.join(base,name+suffix);
}
function run(name,args,job,{duration=0,stage='正在处理素材',scale=1}={}) {
  job.check();
  return new Promise((resolve,reject)=>{
    const child=spawn(tool(name),args,{windowsHide:true,stdio:['ignore','pipe','pipe']});
    job.child=child;
    let stdout='',stderr='',pending='',settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;if(job.child===child)job.child=null;error?reject(error):resolve(value);};
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',data=>{
      stdout=(stdout+data).slice(-4*1024*1024);pending+=data;
      const lines=pending.split('\n');pending=lines.pop();
      for(const line of lines) if(line.startsWith('out_time_us=')&&duration>0){const value=Number(line.slice(12));if(Number.isFinite(value))job.progress({stage,progress:Math.max(0,Math.min(1,value/1e6/duration))*scale});}
    });
    child.stderr.on('data',data=>{stderr=(stderr+data).slice(-16000);});
    child.once('error',error=>finish(job.cancelled?new Cancelled():new Error('无法启动内置 '+name+'：'+error.message)));
    child.once('close',code=>finish(job.cancelled?new Cancelled():code===0?null:new Error('媒体处理失败：'+(stderr.trim()||'退出码 '+code)),stdout));
    if(job.cancelled)child.kill();
  });
}
async function probe(filename,job) {
  const json=JSON.parse(await run('ffprobe',['-v','error','-show_streams','-show_format','-of','json',filename],job));
  const video=json.streams?.find(s=>s.codec_type==='video');
  if(!video||!(video.width>0&&video.height>0&&video.width<=32768&&video.height<=32768))throw new Error('未找到可读取的画面。');
  const rational=text=>{const[n,d]=String(text||'0/0').split('/').map(Number);return n>0&&d>0?n/d:0;};
  const fps=rational(video.avg_frame_rate)||rational(video.r_frame_rate)||30;
  const duration=Math.max(Number(video.duration)||0,Number(json.format?.duration)||0);
  const frameCount=Number(video.nb_frames)||Math.max(1,Math.round(duration*fps));
  if(![fps,duration,frameCount].every(Number.isFinite)||!Number.isSafeInteger(frameCount)||frameCount<1)throw new Error('素材时长或帧率不正确。');
  return{width:video.width,height:video.height,fps,duration,frameCount,hasAudio:json.streams.some(s=>s.codec_type==='audio')};
}
async function normalize(input,destination,settings,job) {
  const info=await probe(input,job),ext=path.extname(input).slice(1).toLowerCase();
  const still=['png','jpg','jpeg','heic','heif','bmp','tif','tiff','webp'].includes(ext)&&info.duration<=0;
  const fps=still||ext==='gif'?30:Math.min(60,Math.max(1,info.fps)),seconds=still?settings.svgDuration:info.duration;
  const background=settings.background==='#000000'?'0x000000':'0xFFFFFF';
  const scale="scale=w='max(2,min(1920,iw))':h='max(2,min(1920,ih))':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1";
  const filter=`[0:v:0]${scale},format=rgba,split=2[base][fg];[base]drawbox=x=0:y=0:w=iw:h=ih:color=${background}:t=fill:replace=1[bg];[bg][fg]overlay=shortest=1:format=auto,format=yuv420p[v]`;
  const args=['-v','error','-nostdin','-nostats','-progress','pipe:1'];
  if(still)args.push('-loop','1');
  args.push('-i',input,'-filter_complex',filter,'-map','[v]','-map','0:a?');
  if(still)args.push('-t',String(seconds));
  args.push('-r',String(fps),'-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p','-c:a','aac','-b:a','192k','-ar','48000','-movflags','+faststart',destination);
  await run('ffmpeg',args,job,{duration:seconds,stage:'正在转换素材'});
  return probe(destination,job);
}
async function describe(preview,original,id,directory,job) {
  const info=await probe(preview,job),duration=info.frameCount/info.fps,thumbnail=path.join(directory,'thumbnail.jpg');
  await run('ffmpeg',['-v','error','-nostdin','-i',preview,'-frames:v','1','-vf','scale=240:160:force_original_aspect_ratio=decrease','-q:v','3',thumbnail],job);
  const thumbnails=[];
  for(let n=0;n<10;n++){
    job.check();const time=Math.round(n/9*(info.frameCount-1))/info.fps,target=path.join(directory,'frame-'+n+'.jpg');
    await run('ffmpeg',['-v','error','-nostdin','-ss',String(time),'-i',preview,'-frames:v','1','-vf','scale=160:100:force_original_aspect_ratio=decrease','-q:v','3',target],job);
    thumbnails.push({url:pathToFileURL(target).href,time});
  }
  return{id,name:path.basename(original,path.extname(original)),kind:path.extname(original).slice(1).toUpperCase(),previewURL:pathToFileURL(preview).href,thumbnailURL:pathToFileURL(thumbnail).href,width:info.width,height:info.height,fps:info.fps,frameCount:info.frameCount,duration,thumbnails};
}
async function exportClip(item,config,directory,job) {
  const{startFrame,endFrame,coverFrame}=config;
  for(const value of[startFrame,endFrame,coverFrame])if(!Number.isSafeInteger(value))throw new Error('请输入整数帧号。');
  if(!(1<=startFrame&&startFrame<=coverFrame&&coverFrame<=endFrame&&endFrame<=item.frameCount))throw new Error('封面必须位于有效的导出片段内。');
  const start=(startFrame-1)/item.fps,duration=(endFrame-startFrame+1)/item.fps,coverTime=(coverFrame-startFrame)/item.fps;
  const side=config.maxSide===1920?1920:1080,movie=path.join(directory,'clip.mov'),jpeg=path.join(directory,'cover.jpg');
  const args=['-v','error','-nostdin','-nostats','-progress','pipe:1','-i',item.previewPath,'-ss',String(start),'-t',String(duration),'-map','0:v:0'];
  if(config.keepAudio)args.push('-map','0:a?');else args.push('-an');
  args.push('-vf',`scale=w='max(2,min(${side},iw))':h='max(2,min(${side},ih))':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1`,'-r',String(item.fps),'-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p','-c:a','aac','-b:a','192k','-f','mov',movie);
  await run('ffmpeg',args,job,{duration,stage:'正在制作 Live Photo',scale:0.75});
  await run('ffmpeg',['-v','error','-nostdin','-ss',String(coverTime),'-i',movie,'-frames:v','1','-q:v','2',jpeg],job);
  job.check();return{movie,jpeg,coverTime,fps:item.fps};
}
module.exports={Job,Cancelled,run,probe,normalize,describe,exportClip,tool};
