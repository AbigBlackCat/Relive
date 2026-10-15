'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
const media=require('./core/media.cjs');
const{validateLivePhoto}=require('./core/live-photo.cjs');
const{inspectWebP}=require('./core/webp.cjs');
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
    const webp=await api.exportWebP({id:item.id,startFrame:1,endFrame:item.frameCount,maxSide:1080,outputDir:output,coverFrame:-1});
    const webpInfo=await inspectWebP(webp.filePath,job);
    assert.equal(webp.isAnimated,true);assert.equal(webpInfo.loopCount,0);
    assert.ok(Math.abs(webp.duration-item.duration)<=0.001);
    console.log('PASS desktop '+item.kind+' → animated WebP, original duration');
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
  await assert.rejects(api.exportWebP({id:'unknown',startFrame:1,endFrame:1,outputDir:output}),/素材/);
  await assert.rejects(api.exportWebP({id:first.id,startFrame:1,endFrame:1,outputDir:fixtures}),/操作台/);
  const staticWebP=await api.exportWebP({id:first.id,startFrame:3,endFrame:3,outputDir:output});
  assert.equal(staticWebP.isAnimated,false);assert.equal(staticWebP.duration,null);
  assert.match(path.basename(staticWebP.filePath),/ 2\.webp$/);
  console.log('PASS WebP authorization, static frame, duplicate numbering');
  const colorSource=path.join(fixtures,'中文 色彩 source with spaces.mp4');
  await media.run('ffmpeg',['-v','error','-f','lavfi','-i','color=c=red:size=160x120:rate=60:duration=0.5','-f','lavfi','-i','color=c=lime:size=160x120:rate=60:duration=0.5','-f','lavfi','-i','color=c=blue:size=160x120:rate=60:duration=0.5','-filter_complex','[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]','-map','[v]','-c:v','libx264','-pix_fmt','yuv420p',colorSource],job);
  const colorItem=(await api.importPaths([colorSource],{svgDuration:1,background:'#FFFFFF'}))[0];
  assert.equal(colorItem.fps,60);assert.equal(colorItem.frameCount,90);
  const displayed=await api.mainWindow.webContents.executeJavaScript(`(async()=>{
    state.items.push(${JSON.stringify(colorItem)});selectItem(${JSON.stringify(colorItem.id)});updateDirectory(${JSON.stringify(output)});
    const format=document.getElementById('export-format');format.value='webp';format.dispatchEvent(new Event('change'));
    const start=document.getElementById('start-frame'),end=document.getElementById('end-frame');start.value='16';end.value='75';start.dispatchEvent(new Event('input'));end.dispatchEvent(new Event('input'));
    const before={coverHidden:document.getElementById('cover-settings').hidden,audioHidden:document.getElementById('audio-setting').hidden,markHidden:document.getElementById('mark-cover').hidden,openHidden:document.getElementById('open-result').hidden,enabled:!document.getElementById('export-button').disabled,oldCover:state.coverFrame};
    await exportMedia();return{before,result:state.result,details:document.getElementById('result-details').textContent,error:document.getElementById('error-message').textContent};
  })()`);
  assert.deepEqual(displayed.before,{coverHidden:true,audioHidden:true,markHidden:true,openHidden:true,enabled:true,oldCover:1});
  assert.ok(displayed.result,displayed.error);assert.equal(displayed.result.duration,1);assert.equal(displayed.result.frameCount,3);
  assert.match(displayed.details,/160 × 120/);assert.match(displayed.details,/1 秒/);assert.match(displayed.details,/B/);
  const encoded=(await fs.readFile(displayed.result.filePath)).toString('base64');
  const colors=await api.mainWindow.webContents.executeJavaScript(`(async()=>{
    const data=Uint8Array.from(atob(${JSON.stringify(encoded)}),character=>character.charCodeAt(0));
    const decoder=new ImageDecoder({data,type:'image/webp'});await decoder.tracks.ready;const colors=[];
    for(let index=0;index<decoder.tracks.selectedTrack.frameCount;index++){
      const frame=(await decoder.decode({frameIndex:index})).image;const pixels=new Uint8Array(frame.allocationSize({format:'RGBA'}));
      await frame.copyTo(pixels,{format:'RGBA'});const middle=(Math.floor(frame.displayHeight/2)*frame.displayWidth+Math.floor(frame.displayWidth/2))*4;
      colors.push(Array.from(pixels.slice(middle,middle+3)));frame.close();
    }
    decoder.close();return colors;
  })()`);
  assert.equal(colors.length,3);
  for(const[index,channel]of[[0,0],[1,1],[2,2]]){assert.ok(colors[index][channel]>200);for(let other=0;other<3;other++)if(other!==channel)assert.ok(colors[index][other]<40);}
  const switched=await api.mainWindow.webContents.executeJavaScript(`(()=>{const format=document.getElementById('export-format');format.value='livePhoto';format.dispatchEvent(new Event('change'));return{result:state.result,hidden:document.getElementById('export-result').hidden,coverVisible:!document.getElementById('cover-settings').hidden};})()`);
  assert.deepEqual(switched,{result:null,hidden:true,coverVisible:true});
  console.log('PASS renderer WebP IPC, hidden cover ignored, 60→30 fps cropped red/green/blue playback order, format clears result');
}
module.exports={run};
