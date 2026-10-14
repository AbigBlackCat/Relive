'use strict';
const{app,BrowserWindow,ipcMain,dialog,shell,session}=require('electron');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const{randomUUID}=require('node:crypto');
const{pathToFileURL}=require('node:url');
const media=require('./core/media.cjs');
const{renderSVG}=require('./core/svg.cjs');
const{writeLivePhoto,validateLivePhoto}=require('./core/live-photo.cjs');

let mainWindow,workspace,activeJob,settings,settingsFile;
const items=new Map(),exportedPaths=new Set(),chosenDirectories=new Set();
const index=path.join(__dirname,'renderer/index.html');
const allowed=new Set(['svg','gif','mov','mp4','mpv','m4v','mkv','webm','avi','mpg','mpeg','wmv','apng','png','jpg','jpeg','heic','heif','webp','bmp','tif','tiff']);
const emit=value=>{if(mainWindow&&!mainWindow.isDestroyed())mainWindow.webContents.send('progress',value);};

function importSettings(value){
  const duration=Number(value?.svgDuration??3);
  if(!Number.isFinite(duration)||duration<1||duration>30)throw new Error('SVG录制时长须为1–30秒。');
  return{svgDuration:duration,background:value?.background==='#000000'?'#000000':'#FFFFFF'};
}
async function job(operation){
  if(activeJob)throw new Error('已有任务正在处理，请等待或取消。');
  const current=new media.Job(emit);activeJob=current;
  try{return await operation(current);}finally{if(activeJob===current)activeJob=null;}
}
async function importPaths(paths,options){
  if(!Array.isArray(paths)||paths.length<1||paths.length>100)throw new Error('请选择1–100个素材。');
  const config=importSettings(options);
  return job(async token=>{
    const imported=[],failures=[];
    for(const original of paths){
      token.check();
      const source=path.resolve(String(original)),extension=path.extname(source).slice(1).toLowerCase();
      if(!allowed.has(extension)){failures.push(path.basename(source)+'：不支持的格式');continue;}
      const id=randomUUID(),directory=path.join(workspace,id);
      try{
        if(!(await fs.stat(source)).isFile())throw new Error('请选择文件');
        await fs.mkdir(directory);
        const input=path.join(directory,'input.'+extension),preview=path.join(directory,'preview.mp4');
        await fs.copyFile(source,input);token.check();
        emit({stage:'正在读取 '+path.basename(source),progress:0});
        if(extension==='svg')await renderSVG(input,preview,config,token);else await media.normalize(input,preview,config,token);
        emit({stage:'正在生成帧预览',progress:0.9});
        const item=await media.describe(preview,source,id,directory,token);
        items.set(id,{...item,previewPath:preview});imported.push(item);
      }catch(error){await fs.rm(directory,{recursive:true,force:true});if(token.cancelled)throw error;failures.push(path.basename(source)+'：'+error.message);}
    }
    if(!imported.length)throw new Error(failures.join('\n')||'未导入素材');
    if(failures.length)emit({stage:'已导入部分素材；'+failures.join('；'),progress:1});else emit({stage:'素材已准备完成',progress:1});
    return imported;
  });
}
function safeName(text){const name=String(text).replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/g,'').slice(0,90)||'Relive';return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)?'Relive_'+name:name;}
async function exportItem(config){
  const item=items.get(config?.id);if(!item)throw new Error('请选择已导入的素材。');
  if(typeof config.outputDir!=='string')throw new Error('请选择导出文件夹。');
  const output=path.resolve(config.outputDir);
  if(!chosenDirectories.has(output))throw new Error('请从操作台选择导出文件夹。');
  return job(async token=>{
    const directory=path.join(workspace,'export-'+randomUUID());await fs.mkdir(directory);
    let temporary;
    try{
      const prepared=await media.exportClip(item,config,directory,token);
      emit({stage:'正在写入实况封面和时间标记',progress:0.8});
      const result=await writeLivePhoto({jpegPath:prepared.jpeg,movPath:prepared.movie,outputDir:directory,name:'LivePhoto',coverTime:prepared.coverTime,fps:prepared.fps});
      token.check();await validateLivePhoto({packagePath:result.packagePath});
      await fs.mkdir(output,{recursive:true});
      let name=safeName(item.name),destination=path.join(output,name+'.pvt'),number=2;
      while(await fs.stat(destination).then(()=>true,()=>false)){destination=path.join(output,name+' '+number+'.pvt');number++;}
      temporary=path.join(output,'.Relive-'+randomUUID()+'.pvt');await fs.cp(result.packagePath,temporary,{recursive:true,errorOnExist:true,force:false});token.check();
      // Claim a new empty destination before moving files so even concurrent exporters cannot overwrite a package.
      await fs.mkdir(destination);
      try{
        for(const filename of await fs.readdir(temporary))await fs.rename(path.join(temporary,filename),path.join(destination,filename));
        await fs.rmdir(temporary);temporary=null;
      }catch(error){await fs.rm(destination,{recursive:true,force:true});throw error;}
      const finished={...result,packagePath:destination,imagePath:path.join(destination,'LivePhoto.jpg'),moviePath:path.join(destination,'LivePhoto.mov')};
      exportedPaths.add(destination);emit({stage:'Live Photo 已导出 · 已通过配对与时间标记检查',progress:1});return finished;
    }finally{if(temporary)await fs.rm(temporary,{recursive:true,force:true});await fs.rm(directory,{recursive:true,force:true});}
  });
}
function register(name,handler){ipcMain.handle(name,(event,...args)=>{
  if(!mainWindow||event.sender!==mainWindow.webContents||event.senderFrame?.url!==pathToFileURL(index).href)throw new Error('不受信任的操作来源');
  return handler(...args);
});}
async function initialize(){
  workspace=await fs.mkdtemp(path.join(os.tmpdir(),'Relive-'));
  settingsFile=path.join(app.getPath('userData'),'settings.json');
  settings={outputDir:path.join(app.getPath('pictures'),'Relive 导出'),svgDuration:3,background:'#FFFFFF',maxSide:1080,keepAudio:true};
  try{const stored=JSON.parse(await fs.readFile(settingsFile,'utf8'));if(typeof stored.outputDir==='string')settings.outputDir=path.resolve(stored.outputDir);}catch{}
  chosenDirectories.add(path.resolve(settings.outputDir));
  session.defaultSession.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  mainWindow=new BrowserWindow({width:1360,height:860,minWidth:1100,minHeight:720,title:'Relive',backgroundColor:'#08090b',autoHideMenuBar:true,show:!process.argv.includes('--smoke-test'),webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
  mainWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  mainWindow.webContents.on('will-navigate',event=>event.preventDefault());
  register('settings',()=>({...settings}));
  register('pick-files',async options=>{const selected=await dialog.showOpenDialog(mainWindow,{title:'导入素材',properties:['openFile','multiSelections'],filters:[{name:'视频、GIF、SVG 与图片',extensions:[...allowed]}]});return selected.canceled?[]:importPaths(selected.filePaths,options);});
  register('import-dropped',options=>importPaths(options?.paths,options));
  register('choose-directory',async()=>{const selected=await dialog.showOpenDialog(mainWindow,{title:'选择 Live Photo 导出位置',defaultPath:settings.outputDir,properties:['openDirectory','createDirectory']});if(selected.canceled)return null;settings.outputDir=path.resolve(selected.filePaths[0]);chosenDirectories.add(settings.outputDir);await fs.mkdir(path.dirname(settingsFile),{recursive:true});await fs.writeFile(settingsFile,JSON.stringify(settings));return settings.outputDir;});
  register('export-live-photo',exportItem);
  register('reveal',target=>{if(!exportedPaths.has(target))throw new Error('请选择本次导出的文件');shell.showItemInFolder(target);});
  register('open-result',async target=>{if(!exportedPaths.has(target))throw new Error('请选择本次导出的文件');const failure=await shell.openPath(target);if(failure)throw new Error(failure);});
  ipcMain.on('cancel',event=>{if(event.sender===mainWindow.webContents)activeJob?.cancel();});
  await mainWindow.loadFile(index);
  return{workspace,importPaths,exportItem,items,chosenDirectories,mainWindow};
}

app.whenReady().then(async()=>{
  try{
    const api=await initialize();
    if(process.argv.includes('--smoke-test')){await require('./smoke.cjs').run(api);console.log('RELIVE_DESKTOP_SMOKE_PASS');app.exit(0);}
  }catch(error){console.error(error);if(process.argv.includes('--smoke-test'))app.exit(1);else dialog.showErrorBox('Relive 无法启动',error.message);}
});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',()=>activeJob?.cancel());
app.on('will-quit',()=>{if(workspace)require('node:fs').rmSync(workspace,{recursive:true,force:true});});
