import type { TFunction } from 'i18next'
import { officeFailureLabels } from './failure'
import { isOfficeFrameToken } from './transport'
import zetaSource from 'zetajs/zeta.js?raw'

import localFontsSource from './local-fonts.js?raw'
import fontCacheSource from './fontcache.js?raw'
import { OFFICE_FONT_CACHE_ENTRIES } from '../../../../../fonts'
import localeSource from './locale.js?raw'
import paletteSource from './palette.js?raw'
import clipboardSource from './clipboard.js?raw'
import autoscrollSource from './autoscroll.js?raw'
import docSource from './doc.js?raw'
import docxSource from './docx.js?raw'
import selectionSource from './selection.js?raw'
import officeThreadSource from './office-thread.js?raw'
import policySource from './policy.js?raw'
import governanceSource from './governance.js?raw'
import protectionSource from './protection.js?raw'
import searchSource from './search.js?raw'
import embeddedSource from './embedded.js?raw'
import caretSource from './caret.js?raw'

export const ZETAOFFICE_BUILD_DIRECTORY = 'zeta-20250513'
export const ZETAOFFICE_DEFAULT_FONT_PATH = 'fonts/NotoSansCJKsc-Regular.otf'
export const ZETAOFFICE_ASSETS_BASE_URL = new URL(
  `/office/${ZETAOFFICE_BUILD_DIRECTORY}/`,
  window.location.origin
).href
export const ZETAOFFICE_DEFAULT_FONTS = [
  {
    family: 'Noto Sans CJK SC',
    filename: 'NotoSansCJKsc-Regular.otf',
    url: new URL(`/${ZETAOFFICE_DEFAULT_FONT_PATH}`, window.location.origin).href,
  },
] as const

export interface OfficeFrameDocument {
  html: string
  token: string
  dispose: () => void
}

function sourceUrl(source: string): string {
  return URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
}

