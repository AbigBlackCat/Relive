'use strict';
const{test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const{createHash}=require('node:crypto');
const media=require('../core/media.cjs');
const{createWebP,inspectWebP,saveWebP,checkDiskSpace,metadataParser}=require('../core/webp.cjs');
let directory,item,staticItem;
const hash=async file=>createHash('sha256').update(await fs.readFile(file)).digest('hex');
async function work(name){const target=path.join(directory,name);await fs.mkdir(target);return target;}
before(async()=>{
  directory=await fs.mkdtemp(path.join(os.tmpdir(),'Relive-WebP-test-'));
  const preview=path.join(directory,'中文 source with spaces.mp4'),still=path.join(directory,'still.mp4'),job=new media.Job();
  await media.run('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=160x120:rate=60','-t','1.05','-c:v','libx264','-pix_fmt','yuv420p',preview],job);
  await media.run('ffmpeg',['-v','error','-f','lavfi','-i','color=c=red:size=160x120:rate=30','-t','0.3','-c:v','libx264','-pix_fmt','yuv420p',still],job);
  item={...await media.probe(preview,job),previewPath:preview};staticItem={...await media.probe(still,job),previewPath:still};
});
after(async()=>{if(directory)await fs.rm(directory,{recursive:true,force:true});});

test('60 fps trim stays below 30 fps without a short final delay and preserves timing and source',async()=>{
  const original=await hash(item.previewPath),target=await work('中文 动图 trim'),job=new media.Job();
  const result=await createWebP(item,{startFrame:2,endFrame:62,maxSide:1080,coverFrame:-100},target,job);
  assert.equal(result.isAnimated,true);assert.equal(result.frameCount,30);assert.equal(result.duration,1.017);
  assert.equal(result.width,160);assert.equal(result.height,120);assert.ok(result.byteSize>0);
  const info=await inspectWebP(result.filePath,job);assert.equal(info.loopCount,0);assert.equal(info.durationMilliseconds,1017);
  const delays=[];await media.run('webpinfo',['-diag','-summary',path.basename(result.filePath)],job,{cwd:path.dirname(result.filePath),captureStdout:false,onStdoutLine:line=>{const match=/^\s*Duration:\s*(\d+)/.exec(line);if(match)delays.push(Number(match[1]));}});
  assert.equal(delays.length,30);assert.ok(delays.every(delay=>delay>=30));assert.equal(delays.reduce((sum,delay)=>sum+delay,0),1017);
  assert.deepEqual((await fs.readdir(target)),['animation.webp']);assert.equal(await hash(item.previewPath),original);
});

test('59.94 fps 60-frame clip uses 30 balanced delays without a 1 ms tail',async()=>{
  const target=await work('fractional'),preview=path.join(target,'source.mp4'),job=new media.Job();
  await media.run('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=160x120:rate=60000/1001','-frames:v','60','-c:v','libx264','-pix_fmt','yuv420p',preview],job);
  const fractional={...await media.probe(preview,job),previewPath:preview};
  const result=await createWebP(fractional,{startFrame:1,endFrame:60,maxSide:1080},target,job);
  assert.equal(result.frameCount,30);assert.equal(result.duration,1.001);
  const delays=[];await media.run('webpinfo',['-diag','-summary',path.basename(result.filePath)],job,{cwd:path.dirname(result.filePath),captureStdout:false,onStdoutLine:line=>{const match=/^\s*Duration:\s*(\d+)/.exec(line);if(match)delays.push(Number(match[1]));}});
  assert.equal(delays.length,30);assert.ok(delays.every(delay=>delay>=30));assert.equal(delays.reduce((sum,delay)=>sum+delay,0),1001);
});

test('one frame and repeated frames produce valid static WebP with no invented duration',async()=>{
  const job=new media.Job();
  for(const[stem,source,endFrame]of[['single',item,1],['repeated',staticItem,staticItem.frameCount]]){
    const target=await work(stem),result=await createWebP(source,{startFrame:1,endFrame,maxSide:1080},target,job);
    assert.equal(result.isAnimated,false);assert.equal(result.frameCount,1);assert.equal(result.duration,null);
    assert.deepEqual(await fs.readdir(target),['animation.webp']);
  }
});

