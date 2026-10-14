'use strict';
const{contextBridge,ipcRenderer,webUtils}=require('electron');
contextBridge.exposeInMainWorld('relive',{
  getSettings:()=>ipcRenderer.invoke('settings'),
  pickFiles:settings=>ipcRenderer.invoke('pick-files',settings),
  importDropped:settings=>ipcRenderer.invoke('import-dropped',settings),
  chooseDirectory:()=>ipcRenderer.invoke('choose-directory'),
  exportLivePhoto:settings=>ipcRenderer.invoke('export-live-photo',settings),
  reveal:target=>ipcRenderer.invoke('reveal',target),
  openResult:target=>ipcRenderer.invoke('open-result',target),
  cancel:()=>ipcRenderer.send('cancel'),
  pathForFile:file=>webUtils.getPathForFile(file),
  onProgress:callback=>{const listener=(_event,value)=>callback(value);ipcRenderer.on('progress',listener);return()=>ipcRenderer.removeListener('progress',listener);}
});
