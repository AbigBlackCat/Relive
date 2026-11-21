'use strict';
const{test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const{createHash}=require('node:crypto');
const media=require('../core/media.cjs');
const{createWebP,inspectWebP}=require('../core/webp.cjs');
let directory,item,silent;
const hash=async file=>createHash('sha256').update(await fs.readFile(file)).digest('hex');
async function work(name){const target=path.join(directory,name);await fs.mkdir(target);return target;}
const base={startFrame:1,endFrame:30,maxSide:0,quality:'standard',crop:{x:.5,y:0,width:.5,height:1}};
before(async()=>{
  directory=await fs.mkdtemp(path.join(os.tmpdir(),'Relive-media-test-'));
  const source=path.join(directory,'中文 original source.mov'),preview=path.join(directory,'preview.mp4');
  await media.run('ffmpeg',['-v','error','-f','lavfi','-i','color=c=red:size=320x240:rate=30','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','1.2','-vf','drawbox=x=160:y=0:w=160:h=240:color=blue:t=fill','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',source],new media.Job());
  await media.run('ffmpeg',['-v','error','-i',source,'-vf','scale=160:120','-c:v','libx264','-c:a','aac',preview],new media.Job());
  item={...await media.probe(preview,new media.Job()),previewPath:preview,sourcePath:source,sourceWidth:320,sourceHeight:240};
  const silentPath=path.join(directory,'silent.mp4');await media.run('ffmpeg',['-v','error','-i',source,'-an','-c:v','copy',silentPath],new media.Job());
  silent={...item,sourcePath:silentPath,hasAudio:false};
});
after(async()=>{if(directory)await fs.rm(directory,{recursive:true,force:true});});

test('MP4/MOV/MKV/WebM/GIF encode the original source crop with correct audio behavior',async()=>{
  const sourceHash=await hash(item.sourcePath);
  for(const format of['mp4','mov','mkv','webm','gif']){
    const target=await work(format),job=new media.Job();
    const result=await media.createMedia(item,{...base,format},target,job);
    assert.equal(result.width,160);assert.equal(result.height,240);assert.equal(result.format,format);assert.equal(result.hasAudio,format!=='gif');assert.ok(result.byteSize>0);assert.ok(Math.abs(result.duration-1)<.1);
    const pixels=path.join(target,'first.rgb');await media.run('ffmpeg',['-v','error','-i',result.filePath,'-frames:v','1','-vf','scale=1:1','-pix_fmt','rgb24','-f','rawvideo',pixels],job);
    const color=await fs.readFile(pixels);assert.ok(color[2]>200&&color[0]<40&&color[1]<40,format+' must crop blue right half of original, not use the reduced preview');
  }
  assert.equal(await hash(item.sourcePath),sourceHash);
});

test('MP3/WAV export sound, ignore spatial crop and clearly refuse silent input',async()=>{
  for(const format of['mp3','wav']){
    const target=await work(format),job=new media.Job();
    const result=await media.createMedia(item,{...base,format,crop:{invalid:true},quality:'original'},target,job);
    assert.equal(result.hasAudio,true);assert.equal(result.width,undefined);assert.ok(result.duration>=1&&result.duration<1.1);
    const metadata=await media.inspect(result.filePath,job);assert.equal(metadata.streams[0].codec_name,format==='mp3'?'mp3':'pcm_s24le');
    await assert.rejects(media.createMedia(silent,{...base,format},target,job),/没有声音/);
  }
});

test('original size bypasses the 1920 preview cap, 720 caps cropped longest edge, and small sources never upscale',async()=>{
  const target=await work('original-size'),source=path.join(target,'large.mp4'),job=new media.Job();
  await media.run('ffmpeg',['-v','error','-f','lavfi','-i','color=c=green:size=2160x1200:rate=30','-frames:v','2','-c:v','libx264',source],job);
  const large={...item,sourcePath:source,sourceWidth:2160,sourceHeight:1200,frameCount:2,hasAudio:false};
  const original=await media.createMedia(large,{startFrame:1,endFrame:2,maxSide:0,quality:'original',format:'mp4'},target,job);
  assert.equal(original.width,2160);assert.equal(original.height,1200);
  const cap=await media.createMedia(large,{startFrame:1,endFrame:2,maxSide:720,quality:'small',format:'mov'},target,job);
  assert.equal(cap.width,720);assert.equal(cap.height,400);
  const small=await media.createMedia(item,{startFrame:1,endFrame:1,maxSide:1920,quality:'high',format:'mkv'},target,job);
  assert.equal(small.width,320);assert.equal(small.height,240);
});

test('WebP/Live Photo share source resolution, crop, quality and cover crop alignment',async()=>{
  const webpFolder=await work('webp-source'),job=new media.Job();
  const webp=await createWebP(item,{...base,quality:'original'},webpFolder,job);
  assert.equal(webp.width,160);assert.equal(webp.height,240);await inspectWebP(webp.filePath,job);
  assert.ok((await fs.readFile(webp.filePath)).includes(Buffer.from('VP8L')),'original WebP must use lossless coding');
  const photoFolder=await work('live-source'),photo=await media.exportClip(item,{...base,coverFrame:16,keepAudio:true,quality:'original'},photoFolder,job);
  const movie=await media.probe(photo.movie,job),cover=await media.probe(photo.jpeg,job);
  assert.equal(movie.width,160);assert.equal(movie.height,240);assert.equal(cover.width,160);assert.equal(cover.height,240);assert.equal(movie.hasAudio,true);assert.equal(photo.coverTime,.5);
});

test('transparent still sources export bounded GIF and WebP loops with the chosen background',{timeout:15000},async()=>{
  const target=await work('transparent-still'),source=path.join(target,'alpha.png'),job=new media.Job();
  await media.run('ffmpeg',['-v','error','-f','lavfi','-i','color=c=red@0.0:size=32x32,format=rgba','-frames:v','1',source],job);
  const still={...item,sourcePath:source,sourceWidth:32,sourceHeight:32,sourceIsStill:true,sourceHasAlpha:true,background:'#000000',frameCount:9,duration:.3,hasAudio:false};
  const gif=await media.createMedia(still,{startFrame:1,endFrame:9,maxSide:0,quality:'small',format:'gif'},target,job);assert.equal(gif.width,32);assert.ok(gif.duration>0&&gif.duration<.5);assert.equal(gif.hasAudio,false);
  const webp=await createWebP(still,{startFrame:1,endFrame:9,maxSide:0,quality:'original'},target,job);
  const pixels=path.join(target,'black.rgb');await media.run('ffmpeg',['-v','error','-i',webp.filePath,'-frames:v','1','-vf','scale=1:1','-pix_fmt','rgb24','-f','rawvideo',pixels],job);
  assert.ok((await fs.readFile(pixels)).every(value=>value<10));
});

test('MKV original selects lossless codecs; mute and validation errors are explicit',async()=>{
  const target=await work('quality'),job=new media.Job();
  const result=await media.createMedia(item,{...base,format:'mkv',quality:'original'},target,job),metadata=await media.inspect(result.filePath,job);
  assert.equal(metadata.streams.find(stream=>stream.codec_type==='video').codec_name,'ffv1');assert.equal(metadata.streams.find(stream=>stream.codec_type==='audio').codec_name,'flac');
  const muted=await media.createMedia(item,{...base,format:'mp4',keepAudio:false},target,job);assert.equal(muted.hasAudio,false);
  for(const crop of[{x:-.1,y:0,width:1,height:1},{x:.8,y:0,width:.5,height:1},{x:0,y:0,width:0,height:1},{x:NaN,y:0,width:1,height:1}])await assert.rejects(media.createMedia(item,{...base,format:'mov',crop},target,job),/裁切/);
  for(const config of[{format:'bad'},{format:'mp4',quality:'unknown'},{format:'mp4',maxSide:1440}])await assert.rejects(media.createMedia(item,{...base,...config},target,job));
});

test('cancelled generic encoding removes partial output and preserves input',async()=>{
  const target=await work('cancel'),sourceHash=await hash(item.sourcePath),job=new media.Job(value=>{if(value.stage==='正在导出 MP4'&&value.progress>0)job.cancel();});
  await assert.rejects(media.createMedia(item,{...base,format:'mp4'},target,job),/已取消/);
  assert.deepEqual(await fs.readdir(target),[]);assert.equal(await hash(item.sourcePath),sourceHash);
});