test('WebP uses selected size cap and reads no cover frame or audio settings',async()=>{
  const target=await work('sizing'),source=path.join(target,'large.mp4'),job=new media.Job();
  await media.run('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:size=1920x1080:rate=30','-frames:v','1','-c:v','libx264',source],job);
  const large={...await media.probe(source,job),previewPath:source};
  const result=await createWebP(large,{startFrame:1,endFrame:1,maxSide:1080,coverFrame:99999,keepAudio:true},target,job);
  assert.equal(result.width,1080);assert.equal(result.height,606);
});

test('exclusive publishing numbers duplicate names and refuses an unusable directory',async()=>{
  const source=path.join(directory,'tiny.webp'),output=await work('中文 导出 with spaces'),job=new media.Job();
  await fs.writeFile(source,'already validated bytes');
  const first=await saveWebP(source,output,'番剧',job),original=await hash(first);
  const second=await saveWebP(source,output,'番剧',job);
  assert.equal(path.basename(first),'番剧.webp');assert.equal(path.basename(second),'番剧 2.webp');assert.equal(await hash(first),original);
  const unavailable=path.join(directory,'not-a-directory');await fs.writeFile(unavailable,'blocked');
  await assert.rejects(saveWebP(source,unavailable,'test',job));
});

test('read-only destination refuses export without leaving a result',{skip:process.platform==='win32'},async()=>{
  const output=await work('read-only'),source=path.join(directory,'tiny.webp');await fs.chmod(output,0o500);
  try{await assert.rejects(saveWebP(source,output,'blocked',new media.Job()),/EACCES|EPERM/);assert.deepEqual(await fs.readdir(output),[]);}
  finally{await fs.chmod(output,0o700);}
});

test('low disk space refuses before extracting frames, and cancellation removes temporary frames and partial files',async()=>{
  const low=await work('low-disk');
  await assert.rejects(createWebP(item,{startFrame:1,endFrame:60},low,new media.Job(),{statfs:async()=>({bavail:1n,bsize:1n})}),/磁盘空间不足/);
  assert.deepEqual(await fs.readdir(low),[]);
  await checkDiskSpace(low,1000n,async()=>({bavail:1000n,bsize:1n}));
  const cancelled=await work('cancelled'),job=new media.Job(value=>{if(value.stage==='正在编码 WebP 动图')job.cancel();});
  await assert.rejects(createWebP(item,{startFrame:1,endFrame:60},cancelled,job),/已取消/);
  assert.deepEqual(await fs.readdir(cancelled),[]);
  const copying=await work('copy-cancelled'),source=path.join(directory,'tiny.webp'),copyJob=new media.Job();let checks=0;
  copyJob.check=()=>{if(++checks===2)copyJob.cancel();media.Job.prototype.check.call(copyJob);};
  await assert.rejects(saveWebP(source,copying,'cancel',copyJob),/已取消/);
  assert.deepEqual(await fs.readdir(copying),[]);
});

test('invalid trims fail early and malformed WebP cannot be published',async()=>{
  const target=await work('invalid'),job=new media.Job();
  for(const[startFrame,endFrame]of[[0,10],[5,4],[1,64],[1.2,3]])await assert.rejects(createWebP(item,{startFrame,endFrame},target,job),/片段|帧号/);
  const malformed=path.join(target,'bad.webp');await fs.writeFile(malformed,'not webp');
  await assert.rejects(inspectWebP(malformed,job));
});

test('metadata parser streams an output larger than the general subprocess capture limit',()=>{
  const parser=metadataParser();parser.line('Chunk VP8X at offset 12, length 18');parser.line('  Canvas size 160 x 120');parser.line('Chunk ANIM at offset 30, length 14');parser.line('  Loop count      : 0');
  for(let i=0;i<30000;i++){
    for(const line of['Chunk ANMF at offset 123456789, length 400000000','  Width: 160','  Height: 120','  Duration: 33','Chunk VP8  at offset 68, length 3976','  Width: 160','  Height: 120','  Format: Lossy (1)'])parser.line(line);
  }
  parser.line('Number of frames: 30000');parser.line('No error detected.');
  const info=parser.finish();assert.equal(info.frameCount,30000);assert.equal(info.durationMilliseconds,990000);assert.equal(info.width,160);assert.equal(info.loopCount,0);
});
