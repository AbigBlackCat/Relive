'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const{constants}=require('node:fs');
const media=require('./media.cjs');

function exportGeometry(item,config){
  const{startFrame,endFrame}=config;
  if(![startFrame,endFrame].every(Number.isSafeInteger))throw new Error('请输入整数帧号。');
  if(!(1<=startFrame&&startFrame<=endFrame&&endFrame<=item.frameCount))throw new Error('请选择有效的导出片段。');
  if(!(Number.isFinite(item.fps)&&item.fps>0&&item.fps<=60&&item.width>0&&item.height>0))throw new Error('素材尺寸或帧率不正确。');
  const side=config.maxSide===1920?1920:1080,ratio=Math.min(1,side/Math.max(item.width,item.height));
  const width=Math.max(2,Math.floor(item.width*ratio/2)*2),height=Math.max(2,Math.floor(item.height*ratio/2)*2);
  const sourceFrames=endFrame-startFrame+1,duration=sourceFrames/item.fps;
  const frameCount=Math.max(1,Math.floor(duration*Math.min(30,item.fps)+1e-7)),totalMilliseconds=Math.round(duration*1000);
  const fps=frameCount/duration,samplingRatio=sourceFrames/frameCount;
  if(!Number.isSafeInteger(frameCount)||!Number.isSafeInteger(totalMilliseconds)||totalMilliseconds<1)throw new Error('导出片段时长不正确。');
  return{width,height,duration,fps,frameCount,totalMilliseconds,samplingRatio};
}
function frameDelays(geometry){
  const result=[];let previous=0;
  for(let i=1;i<=geometry.frameCount;i++){
    const next=i===geometry.frameCount?geometry.totalMilliseconds:Math.round(i*geometry.duration/geometry.frameCount*1000);
    const delay=next-previous;
    if(delay<1||delay>0xffffff)throw new Error('WebP 帧时长超出支持范围。');
    result.push(delay);previous=next;
  }
  return result;
}
async function checkDiskSpace(directory,required,statfs=fs.statfs){
  const space=await statfs(directory,{bigint:true});
  const available=BigInt(space.bavail)*BigInt(space.bsize);
  if(available<BigInt(required))throw new Error('临时磁盘空间不足：本次导出至少需要 '+(Number(required)/1024**3).toFixed(2)+' GB 可用空间。请释放空间后重试。');
}
function metadataParser(){
  const data={width:null,height:null,frameCount:null,isAnimated:false,durationMilliseconds:0,loopCount:null};
  let currentChunk='',inAnimationFrame=false,frameChunks=0,staticWidth=null,staticHeight=null,successful=false;
  return{
    line(line){
      let match;
      if((match=/^Chunk (\S+)\s+at offset/.exec(line))){currentChunk=match[1];inAnimationFrame=currentChunk==='ANMF';if(inAnimationFrame)frameChunks++;}
      else if((match=/^\s*Canvas size (\d+) x (\d+)/.exec(line))){data.width=Number(match[1]);data.height=Number(match[2]);}
      else if((match=/^\s*Loop count\s*:\s*(\d+)/.exec(line)))data.loopCount=Number(match[1]);
      else if(inAnimationFrame&&(match=/^\s*Duration:\s*(\d+)/.exec(line)))data.durationMilliseconds+=Number(match[1]);
      else if((currentChunk==='VP8'||currentChunk==='VP8L')&&!data.width&&(match=/^\s*Width:\s*(\d+)/.exec(line)))staticWidth=Number(match[1]);
      else if((currentChunk==='VP8'||currentChunk==='VP8L')&&!data.height&&(match=/^\s*Height:\s*(\d+)/.exec(line)))staticHeight=Number(match[1]);
      else if((match=/^Number of frames:\s*(\d+)/.exec(line)))data.frameCount=Number(match[1]);
      if(line.trim()==='No error detected.')successful=true;
    },
    finish(){
      data.width??=staticWidth;data.height??=staticHeight;data.isAnimated=frameChunks>0;
      // libwebp reports zero ANMF frames for a valid static image.
      if(!data.isAnimated&&data.frameCount===0)data.frameCount=1;
      if(!successful||!(data.width>0&&data.height>0&&data.frameCount>0)||data.isAnimated&&data.frameCount!==frameChunks)throw new Error('WebP 文件未通过结构检查。');
      return data;
    }
  };
}
async function inspectWebP(filename,job){
  const parser=metadataParser();
  await media.run('webpinfo',['-diag','-summary',path.basename(filename)],job,{cwd:path.dirname(filename),captureStdout:false,onStdoutLine:line=>parser.line(line)});
  const metadata=parser.finish();
  return{...metadata,byteSize:(await fs.stat(filename)).size};
}
async function createWebP(item,config,directory,job,{statfs=fs.statfs}={}){
  const geometry=exportGeometry(item,config),frames=path.join(directory,'webp-frames'),filename=path.join(directory,'animation.webp');
  // PPM is uncompressed, so the estimate does not depend on source compressibility.
  const required=BigInt(geometry.frameCount)*(BigInt(geometry.width)*BigInt(geometry.height)*3n+128n)+192n*1024n*1024n;
  await checkDiskSpace(directory,required,statfs);job.check();
  await fs.mkdir(frames);let complete=false;
  try{
    const selection=geometry.samplingRatio>1?`,select='gte(n,floor(selected_n*${geometry.samplingRatio}+0.0000001))'`:'';
    const filter=`trim=start_frame=${config.startFrame-1}:end_frame=${config.endFrame}${selection},setpts=N/(${geometry.fps}*TB),scale=${geometry.width}:${geometry.height},setsar=1`;
    job.progress({stage:'正在提取 WebP 动图画面',progress:0});
    await media.run('ffmpeg',['-v','error','-nostdin','-nostats','-progress','pipe:1','-i',item.previewPath,'-map','0:v:0','-an','-vf',filter,'-fps_mode','vfr','-c:v','ppm','-f','image2',path.join(frames,'frame-%09d.ppm')],job,{duration:geometry.duration,stage:'正在提取 WebP 动图画面',scale:0.55});
    const files=(await fs.readdir(frames)).filter(name=>/^frame-\d{9}\.ppm$/.test(name)).sort();
    if(files.length!==geometry.frameCount)throw new Error('提取画面数量与导出片段不一致，请重新导入素材。');
    const delays=frameDelays(geometry),argumentsFile=path.join(frames,'arguments.txt');
    const argumentsText=['-loop 0 -lossy -q 80 -m 4',...files.map((name,i)=>'-d '+delays[i]+' '+name),'-o ../animation.webp'].join('\n');
    await fs.writeFile(argumentsFile,argumentsText,'ascii');job.check();
    job.progress({stage:'正在编码 WebP 动图',progress:0.6});
    await media.run('img2webp',['arguments.txt'],job,{cwd:frames,captureStdout:false});job.check();
    job.progress({stage:'正在检查 WebP 文件',progress:0.92});
    const checked=await inspectWebP(filename,job);job.check();
    if(checked.width!==geometry.width||checked.height!==geometry.height||checked.isAnimated&&(checked.loopCount!==0||checked.durationMilliseconds!==geometry.totalMilliseconds||checked.frameCount>geometry.frameCount))throw new Error('WebP 尺寸、循环或时长检查未通过。');
    complete=true;
    return{filePath:filename,width:checked.width,height:checked.height,frameCount:checked.frameCount,duration:checked.isAnimated?checked.durationMilliseconds/1000:null,byteSize:checked.byteSize,isAnimated:checked.isAnimated};
  }finally{await fs.rm(frames,{recursive:true,force:true});if(!complete)await fs.rm(filename,{force:true});}
}
async function saveWebP(source,output,stem,job){
  if(!stem||path.basename(stem)!==stem)throw new Error('导出文件名不正确。');
  await fs.mkdir(output,{recursive:true});await fs.access(output,constants.W_OK);
  let number=1,destination,writer;
  while(!writer){
    job.check();destination=path.join(output,stem+(number===1?'':' '+number)+'.webp');
    try{writer=await fs.open(destination,'wx');}catch(error){if(error.code==='EEXIST'){number++;continue;}throw error;}
  }
  let reader,complete=false;
  try{
    reader=await fs.open(source,'r');const buffer=Buffer.allocUnsafe(1024*1024);
    while(true){
      job.check();const{bytesRead}=await reader.read(buffer,0,buffer.length,null);if(!bytesRead)break;
      let written=0;while(written<bytesRead){job.check();const amount=(await writer.write(buffer,written,bytesRead-written,null)).bytesWritten;if(amount<1)throw new Error('无法写入导出文件。');written+=amount;}
    }
    await reader.close();reader=null;await writer.close();writer=null;job.check();complete=true;return destination;
  }finally{
    await reader?.close();await writer?.close();
    if(!complete)await fs.rm(destination,{force:true});
  }
}
module.exports={createWebP,inspectWebP,saveWebP,exportGeometry,frameDelays,checkDiskSpace,metadataParser};
