'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const {constants} = require('node:fs');
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
function run(name,args,job,{duration=0,stage='正在处理素材',scale=1,cwd,onStdoutLine,captureStdout=true}={}) {
  job.check();
  return new Promise((resolve,reject)=>{
    const child=spawn(tool(name),args,{windowsHide:true,cwd,stdio:['ignore','pipe','pipe']});
    job.child=child;
    let stdout='',stderr='',pending='',settled=false,processingError;
    const finish=(error,value)=>{if(settled)return;settled=true;if(job.child===child)job.child=null;error?reject(error):resolve(value);};
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',data=>{
      if(processingError)return;
      if(captureStdout)stdout=(stdout+data).slice(-4*1024*1024);pending+=data;
      const lines=pending.split('\n');pending=lines.pop();
      try{
        if(pending.length>65536)throw new Error('媒体工具返回了过长的数据行。');
        for(const line of lines){
          onStdoutLine?.(line);
          if(line.startsWith('out_time_us=')&&duration>0){const value=Number(line.slice(12));if(Number.isFinite(value))job.progress({stage,progress:Math.max(0,Math.min(1,value/1e6/duration))*scale});}
        }
      }catch(error){processingError=error;child.kill();}
    });
    child.stderr.on('data',data=>{stderr=(stderr+data).slice(-16000);});
    child.once('error',error=>finish(job.cancelled?new Cancelled():new Error('无法启动内置 '+name+'：'+error.message)));
    child.once('close',code=>{
      if(!settled&&!processingError&&pending&&onStdoutLine){try{onStdoutLine(pending);}catch(error){processingError=error;}}
      finish(job.cancelled?new Cancelled():processingError||(code===0?null:new Error('媒体处理失败：'+(stderr.trim()||'退出码 '+code))),stdout);
    });
    if(job.cancelled)child.kill();
  });
}
async function inspect(filename,job){return JSON.parse(await run('ffprobe',['-v','error','-show_streams','-show_format','-of','json',filename],job));}
async function probe(filename,job) {
  const json=await inspect(filename,job);
  const video=json.streams?.find(s=>s.codec_type==='video');
  if(!video||!(video.width>0&&video.height>0&&video.width<=32768&&video.height<=32768))throw new Error('未找到可读取的画面。');
  const rational=text=>{const[n,d]=String(text||'0/0').split('/').map(Number);return n>0&&d>0?n/d:0;};
  const fps=rational(video.avg_frame_rate)||rational(video.r_frame_rate)||30;
  const duration=Math.max(Number(video.duration)||0,Number(json.format?.duration)||0);
  const frameCount=Number(video.nb_frames)||Math.max(1,Math.round(duration*fps));
  if(![fps,duration,frameCount].every(Number.isFinite)||!Number.isSafeInteger(frameCount)||frameCount<1)throw new Error('素材时长或帧率不正确。');
  const rotation=Math.abs(Number(video.side_data_list?.find(side=>side.rotation!==undefined)?.rotation??video.tags?.rotate??0))%180;
  const rotated=Math.abs(rotation-90)<0.01;
  return{width:rotated?video.height:video.width,height:rotated?video.width:video.height,fps,duration,frameCount,hasAudio:json.streams.some(s=>s.codec_type==='audio'),pixelFormat:video.pix_fmt,hasAlpha:/rgba|argb|bgra|abgr|yuva|gbrap|pal8/.test(video.pix_fmt||'')};
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
const encoderLists=new Map();
async function ensureEncoders(names,job){
  const binary=tool('ffmpeg');
  if(!encoderLists.has(binary))encoderLists.set(binary,run('ffmpeg',['-hide_banner','-encoders'],job).then(output=>new Set(output.split('\n').map(line=>/^ [VAS][A-Z.]{5}\s+(\S+)/.exec(line)?.[1]).filter(Boolean))).catch(error=>{encoderLists.delete(binary);throw error;}));
  const available=await encoderLists.get(binary);job.check();
  for(const name of names)if(!available.has(name))throw new Error('内置 FFmpeg 缺少 '+name+' 编码器，请使用完整版本的 Relive。');
}
function quality(config){
  const value=config.quality??'standard';if(!['original','high','standard','small'].includes(value))throw new Error('请选择有效的画质。');return value;
}
function maxSide(config){
  const value=config.maxSide??1080;if(![0,720,1080,1920].includes(value))throw new Error('请选择原始尺寸、720、1080 或 1920。');return value;
}
function clipTimes(item,config){
  const{startFrame,endFrame}=config;
  if(![startFrame,endFrame].every(Number.isSafeInteger))throw new Error('请输入整数帧号。');
  if(!(1<=startFrame&&startFrame<=endFrame&&endFrame<=item.frameCount))throw new Error('请选择有效的导出片段。');
  return{start:(startFrame-1)/item.fps,duration:(endFrame-startFrame+1)/item.fps};
}
function geometry(item,config,even=true){
  const sourceWidth=item.sourceWidth||item.width,sourceHeight=item.sourceHeight||item.height;
  const crop=config.crop??{x:0,y:0,width:1,height:1};
  if(!crop||![crop.x,crop.y,crop.width,crop.height].every(Number.isFinite)||crop.x<0||crop.y<0||crop.width<=0||crop.height<=0||crop.x+crop.width>1.000001||crop.y+crop.height>1.000001)throw new Error('裁切区域必须位于画面内。');
  const unit=even?2:1,round=value=>Math.floor(value/unit)*unit;
  const x=round(crop.x*sourceWidth),y=round(crop.y*sourceHeight);
  const cropWidth=round(Math.min(crop.width*sourceWidth,sourceWidth-x)),cropHeight=round(Math.min(crop.height*sourceHeight,sourceHeight-y));
  if(cropWidth<unit||cropHeight<unit)throw new Error('裁切区域太小，请保留至少 '+unit+'×'+unit+' 像素。');
  const side=maxSide(config),ratio=side===0?1:Math.min(1,side/Math.max(cropWidth,cropHeight));
  const width=Math.max(unit,round(cropWidth*ratio)),height=Math.max(unit,round(cropHeight*ratio));
  return{width,height,x,y,cropWidth,cropHeight,filter:`crop=${cropWidth}:${cropHeight}:${x}:${y},scale=${width}:${height},setsar=1`};
}
function inputArgs(item){return[...(item.sourceIsStill?['-loop','1','-framerate',String(item.fps),'-t',String(item.duration||item.frameCount/item.fps)]:[]),'-i',item.sourcePath||item.previewPath];}
function visualFilter(item,chain){
  if(!item.sourceHasAlpha)return{args:['-vf',chain],map:'0:v:0'};
  const color=item.background==='#000000'?'0x000000':'0xFFFFFF';
  return{args:['-filter_complex',`[0:v:0]${chain},format=rgba,split=2[base][fg];[base]drawbox=x=0:y=0:w=iw:h=ih:color=${color}:t=fill:replace=1[bg];[bg][fg]overlay=shortest=1:format=auto[v]`],map:'[v]'};
}
async function saveFile(source,output,stem,extension,job){
  if(!stem||path.basename(stem)!==stem||!/^[a-z0-9]+$/.test(extension))throw new Error('导出文件名不正确。');
  await fs.mkdir(output,{recursive:true});await fs.access(output,constants.W_OK);
  let number=1,destination,writer;
  while(!writer){job.check();destination=path.join(output,stem+(number===1?'':' '+number)+'.'+extension);try{writer=await fs.open(destination,'wx');}catch(error){if(error.code==='EEXIST'){number++;continue;}throw error;}}
  let reader,complete=false;
  try{
    reader=await fs.open(source,'r');const buffer=Buffer.allocUnsafe(1024*1024);
    while(true){job.check();const{bytesRead}=await reader.read(buffer,0,buffer.length,null);if(!bytesRead)break;let written=0;while(written<bytesRead){job.check();const amount=(await writer.write(buffer,written,bytesRead-written,null)).bytesWritten;if(amount<1)throw new Error('无法写入导出文件。');written+=amount;}}
    await reader.close();reader=null;await writer.close();writer=null;job.check();complete=true;return destination;
  }finally{await reader?.close();await writer?.close();if(!complete)await fs.rm(destination,{force:true});}
}
async function exportClip(item,config,directory,job){
  const{start,duration}=clipTimes(item,config),coverFrame=config.coverFrame;
  if(!Number.isSafeInteger(coverFrame))throw new Error('请输入整数帧号。');
  if(coverFrame<config.startFrame||coverFrame>config.endFrame)throw new Error('封面必须位于有效的导出片段内。');
  const grade=quality(config),shape=geometry(item,config),filter=visualFilter(item,shape.filter);
  await ensureEncoders(['libx264',...(config.keepAudio===false?[]:['aac'])],job);
  const movie=path.join(directory,'clip.mov'),jpeg=path.join(directory,'cover.jpg'),coverTime=(coverFrame-config.startFrame)/item.fps;
  const args=['-v','error','-nostdin','-nostats','-progress','pipe:1',...inputArgs(item),'-ss',String(start),'-t',String(duration),...filter.args,'-map',filter.map];
  if(config.keepAudio!==false)args.push('-map','0:a?');else args.push('-an');
  args.push('-r',String(item.fps),'-c:v','libx264','-preset','fast','-crf',String({original:12,high:16,standard:20,small:28}[grade]),'-pix_fmt','yuv420p','-c:a','aac','-b:a',grade==='small'?'128k':'192k','-f','mov',movie);
  await run('ffmpeg',args,job,{duration,stage:'正在制作 Live Photo',scale:0.75});
  await run('ffmpeg',['-v','error','-nostdin','-ss',String(coverTime),'-i',movie,'-frames:v','1','-q:v','2',jpeg],job);
  job.check();return{movie,jpeg,coverTime,fps:item.fps};
}
const mediaFormats=new Set(['mp4','mov','mkv','webm','gif','mp3','wav']);
async function createMedia(item,config,directory,job){
  const format=config.format;if(!mediaFormats.has(format))throw new Error('请选择支持的导出格式。');
  const grade=quality(config),{start,duration}=clipTimes(item,config),audioOnly=format==='mp3'||format==='wav';
  const source=await inspect(item.sourcePath||item.previewPath,job),audio=source.streams?.find(stream=>stream.codec_type==='audio');
  if(audioOnly&&!audio)throw new Error('此素材没有声音，无法导出音频。');
  const filePath=path.join(directory,'export.'+format),args=['-v','error','-nostdin','-nostats','-progress','pipe:1',...inputArgs(item),'-ss',String(start),'-t',String(duration)];
  let shape,needed=[];
  if(audioOnly){
    args.push('-map','0:a:0','-vn');
    if(format==='mp3'){needed=['libmp3lame'];args.push('-c:a','libmp3lame','-b:a',{original:'320k',high:'256k',standard:'192k',small:'96k'}[grade]);}
    else{const codec=grade==='original'||grade==='high'?'pcm_s24le':'pcm_s16le';needed=[codec];args.push('-c:a',codec);if(grade==='small')args.push('-ar','32000');}
  }else{
    shape=geometry(item,config,format!=='gif');
    let chain=shape.filter;
    if(format==='gif'){
      const gifFPS=Math.min(item.fps,grade==='small'?15:30),colors=grade==='small'?128:256;
      chain+=`,fps=${gifFPS}`;
      const color=item.background==='#000000'?'0x000000':'0xFFFFFF';
      const opaque=item.sourceHasAlpha?`,format=rgba,split=2[base][fg];[base]drawbox=x=0:y=0:w=iw:h=ih:color=${color}:t=fill:replace=1[bg];[bg][fg]overlay=shortest=1:format=auto`:'';
      args.push('-filter_complex',`[0:v:0]${chain}${opaque},split[frames][palette];[palette]palettegen=max_colors=${colors}:reserve_transparent=0[p];[frames][p]paletteuse=dither=${grade==='small'?'bayer':'sierra2_4a'}[v]`,'-map','[v]','-an','-loop','0');needed=['gif'];
    }else{
      const filter=visualFilter(item,chain);args.push(...filter.args,'-map',filter.map);
      if(config.keepAudio!==false&&audio)args.push('-map','0:a:0');else args.push('-an');
      if(format==='webm'){
        needed=['libvpx-vp9',...(audio&&config.keepAudio!==false?['libopus']:[])];
        args.push('-c:v','libvpx-vp9','-deadline','good','-cpu-used','4','-b:v','0');
        if(grade==='original')args.push('-lossless','1');else args.push('-crf',String({high:20,standard:30,small:40}[grade]));
        args.push('-pix_fmt','yuv420p','-c:a','libopus','-b:a',grade==='small'?'96k':'192k');
      }else if(format==='mkv'&&grade==='original'){
        needed=['ffv1',...(audio&&config.keepAudio!==false?['flac']:[])];args.push('-c:v','ffv1','-level','3','-c:a','flac');
      }else{
        needed=['libx264',...(audio&&config.keepAudio!==false?['aac']:[])];args.push('-c:v','libx264','-preset','fast','-crf',String({original:12,high:16,standard:20,small:28}[grade]),'-pix_fmt','yuv420p','-c:a','aac','-b:a',grade==='small'?'128k':grade==='high'?'256k':'192k');
      }
      if(format==='mp4'||format==='mov')args.push('-movflags','+faststart');
    }
  }
  await ensureEncoders(needed,job);args.push(filePath);
  let complete=false;
  try{
    await run('ffmpeg',args,job,{duration,stage:'正在导出 '+format.toUpperCase(),scale:0.9});job.check();
    const checked=await inspect(filePath,job),video=checked.streams?.find(stream=>stream.codec_type==='video'),sound=checked.streams?.find(stream=>stream.codec_type==='audio');
    const byteSize=(await fs.stat(filePath)).size,actualDuration=Number(checked.format?.duration)||Number(video?.duration)||Number(sound?.duration)||duration;
    if(!byteSize||!Number.isFinite(actualDuration)||actualDuration<=0||audioOnly&&!sound||!audioOnly&&(!video||video.width!==shape.width||video.height!==shape.height))throw new Error('导出文件未通过尺寸或媒体检查。');
    const frameCount=video?(Number(video.nb_frames)||Math.max(1,Math.round(actualDuration*(format==='gif'?Math.min(item.fps,grade==='small'?15:30):item.fps)))):undefined;
    complete=true;return{filePath,format,duration:actualDuration,byteSize,hasAudio:Boolean(sound),...(video?{width:video.width,height:video.height,frameCount,isAnimated:frameCount>1}:{})};
  }finally{if(!complete)await fs.rm(filePath,{force:true});}
}
module.exports={Job,Cancelled,run,inspect,probe,normalize,describe,exportClip,tool,quality,maxSide,clipTimes,geometry,inputArgs,visualFilter,saveFile,ensureEncoders,createMedia,mediaFormats};