export function officeFrameDocument(
  t: TFunction<'workbench'>,
  locale: string,
  token: string = crypto.randomUUID()
): OfficeFrameDocument {
  if (!isOfficeFrameToken(token)) throw new Error('Invalid Office frame token')
  const zetaUrl = sourceUrl(zetaSource)
  const docUrl = sourceUrl(docSource)
  const docxUrl = sourceUrl(docxSource)
  const selectionUrl = sourceUrl(selectionSource)
  const threadUrl = sourceUrl(officeThreadSource)
  const policyUrl = sourceUrl(policySource)
  const governanceUrl = sourceUrl(governanceSource)
  const protectionUrl = sourceUrl(protectionSource)
  const searchUrl = sourceUrl(searchSource)
  const embeddedUrl = sourceUrl(embeddedSource)
  const caretUrl = sourceUrl(caretSource)
  const localFontsUrl = sourceUrl(localFontsSource)
  const fontCacheUrl = sourceUrl(fontCacheSource)
  const localeUrl = sourceUrl(localeSource)
  const paletteUrl = sourceUrl(paletteSource)
  const clipboardUrl = sourceUrl(clipboardSource)
  const autoscrollUrl = sourceUrl(autoscrollSource)
  const config = JSON.stringify({
    locale,
    errors: officeFailureLabels(t),
    text: {
      starting: t('officeFrame.starting'),
      reload: t('officeFrame.reload'),
      runtimeError: t('officeFrame.runtimeError'),
      startFailed: t('officeFrame.startFailed'),
      prepareFonts: t('officeFrame.prepareFonts'),
      fontsUnsupported: t('officeFrame.fontsUnsupported'),
      fontsEmpty: t('officeFrame.fontsEmpty'),
      loading: t('officeFrame.loading'),
      assetsFailed: t('officeFrame.assetsFailed'),
      initializing: t('officeFrame.initializing'),
      editable: t('officeFrame.editable'),
      readonly: t('officeFrame.readonly'),
      pasteFailed: t('officeFrame.pasteFailed'),
      permission: t('officeFrame.permission'),
      isolation: t('officeFrame.isolation'),
      readingFonts: t('officeFrame.readingFonts', { done: '{{done}}', total: '{{total}}' }),
      loadingFonts: t('officeFrame.loadingFonts', { fontTotal: '{{fontTotal}}', size: '{{size}}' }),
      imageFailed: t('officeFrame.imageFailed'),
      operationFailed: t('officeError.operationFailed'),
      undoPolish: t('officeDocument.undoPolish'),
      undoInsertImage: t('officeDocument.undoInsertImage'),
    },
    assetsBaseUrl: ZETAOFFICE_ASSETS_BASE_URL,
    defaultFonts: ZETAOFFICE_DEFAULT_FONTS,
    fontCacheEntries: OFFICE_FONT_CACHE_ENTRIES,
    token,
    zetaUrl,
    policyUrl,
    governanceUrl,
    protectionUrl,
    searchUrl,
    embeddedUrl,
    caretUrl,
    paletteUrl,
    docUrl,
    docxUrl,
    selectionUrl,
    threadUrl,
  }).replace(/</g, '\\u003c')
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
html,body{width:100%;height:100%;margin:0;overflow:hidden;background:var(--office-background,Canvas);color:var(--office-foreground,CanvasText);font:13px system-ui,sans-serif}
body{display:block}.canvas{position:relative;width:100%;height:100%}
#loading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;background:var(--office-background,Canvas);z-index:2}#loading[hidden]{display:none}#status[data-error=true]{color:#b42318}button{font:inherit;padding:4px 10px}
#qtcanvas{display:block;width:100%;height:100%;border:0;padding:0;outline:0;visibility:hidden}
</style></head><body>
<div class="canvas"><div id="loading"><span id="status"></span><button id="retry" data-testid="office-fonts-retry" type="button" hidden></button></div><canvas id="qtcanvas" tabindex="0" oncontextmenu="event.preventDefault()"></canvas></div>
<script src="${localFontsUrl}"></script><script src="${fontCacheUrl}"></script><script src="${ZETAOFFICE_ASSETS_BASE_URL}fontcache.js"></script><script src="${localeUrl}"></script><script src="${clipboardUrl}"></script><script src="${autoscrollUrl}"></script><script src="${selectionUrl}"></script><script>
'use strict';
const config=${config};
const canvas=document.getElementById('qtcanvas');
const loading=document.getElementById('loading');
const status=document.getElementById('status');
const retry=document.getElementById('retry');
status.textContent=config.text.starting;retry.textContent=config.text.reload;
let port, filename, processor, expectedDocumentKind, bytes, palette, editable=false, started=false, starting=false, disposed=false, searchVisible=false, documentKind='',bindingId='',bindingSequence=0,readyFrame=0,layoutPaintFrame=0,workerReady=false,layoutFinished=false,layoutPaintAcknowledged=false;
let startupStartedAt=0,runtimeReadyAt=0,startupFailed=false,documentReadonlyReason='',viewportRequestSequence=0,layoutPaintRequestId=0;
let fontCacheSource;
let selectionPoint,selectionAnchorPoint,selectionPointAt=0;
let writer=false,selectionAutoscrollKind='',selectionDragging=false;
let selectionAutoscrollRequestSequence=0,writerAutoscrollPendingRequest=0,writerAutoscrollCommitFrame=0,writerAutoscrollPaintFrame=0,writerAutoscrollPointerFrame=0,writerAutoscrollDirectionX=0,writerAutoscrollDirectionY=0,writerAutoscrollNextAt=0,writerAutoscrollSelectionY=0,writerAutoscrollTargetY=0,writerAutoscrollEngaged=false;
const selectionCommitCommand='selection_commit';
const selectionDragCommand='selection_drag';
const selectionAutoscrollCommand='selection_autoscroll';
const selectionAutoscrollReadyCommand='selection_autoscroll_ready';
const selectionAutoscrollCommitCommand='selection_autoscroll_commit';
const selectionAutoscrollAppliedCommand='selection_autoscroll_applied';
const primaryPointerButton=0;
const hostDocument=parent.document;
function resetSelectionAutoscroll(){cancelAnimationFrame(writerAutoscrollCommitFrame);cancelAnimationFrame(writerAutoscrollPaintFrame);cancelAnimationFrame(writerAutoscrollPointerFrame);writerAutoscrollPendingRequest=0;writerAutoscrollCommitFrame=0;writerAutoscrollPaintFrame=0;writerAutoscrollPointerFrame=0;writerAutoscrollDirectionX=0;writerAutoscrollDirectionY=0;writerAutoscrollNextAt=0;writerAutoscrollSelectionY=0;writerAutoscrollTargetY=0;writerAutoscrollEngaged=false}
function finishWriterAutoscroll(requestId){
  if(!selectionDragging||requestId!==writerAutoscrollPendingRequest)return;
  writerAutoscrollPaintFrame=0;writerAutoscrollPendingRequest=0;writerAutoscrollDirectionX=0;writerAutoscrollDirectionY=0;
  scheduleWriterPointerSelection();
}
function commitWriterAutoscroll(requestId){
  if(!selectionDragging||requestId!==writerAutoscrollPendingRequest)return;
  writerAutoscrollCommitFrame=0;
  writerAutoscrollNextAt=performance.now()+ScholarSeedOfficeAutoscroll.SELECTION_LINE_INTERVAL_MS;
  port?.postMessage({cmd:selectionAutoscrollCommitCommand,requestId});
}
function paintWriterAutoscroll(requestId){
  if(!selectionDragging||requestId!==writerAutoscrollPendingRequest)return;
  writerAutoscrollPaintFrame=requestAnimationFrame(()=>finishWriterAutoscroll(requestId));
}
function requestWriterAutoscroll(speed,shouldScroll){
  if(!selectionDragging||!port||writerAutoscrollPendingRequest||writerAutoscrollCommitFrame||writerAutoscrollPaintFrame||performance.now()<writerAutoscrollNextAt)return false;
  if(shouldScroll&&!writerAutoscrollEngaged){
    const bounds=canvas.getBoundingClientRect();
    writerAutoscrollSelectionY=speed.y<0?bounds.top+ScholarSeedOfficeAutoscroll.SELECTION_LINE_STEP_PX:bounds.bottom-ScholarSeedOfficeAutoscroll.SELECTION_LINE_STEP_PX;
    writerAutoscrollTargetY=writerAutoscrollSelectionY;writerAutoscrollEngaged=true;
  }
  writerAutoscrollDirectionX=Math.sign(speed.x);writerAutoscrollDirectionY=Math.sign(speed.y);
  const requestId=++selectionAutoscrollRequestSequence;writerAutoscrollPendingRequest=requestId;
  port.postMessage({cmd:selectionAutoscrollCommand,requestId,x:writerAutoscrollDirectionX,y:writerAutoscrollDirectionY});
  return true;
}
function scheduleWriterPointerSelection(){
  if(!selectionDragging||!writerAutoscrollEngaged||writerAutoscrollPointerFrame)return;
  const distance=writerAutoscrollTargetY-writerAutoscrollSelectionY;
  if(Math.abs(distance)<ScholarSeedOfficeAutoscroll.SELECTION_LINE_STEP_PX)return;
  writerAutoscrollPointerFrame=requestAnimationFrame(()=>{
    writerAutoscrollPointerFrame=0;
    const remaining=writerAutoscrollTargetY-writerAutoscrollSelectionY;
    if(Math.abs(remaining)<ScholarSeedOfficeAutoscroll.SELECTION_LINE_STEP_PX)return;
    if(requestWriterAutoscroll({x:0,y:Math.sign(remaining)},false))writerAutoscrollSelectionY+=Math.sign(remaining)*ScholarSeedOfficeAutoscroll.SELECTION_LINE_STEP_PX;
    else scheduleWriterPointerSelection();
  });
}
function updateWriterPointerSelection(event,edgeActive){
  if(!selectionDragging||!writerAutoscrollEngaged)return;
  const bounds=canvas.getBoundingClientRect();
  writerAutoscrollTargetY=Math.max(bounds.top+ScholarSeedOfficeAutoscroll.SELECTION_LINE_STEP_PX,Math.min(event.clientY,bounds.bottom-ScholarSeedOfficeAutoscroll.SELECTION_LINE_STEP_PX));
  if(!edgeActive)scheduleWriterPointerSelection();
}
function advanceWriterAutoscroll(speed){
  const distance=writerAutoscrollTargetY-writerAutoscrollSelectionY;
  if(writerAutoscrollEngaged&&Math.abs(distance)>=ScholarSeedOfficeAutoscroll.SELECTION_LINE_STEP_PX){
    if(requestWriterAutoscroll({x:0,y:Math.sign(distance)},false))writerAutoscrollSelectionY+=Math.sign(distance)*ScholarSeedOfficeAutoscroll.SELECTION_LINE_STEP_PX;
    return false;
  }
  requestWriterAutoscroll(speed,true);
  return false;
}
const selectionAutoscroll=ScholarSeedOfficeAutoscroll.create({bottomInset:()=>selectionAutoscrollKind==='writer'?ScholarSeedOfficeAutoscroll.SELECTION_LINE_STEP_PX:0,element:canvas,onSelectionFrame:speed=>{
  if(selectionAutoscrollKind==='writer')return advanceWriterAutoscroll(speed);
  return true;
}});
const imagePaths=new Set();
let serializedImagePaths=[];
const imageDirectory='/tmp/office/images/';
let viewportResizeFrame=0;
const viewportResizeCommand='resize_viewport';
const viewportResizedCommand='viewport_resized';
const documentReadyFrames=2;
function post(type, detail={}){parent.postMessage({kind:'scholarseed-office-editor',token:config.token,type,...detail},'*')}
function warmup(stage,detail={}){post('warmup',{stage,...detail})}
function diagnostic(stage,detail={}){post('diagnostic',{detail:{stage,...detail}})}
let fontRequestSequence=0;
const fontRequests=new Map();
function requestFontSource(type,detail={}){
  if(disposed)return Promise.reject(new Error('Office frame disposed'));
  return new Promise((resolve,reject)=>{const requestId=++fontRequestSequence;fontRequests.set(requestId,{resolve,reject});post(type,{requestId,...detail})})
}
function progress(message){status.textContent=message}
function applyPalette(value){palette=value;document.documentElement.style.colorScheme=value.mode;document.documentElement.style.setProperty('--office-background',value.background);document.documentElement.style.setProperty('--office-foreground',value.foreground);port?.postMessage({cmd:'theme',palette})}
function officeMessage(message){const code=String(message).replace(/^Error: /,'');return Object.prototype.hasOwnProperty.call(config.errors,code)?config.errors[code]:config.text.operationFailed+' '+String(message)}
function fail(reason,error){if(disposed)return;const message=error||reason;status.textContent=officeMessage(message);status.dataset.error='true';loading.hidden=false;diagnostic('unavailable',{reason,detail:String(message),bindingId});if(!runtimeReadyAt||reason.startsWith('runtime-'))warmup('error',{error:reason,detail:String(message)});post('unavailable',{reason,detail:String(message),bindingId})}
ScholarSeedOfficeClipboard.install(navigator.clipboard,error=>diagnostic('clipboard-write-failed',{error:String(error)}));
function resizeViewport(){viewportResizeFrame=0;if(port&&!disposed)port.postMessage({cmd:viewportResizeCommand,bindingId,requestId:++viewportRequestSequence})}
function scheduleViewportResize(){cancelAnimationFrame(viewportResizeFrame);viewportResizeFrame=requestAnimationFrame(resizeViewport)}
function cancelDocumentReady(){cancelAnimationFrame(readyFrame);cancelAnimationFrame(layoutPaintFrame);readyFrame=0;layoutPaintFrame=0}
function requestLayoutPaint(){
  const paintBindingId=bindingId;
  const paintSequence=bindingSequence;
  const requestId=++viewportRequestSequence;
  cancelAnimationFrame(readyFrame);cancelAnimationFrame(layoutPaintFrame);readyFrame=0;layoutPaintAcknowledged=false;layoutPaintRequestId=requestId;
  layoutPaintFrame=requestAnimationFrame(()=>{layoutPaintFrame=0;if(port&&!disposed&&paintBindingId===bindingId&&paintSequence===bindingSequence)port.postMessage({cmd:viewportResizeCommand,bindingId:paintBindingId,requestId})})
}
function revealDocument(readyBindingId,readySequence,remaining=documentReadyFrames){
  if(readyBindingId!==bindingId||readySequence!==bindingSequence)return;
  if(remaining>0){readyFrame=requestAnimationFrame(()=>revealDocument(readyBindingId,readySequence,remaining-1));return}
  readyFrame=0;loading.hidden=true;canvas.style.visibility='visible';status.textContent=editable?config.text.editable:config.text.readonly;diagnostic('document-ready',{durationMs:performance.now()-runtimeReadyAt,totalDurationMs:performance.now()-startupStartedAt,editable});post('ready',{bindingId:readyBindingId,dirty:false,editable,readonlyReason:documentReadonlyReason})
}
function scheduleDocumentReady(){
  if(!workerReady||!layoutFinished||!layoutPaintAcknowledged)return;
  const readyBindingId=bindingId;
  const readySequence=bindingSequence;
  cancelAnimationFrame(readyFrame);readyFrame=0;
  revealDocument(readyBindingId,readySequence)
}
window.addEventListener('error',event=>{startupFailed=true;fail('runtime-execution',event.message||config.text.runtimeError)});
window.addEventListener('unhandledrejection',event=>{startupFailed=true;fail('runtime-execution',String(event.reason||config.text.startFailed))});
function safeName(value){return (value.split(/[\\/]/).pop()||'document.docx').replace(/[^A-Za-z0-9._-]+/g,'_').slice(0,128)}
function upload(){if(!runtimeReadyAt||!port||!bytes||disposed)return;filename=safeName(filename);try{FS.mkdir('/tmp/office')}catch(error){}FS.writeFile('/tmp/office/'+filename,bytes);port.postMessage({cmd:'upload',filename,processor,expectedDocumentKind,readOnly:!editable,bindingId})}
var Module={canvas,uno_scripts:[config.zetaUrl,config.policyUrl,config.governanceUrl,config.protectionUrl,config.searchUrl,config.embeddedUrl,config.caretUrl,config.paletteUrl,config.docUrl,config.docxUrl,config.selectionUrl,config.threadUrl],locateFile(path,prefix){return(prefix||config.assetsBaseUrl)+path}};
globalThis.Module=Module;
Module.onAbort=error=>fail('runtime-initialization',String(error));
Module.mainScriptUrlOrBlob=new Blob(['importScripts('+JSON.stringify(config.assetsBaseUrl+'soffice.js')+');'],{type:'text/javascript'});
async function start(){
  if(started||starting||disposed)return;starting=true;startupStartedAt=performance.now();retry.hidden=true;delete status.dataset.error;
  progress(config.text.prepareFonts);diagnostic('font-prewarm');warmup('permission');post('font-permission-request');
}
async function startRuntimeWithFonts(){
  if(started||disposed)return;
  started=true;starting=false;
  let installStartedAt=0;
  let cacheOperation='await-fonts';
  const cancelled=()=>disposed||startupFailed;
  Module.onAbort=error=>{startupFailed=true;fail('runtime-initialization',String(error))};
  const prepared=prepareFonts(cancelled);
  void ScholarSeedFontCache.register(Module,{
    getFs:()=>FS,isDisposed:cancelled,
    onError:error=>diagnostic('font-cache-failed',{operation:cacheOperation,...ZetaLocalFonts.fontErrorDiagnostic(error),elapsedMs:performance.now()-startupStartedAt}),
    prepare:async fs=>{
      await prepared;if(cancelled())return;
      cacheOperation='cache-read';
      const {fingerprint,cache}=await fontCacheSource;if(cancelled())return;
      const startedAt=performance.now();
      if(cache){cacheOperation='cache-restore';ScholarSeedFontCache.restore(fs,cache);diagnostic('font-cache-hit',{durationMs:performance.now()-startedAt});return}
      diagnostic('font-cache-miss');cacheOperation='cache-generate';
      const generated=await ScholarSeedFontCache.generate(fs,config.fontCacheEntries,
        ()=>OfficeFontCache({locateFile:path=>config.assetsBaseUrl+path}),cancelled);
      if(!generated||cancelled())return;
      cacheOperation='cache-restore-generated';ScholarSeedFontCache.restore(fs,generated);
      diagnostic('font-cache-generated',{durationMs:performance.now()-startedAt,bytes:generated.files.reduce((sum,file)=>sum+file.bytes.length,0)});
      void requestFontSource('font-cache-write-request',{fingerprint,cache:generated}).then(()=>diagnostic('font-cache-persisted')).catch(error=>diagnostic('font-cache-persist-failed',ZetaLocalFonts.fontErrorDiagnostic(error)));
    }
  });
  void ZetaLocalFonts.registerFontsInPreRun(Module,prepared,{
    isDisposed:cancelled,
    getFs:()=>{installStartedAt=performance.now();diagnostic('font-install-start',{elapsedMs:installStartedAt-startupStartedAt});return FS},
    onDiagnostic:detail=>diagnostic('font-operation-failed',{...detail,elapsedMs:performance.now()-startupStartedAt,wasmHeapBytes:Module.HEAPU8?.byteLength??null}),
    onInstalled:()=>{diagnostic('font-installed',{durationMs:performance.now()-installStartedAt,elapsedMs:performance.now()-startupStartedAt});warmup('runtime')}
  }).catch(error=>{
    if(cancelled())return;startupFailed=true;retry.hidden=false;
    const reason=error.failureReason||'font-read';
    diagnostic('font-failed',{...ZetaLocalFonts.fontErrorDiagnostic(error),failure:reason,elapsedMs:performance.now()-startupStartedAt});
    fail(reason,reason==='runtime-assets'?config.text.assetsFailed:String(error));
  });
  // Locale arguments must exist before soffice.js captures Module.arguments.
  try{await ScholarSeedOfficeLocale.prepare(Module,config.assetsBaseUrl,config.locale)}catch(error){startupFailed=true;fail('runtime-assets',String(error));return}
  if(disposed||startupFailed)return;
  const scriptStartedAt=performance.now();
  diagnostic('runtime-script-start',{elapsedMs:scriptStartedAt-startupStartedAt});
  const script=document.createElement('script');script.src=config.assetsBaseUrl+'soffice.js';script.crossOrigin='anonymous';
  script.onerror=()=>{startupFailed=true;fail('runtime-assets',config.text.assetsFailed)};
  script.onload=()=>{
    diagnostic('runtime-script-loaded',{durationMs:performance.now()-scriptStartedAt,elapsedMs:performance.now()-startupStartedAt});
    if(disposed||startupFailed)return;
    Module.uno_main.then(value=>{if(cancelled())return;port=value;port.onmessage=onThread}).catch(error=>{startupFailed=true;fail('runtime-initialization',String(error))});
  };
  document.body.appendChild(script);
}
async function prepareFonts(cancelled){
  let failureReason='runtime-assets';
  try{
    const defaultStartedAt=performance.now();
    const defaultFonts=await ZetaLocalFonts.readFontAssets(config.defaultFonts);
    if(cancelled())return [];
    const defaultFontBytes=defaultFonts.reduce((sum,font)=>sum+font.bytes.byteLength,0);
    diagnostic('default-font-read',{configuredDefaultFontCount:config.defaultFonts.length,loadedDefaultFontCount:defaultFonts.length,defaultFontBytes,durationMs:performance.now()-defaultStartedAt});
    failureReason='font-catalog';
    let systemFonts=[];
    const metadataStartedAt=performance.now();
    let unavailable=0,loadedBytes=defaultFontBytes;
    warmup('catalog');
    const {catalog}=await requestFontSource('font-catalog-request');
    fontCacheSource=requestFontSource('font-cache-read-request',{fingerprint:catalog.fingerprint})
      .then(({cache})=>({fingerprint:catalog.fingerprint,cache}))
      .catch(error=>{diagnostic('font-cache-read-failed',ZetaLocalFonts.fontErrorDiagnostic(error));return{fingerprint:catalog.fingerprint,cache:null}});
    if(cancelled())return [];
    if(catalog.fonts.length===0)throw new Error(config.text.fontsEmpty);
    diagnostic('font-metadata',{availableFontCount:catalog.faceCount,sourceFileCount:catalog.fonts.length,durationMs:performance.now()-metadataStartedAt});
    const readStartedAt=performance.now();failureReason='font-read';
    systemFonts=await ZetaLocalFonts.readFontFiles(catalog.fonts,async id=>{if(cancelled())throw new Error('Office preparation cancelled');return(await requestFontSource('font-read-request',{id})).bytes},(done,total,bytesRead)=>{if(cancelled())return;loadedBytes=defaultFontBytes+bytesRead;progress(config.text.readingFonts.replace('{{done}}',String(done)).replace('{{total}}',String(total)));warmup('reading',{done,total,loadedBytes})},detail=>diagnostic('font-operation-failed',{...detail,elapsedMs:performance.now()-startupStartedAt}));
    if(cancelled())return [];
    diagnostic('font-read',{selectedFontCount:catalog.faceCount,loadedFontCount:systemFonts.length,duplicateFontCount:catalog.faceCount-systemFonts.length,readBytes:loadedBytes-defaultFontBytes,uniqueBytes:systemFonts.reduce((sum,font)=>sum+font.bytes.byteLength,0),unavailable,durationMs:performance.now()-readStartedAt});
    const prepared=[...defaultFonts,...systemFonts];
    const totalBytes=prepared.reduce((sum,font)=>sum+font.bytes.byteLength,0);
    diagnostic('font-register',{defaultFontCount:defaultFonts.length,systemFontCount:systemFonts.length,loadedFontCount:prepared.length,totalBytes,elapsedMs:performance.now()-startupStartedAt});
    progress(config.text.loadingFonts.replace('{{fontTotal}}',String(prepared.length)).replace('{{size}}',(totalBytes/1048576).toFixed(1)));
    return prepared;
  }catch(error){diagnostic('font-prepare-failed',{...ZetaLocalFonts.fontErrorDiagnostic(error),failure:failureReason,elapsedMs:performance.now()-startupStartedAt});throw Object.assign(new Error(String(error)),{failureReason})}
}
function onThread(event){
  const message=event.data;
  if(message.cmd==='thr_running'){runtimeReadyAt=performance.now();diagnostic('runtime-ready',{durationMs:runtimeReadyAt-startupStartedAt});warmup('ready');post('runtime-ready');if(palette)port?.postMessage({cmd:'theme',palette});upload()}
  else if(message.cmd==='theme_applied'){scheduleViewportResize();diagnostic('theme-applied',{mode:palette?.mode})}
  else if(message.cmd===viewportResizedCommand){
    canvas.dataset.renderWidth=String(message.width);canvas.dataset.renderHeight=String(message.height);post('viewport-resized',{width:message.width,height:message.height});
    if(message.bindingId!==bindingId||message.requestId!==layoutPaintRequestId)return;
    layoutPaintAcknowledged=true;diagnostic('layout-paint-ack',{durationMs:performance.now()-runtimeReadyAt});scheduleDocumentReady()
  }
  else if(message.cmd==='ui_ready'){
    if(message.bindingId!==bindingId)return;
    writer=message.documentKind==='writer';workerReady=true;if(!writer)layoutFinished=true;
    editable=Boolean(message.editable);documentKind=String(message.documentKind||'');documentReadonlyReason=String(message.readonlyReason||'');scheduleViewportResize();
    if(layoutFinished)requestLayoutPaint()
  }
  else if(message.cmd==='layout_finished'){
    if(message.bindingId!==bindingId)return;
    layoutFinished=true;diagnostic('layout-finished',{durationMs:performance.now()-runtimeReadyAt});requestLayoutPaint()
  }
  else if(message.cmd==='document_event'&&message.bindingId===bindingId)diagnostic('document-event',{eventName:message.eventName})
  else if(message.cmd==='modified')post('dirty',{dirty:Boolean(message.dirty)})
  else if(message.cmd==='selection'){
    const presentationDelayMs=selectionPointAt?performance.now()-selectionPointAt:undefined;
    diagnostic('selection-extracted',{extractionDurationMs:message.extractionDurationMs,presentationDelayMs});
    post('selection',{selection:message.selection,point:selectionAnchorPoint||selectionPoint})
  }
  else if(message.cmd===selectionAutoscrollReadyCommand){if(selectionDragging&&message.requestId===writerAutoscrollPendingRequest&&!writerAutoscrollCommitFrame)writerAutoscrollCommitFrame=requestAnimationFrame(()=>commitWriterAutoscroll(message.requestId))}
  else if(message.cmd===selectionAutoscrollAppliedCommand){if(selectionDragging&&message.requestId===writerAutoscrollPendingRequest&&!writerAutoscrollPaintFrame)paintWriterAutoscroll(message.requestId)}
  else if(message.cmd==='persist'){serializedImagePaths=[...imagePaths];const saved=FS.readFile('/tmp/office/'+filename);post('saved-bytes',{bytes:saved},[saved.buffer])}
	  else if(message.cmd==='selection_replaced')post('selection-replaced',{requestId:message.requestId})
	  else if(message.cmd==='selection_replace_failed')post('selection-replace-failed',{requestId:message.requestId,error:message.error})
  else if(message.cmd==='office_search_result')post('office-search-result',message)
  else if(message.cmd==='office_search_failed')post('office-search-failed',{requestId:message.requestId,error:message.error})
  else if(message.cmd==='presentation_state')post('presentation-state',{current:message.current,total:message.total})
  else if(message.cmd==='paste_failed')post('operation-rejected',{message:'office_paste_failed'})
  else if(message.cmd==='save_failed')post('save-failed',{message:message.message})
  else if(message.cmd==='policy_failed')fail('office-policy-failed',message.message)
  else if(message.cmd==='document_failed'&&message.bindingId===bindingId)fail('document-load',message.detail||message.message)
  else if(message.cmd==='operation_rejected')post('operation-rejected',{message:message.message})
  else if(message.cmd==='image_request')post('image-request',{requestId:message.requestId,source:message.source})
  else if(message.cmd==='image_failed'){
    const path=imageDirectory+message.requestId+'.png';
    if(imagePaths.has(path)){FS.unlink(path);imagePaths.delete(path)}
    post('image-failed',{requestId:message.requestId})
  }
}
function disposeOfficeFrame(){
  if(disposed)return;
  disposed=true;for(const request of fontRequests.values())request.reject(new Error('Office frame disposed'));fontRequests.clear();cancelDocumentReady();hostDocument.removeEventListener('pointerup',finishSelectionDrag,true);document.removeEventListener('mousemove',suppressWriterEdgeMousemove,true);selectionAutoscroll.destroy();resetSelectionAutoscroll();port?.postMessage({cmd:'dispose'});port?.close()
}
window.addEventListener('pagehide',disposeOfficeFrame,{once:true});
window.addEventListener('message',event=>{
  if(event.source!==parent||event.data?.kind!=='scholarseed-office-control'||event.data?.token!==config.token)return;
  const message=event.data;
  if(message.type==='prepare')void start();
  else if(message.type==='bind'){
    bindingId=String(message.bindingId||'');bindingSequence+=1;cancelDocumentReady();workerReady=false;layoutFinished=false;layoutPaintAcknowledged=false;layoutPaintRequestId=0;
    canvas.style.visibility='hidden';loading.hidden=false;status.textContent=config.text.loading;delete status.dataset.error;
    selectionAutoscroll.stop();resetSelectionAutoscroll();bytes=new Uint8Array(message.bytes);filename=message.filename;processor=message.processor;expectedDocumentKind=message.expectedDocumentKind;selectionAutoscrollKind=ScholarSeedOfficeSelection.autoscrollKind(filename)||'';selectionDragging=false;editable=Boolean(message.editable);if(started)upload();else void start()
  }
  else if(message.type==='theme')applyPalette(message.palette);
  else if(message.type==='font-permission-result'){
    if(message.granted)void startRuntimeWithFonts();
    else{starting=false;retry.hidden=false;fail('font-permission',config.text.permission)}
  }
  else if(message.type==='font-source-result'){
    const request=fontRequests.get(message.requestId);if(!request)return;fontRequests.delete(message.requestId);
    if(message.error)request.reject(new Error(message.error));else request.resolve(message);
  }
  else if(message.type==='retry-warmup')void start();
  else if(message.type==='save')port?.postMessage({cmd:'save'});
  else if(message.type==='image-result'){
    if(!/^\\d+$/.test(message.requestId))return;
    try{
      if(message.status==='image'){
        FS.mkdirTree(imageDirectory);
        const path=imageDirectory+message.requestId+'.png';
        FS.writeFile(path,new Uint8Array(message.bytes));imagePaths.add(path);
      }
      port?.postMessage({cmd:'image_result',requestId:message.requestId,status:message.status,text:message.text,formats:message.formats,undoLabel:config.text.undoInsertImage});
    }catch(error){port?.postMessage({cmd:'image_result',requestId:message.requestId,status:'error'});post('operation-rejected',{message:'office_image_failed',detail:String(error)})}
  }
	  else if(message.type==='replace-selection')port?.postMessage({cmd:'replace_selection',requestId:message.requestId,locator:message.locator,expectedText:message.expectedText,replacement:message.replacement,undoLabel:config.text.undoPolish});
	  else if(message.type==='office-search')port?.postMessage({cmd:'office_search',requestId:message.requestId,query:message.query,direction:message.direction});
	  else if(message.type==='presentation-navigate')port?.postMessage({cmd:'presentation_navigate',direction:message.direction});
	  else if(message.type==='office-search-visible')searchVisible=Boolean(message.visible);
	  else if(message.type==='paste-result')port?.postMessage({cmd:'paste',requestId:message.requestId,formats:message.formats,error:message.error});
	  else if(message.type==='viewport-resize')scheduleViewportResize();
  else if(message.type==='host-saved'){
    port?.postMessage({cmd:'host_saved'});
    for(const path of serializedImagePaths){if(imagePaths.has(path)){FS.unlink(path);imagePaths.delete(path)}}
    serializedImagePaths=[];
  }
  else if(message.type==='dispose')disposeOfficeFrame();
});
retry.addEventListener('click',()=>{if(started)post('retry-request');else void start()});
void start();
window.addEventListener('focus',()=>post('focus'));
document.addEventListener('pointerdown',event=>{selectionPoint={x:event.clientX,y:event.clientY};selectionAnchorPoint=selectionPoint;selectionPointAt=0;post('focus');if(documentKind===selectionAutoscrollKind&&event.isPrimary&&event.button===primaryPointerButton){selectionDragging=true;resetSelectionAutoscroll();diagnostic('selection-drag',{active:true,eventType:event.type});selectionAutoscroll.start(event);port?.postMessage({cmd:selectionDragCommand,active:true})}},true);
document.addEventListener('pointermove',event=>{selectionPoint={x:event.clientX,y:event.clientY};const edgeActive=selectionAutoscroll.move(event);if(selectionAutoscrollKind==='writer')updateWriterPointerSelection(event,edgeActive);if((edgeActive||writerAutoscrollEngaged)&&selectionAutoscrollKind==='writer'){event.preventDefault();event.stopImmediatePropagation()}},true);
function suppressWriterEdgeMousemove(event){
  if(!selectionDragging||selectionAutoscrollKind!=='writer')return;
  const speed=ScholarSeedOfficeAutoscroll.velocity({x:event.clientX,y:event.clientY},canvas.getBoundingClientRect(),ScholarSeedOfficeAutoscroll.SELECTION_LINE_STEP_PX);
  if(speed.x||speed.y||writerAutoscrollEngaged){event.preventDefault();event.stopImmediatePropagation()}
}
document.addEventListener('mousemove',suppressWriterEdgeMousemove,true);
function captureSelectionAnchor(event){
  if(event.view===window)selectionPoint={x:event.clientX,y:event.clientY};
  selectionAnchorPoint=selectionPoint;
  selectionPointAt=performance.now();
}
function finishSelectionDrag(event){
  if(!selectionDragging)return;
  const wasActive=selectionDragging;
  selectionDragging=false;
  if(event.view!==window){
    const pointerInit={bubbles:true,cancelable:true,view:window,clientX:selectionPoint.x,clientY:selectionPoint.y,button:primaryPointerButton,buttons:0};
    canvas.dispatchEvent(new PointerEvent('pointerup',{...pointerInit,pointerId:event.pointerId,pointerType:event.pointerType,isPrimary:event.isPrimary}));
    canvas.dispatchEvent(new MouseEvent('mouseup',pointerInit));
  }
  captureSelectionAnchor(event);
  diagnostic('selection-drag',{active:false,eventType:event.type,wasActive});
  port?.postMessage({cmd:selectionDragCommand,active:false})
  if(selectionAutoscrollKind==='writer')port?.postMessage({cmd:selectionCommitCommand});
  selectionAutoscroll.stop(event);
  resetSelectionAutoscroll();
}
document.addEventListener('pointerup',event=>{
  if(!selectionDragging)captureSelectionAnchor(event);
  finishSelectionDrag(event);
  if(documentKind==='impress')port?.postMessage({cmd:selectionCommitCommand});
},true);
document.addEventListener('pointercancel',finishSelectionDrag,true);
canvas.addEventListener('lostpointercapture',finishSelectionDrag,true);
hostDocument.addEventListener('pointerup',finishSelectionDrag,true);
document.addEventListener('keydown',event=>{
  if(searchVisible&&event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();post('office-search-close')}
},true);
document.addEventListener('keyup',event=>{
  if(documentKind==='writer'&&(event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='a')port?.postMessage({cmd:selectionCommitCommand})
},true);
if(!globalThis.crossOriginIsolated)fail('cross-origin-isolation',config.text.isolation);
else post('frame-ready');
</script></body></html>`
  return {
    html,
    token,
    dispose: () => {
      URL.revokeObjectURL(zetaUrl)
      URL.revokeObjectURL(docUrl)
      URL.revokeObjectURL(docxUrl)
      URL.revokeObjectURL(selectionUrl)
      URL.revokeObjectURL(threadUrl)
      URL.revokeObjectURL(policyUrl)
      URL.revokeObjectURL(governanceUrl)
      URL.revokeObjectURL(protectionUrl)
      URL.revokeObjectURL(searchUrl)
      URL.revokeObjectURL(embeddedUrl)
      URL.revokeObjectURL(caretUrl)
      URL.revokeObjectURL(localFontsUrl)
      URL.revokeObjectURL(fontCacheUrl)
      URL.revokeObjectURL(localeUrl)
      URL.revokeObjectURL(paletteUrl)
      URL.revokeObjectURL(clipboardUrl)
      URL.revokeObjectURL(autoscrollUrl)
    },
  }
}
