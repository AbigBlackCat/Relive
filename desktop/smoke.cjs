'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
const media=require('./core/media.cjs');
const{validateLivePhoto}=require('./core/live-photo.cjs');
const{createHash}=require('node:crypto');

async function run(api){
  const bridgeSettings=await api.mainWindow.webContents.executeJavaScript('window.relive.getSettings()');
  assert.equal(typeof bridgeSettings.outputDir,'string');
  console.log('PASS packaged renderer IPC bridge');
  const fixtures=path.join(api.workspace,'fixtures'),output=path.join(api.workspace,'exports');
  await fs.mkdir(fixtures);await fs.mkdir(output);api.chosenDirectories.add(output);
  const job=new media.Job();
  const source=path.join(fixtures,'source.mov');
  await media.run('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=320x240:rate=30','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','1.2','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',source],job);
  const gif=path.join(fixtures,'animation.gif'),mpv=path.join(fixtures,'raw.mpv'),svg=path.join(fixtures,'animation.svg');
  await media.run('ffmpeg',['-v','error','-i',source,'-vf','fps=12,scale=160:120',gif],job);
  await media.run('ffmpeg',['-v','error','-i',source,'-an','-c:v','mpeg2video','-f','mpeg2video',mpv],job);
  await fs.writeFile(svg,'<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="#eee9de"/><circle cy="120" r="32" fill="#34b27b"><animate attributeName="cx" values="50;270;50" dur="1s" repeatCount="indefinite"/></circle><style>@keyframes fade{from{opacity:1}to{opacity:.2}}.x{animation:fade 1s infinite}</style><rect class="x" x="100" y="20" width="50" height="40" fill="red"/></svg>');
  const original=createHash('sha256').update(await fs.readFile(source)).digest('hex');
  const imported=await api.importPaths([source,gif,mpv,svg],{svgDuration:1,background:'#FFFFFF'});
  assert.equal(imported.length,4);assert.equal(imported[0].frameCount,36);
  for(const item of imported){
    assert.equal(item.thumbnails.length,10);
    const result=await api.exportItem({id:item.id,coverFrame:Math.min(14,item.frameCount),startFrame:1,endFrame:item.frameCount,maxSide:1080,keepAudio:true,outputDir:output});
    const checked=await validateLivePhoto(result);
    assert.ok(Math.abs(checked.coverTime-(Math.min(14,item.frameCount)-1)/item.fps)<1/60000);
    console.log('PASS desktop '+item.kind+' → Live Photo, selected cover, preview');
  }
  const first=imported[0];
  const result=await api.exportItem({id:first.id,coverFrame:16,startFrame:16,endFrame:16,maxSide:1080,keepAudio:false,outputDir:output});
  assert.equal((await validateLivePhoto(result)).coverTime,0);
  assert.equal((await media.probe(result.moviePath,job)).hasAudio,false);
  console.log('PASS one-frame trim, mute, no overwrite');
  assert.equal(createHash('sha256').update(await fs.readFile(source)).digest('hex'),original);
  const svgItem=imported[3],master=api.items.get(svgItem.id).previewPath;
  const a=path.join(fixtures,'a.rgb'),b=path.join(fixtures,'b.rgb');
  for(const[time,destination]of[[0,a],[0.5,b]])await media.run('ffmpeg',['-v','error','-ss',String(time),'-i',master,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24',destination],job);
  assert.notDeepEqual(await fs.readFile(a),await fs.readFile(b));
  console.log('PASS deterministic SVG animation');
  await assert.rejects(api.exportItem({id:first.id,coverFrame:1,startFrame:2,endFrame:10,maxSide:1080,keepAudio:true,outputDir:output}),/封面/);
  console.log('PASS invalid cover rejected');
}
module.exports={run};
