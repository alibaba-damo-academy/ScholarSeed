import type { TFunction } from 'i18next'
import { effectiveShortcutBindings } from '../../../shortcuts'
import { officeFailureLabels } from './failure'
import zetaSource from 'zetajs/zeta.js?raw'

import localFontsSource from './local-fonts.js?raw'
import localeSource from './locale.js?raw'
import paletteSource from './palette.js?raw'
import clipboardSource from './clipboard.js?raw'
import docSource from './doc.js?raw'
import docxSource from './docx.js?raw'
import selectionSource from './selection.js?raw'
import officeThreadSource from './office-thread.js?raw'
import policySource from './policy.js?raw'
import governanceSource from './governance.js?raw'
import inputSource from './input.js?raw'
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
export const ZETAOFFICE_DEFAULT_FONTS = [{
  family: 'Noto Sans CJK SC',
  filename: 'NotoSansCJKsc-Regular.otf',
  url: new URL(`/${ZETAOFFICE_DEFAULT_FONT_PATH}`, window.location.origin).href
}] as const

export interface OfficeFrameDocument {
  html: string
  token: string
  dispose: () => void
}

function sourceUrl(source: string): string {
  return URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
}

export function officeFrameDocument(t: TFunction<'workbench'>, locale: string): OfficeFrameDocument {
  const token = crypto.randomUUID()
  const zetaUrl = sourceUrl(zetaSource)
  const docUrl = sourceUrl(docSource)
  const docxUrl = sourceUrl(docxSource)
  const selectionUrl = sourceUrl(selectionSource)
  const threadUrl = sourceUrl(officeThreadSource)
  const policyUrl = sourceUrl(policySource)
  const governanceUrl = sourceUrl(governanceSource)
  const inputUrl = sourceUrl(inputSource)
  const protectionUrl = sourceUrl(protectionSource)
  const searchUrl = sourceUrl(searchSource)
  const embeddedUrl = sourceUrl(embeddedSource)
  const caretUrl = sourceUrl(caretSource)
  const localFontsUrl = sourceUrl(localFontsSource)
  const localeUrl = sourceUrl(localeSource)
  const paletteUrl = sourceUrl(paletteSource)
  const clipboardUrl = sourceUrl(clipboardSource)
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
      undoInsertImage: t('officeDocument.undoInsertImage')
    },
    assetsBaseUrl: ZETAOFFICE_ASSETS_BASE_URL,
    defaultFonts: ZETAOFFICE_DEFAULT_FONTS,
    shortcuts: {
      find: effectiveShortcutBindings('office.find'),
      paste: effectiveShortcutBindings('office.paste'),
      save: effectiveShortcutBindings('office.save'),
      input: [
        { bindings: effectiveShortcutBindings('office.selectAll'), command: '.uno:SelectAll' },
        { bindings: effectiveShortcutBindings('office.bold'), command: '.uno:Bold' },
        { bindings: effectiveShortcutBindings('office.copy'), command: '.uno:Copy' },
        { bindings: effectiveShortcutBindings('office.italic'), command: '.uno:Italic' },
        { bindings: effectiveShortcutBindings('office.underline'), command: '.uno:Underline' },
        { bindings: effectiveShortcutBindings('office.cut'), command: '.uno:Cut' },
        { bindings: effectiveShortcutBindings('office.undo'), command: '.uno:Undo' },
        { bindings: effectiveShortcutBindings('office.redo'), command: '.uno:Redo' }
      ]
    },
    token,
    zetaUrl,
    policyUrl,
    governanceUrl,
    inputUrl,
    protectionUrl,
    searchUrl,
    embeddedUrl,
    caretUrl,
    paletteUrl,
    docUrl,
    docxUrl,
    selectionUrl,
    threadUrl
  }).replace(/</g, '\\u003c')
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
html,body{width:100%;height:100%;margin:0;overflow:hidden;background:var(--office-background,Canvas);color:var(--office-foreground,CanvasText);font:13px system-ui,sans-serif}
body{display:block}.canvas{position:relative;width:100%;height:100%}
#loading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;background:var(--office-background,Canvas);z-index:2}#loading[hidden]{display:none}#status[data-error=true]{color:#b42318}button{font:inherit;padding:4px 10px}
#qtcanvas{display:block;width:100%;height:100%;border:0;padding:0;outline:0;visibility:hidden}
#ime-input{position:absolute;left:0;top:0;width:1px;height:1px;margin:0;border:0;padding:0;overflow:hidden;white-space:pre;resize:none;opacity:0;pointer-events:none}
</style></head><body>
<div class="canvas"><div id="loading"><span id="status"></span><button id="retry" data-testid="office-fonts-retry" type="button" hidden></button></div><canvas id="qtcanvas" contenteditable="true" oncontextmenu="event.preventDefault()" onkeydown="event.preventDefault()"></canvas><textarea id="ime-input" aria-label="Office text input" tabindex="-1" wrap="off" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea></div>
<script src="${localFontsUrl}"></script><script src="${localeUrl}"></script><script src="${inputUrl}"></script><script src="${clipboardUrl}"></script><script>
'use strict';
const config=${config};
const canvas=document.getElementById('qtcanvas');
const imeInput=document.getElementById('ime-input');
const loading=document.getElementById('loading');
const status=document.getElementById('status');
const retry=document.getElementById('retry');
status.textContent=config.text.starting;retry.textContent=config.text.reload;
let port, filename, processor, expectedDocumentKind, bytes, palette, editable=false, started=false, starting=false, disposed=false, searchVisible=false, documentKind='', pasteShortcutPending=false,bindingId='',bindingSequence=0,readyFrame=0,layoutPaintFrame=0,workerReady=false,layoutFinished=false,layoutPaintAcknowledged=false;
let startupStartedAt=0,runtimeReadyAt=0,documentReadonlyReason='',viewportRequestSequence=0,layoutPaintRequestId=0;
let selectionPoint,selectionPointAt=0;
let writer=false,legacyDoc=false,legacyDocSelectionDragging=false;
let embeddedActive=false;
const caretCommand='caret';
const caretRequestCommand='caret_request';
const selectionCommitCommand='selection_commit';
const selectionDragCommand='selection_drag';
const legacyDocSuffix='.doc';
const primaryPointerButton=0;
const officeInput=ScholarSeedOfficeInput.create({element:imeInput,canvas,enabled:()=>editable&&writer&&!embeddedActive,shortcuts:config.shortcuts.input,sendCommand:command=>port?.postMessage({cmd:'input_command',command}),sendText:text=>port?.postMessage({cmd:'input_text',text}),requestCaret:()=>port?.postMessage({cmd:caretRequestCommand})});
const imagePaths=new Set();
let serializedImagePaths=[];
const imageDirectory='/tmp/office/images/';
let viewportResizeFrame=0;
const viewportResizeCommand='resize_viewport';
const viewportResizedCommand='viewport_resized';
const pasteShortcutResetDelay=250;
const csvQuoteCode=34;
const csvUtf8EncodingCode=76;
const documentReadyFrames=2;
const csvSeparators=[[';',59],[',',44],['\\t',9],['|',124]];
function post(type, detail={}){parent.postMessage({kind:'scholarseed-office-editor',token:config.token,type,...detail},'*')}
function warmup(stage,detail={}){post('warmup',{stage,...detail})}
function shortcutMatches(event,bindings){const primary=/Mac|iPhone|iPad/i.test(navigator.userAgent)?event.metaKey&&!event.ctrlKey:event.ctrlKey&&!event.metaKey;return bindings.some(binding=>{const modifiers=new Set(binding.modifiers);return event.key.toLowerCase()===binding.key.toLowerCase()&&primary===modifiers.has('primary')&&event.shiftKey===modifiers.has('shift')&&event.altKey===modifiers.has('alt')})}
function diagnostic(stage,detail={}){post('diagnostic',{detail:{stage,...detail}})}
function progress(message){status.textContent=message}
function applyPalette(value){palette=value;document.documentElement.style.colorScheme=value.mode;document.documentElement.style.setProperty('--office-background',value.background);document.documentElement.style.setProperty('--office-foreground',value.foreground);port?.postMessage({cmd:'theme',palette})}
function officeMessage(message){const code=String(message).replace(/^Error: /,'');return Object.prototype.hasOwnProperty.call(config.errors,code)?config.errors[code]:config.text.operationFailed+' '+String(message)}
function fail(reason,error){const message=error||reason;status.textContent=officeMessage(message);status.dataset.error='true';loading.hidden=false;if(!runtimeReadyAt)warmup('error',{error:reason});post('unavailable',{reason})}
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
  readyFrame=0;loading.hidden=true;canvas.style.visibility='visible';status.textContent=editable?config.text.editable:config.text.readonly;officeInput.focus();diagnostic('document-ready',{durationMs:performance.now()-runtimeReadyAt,totalDurationMs:performance.now()-startupStartedAt,editable});post('ready',{bindingId:readyBindingId,dirty:false,editable,readonlyReason:documentReadonlyReason})
}
function scheduleDocumentReady(){
  if(!workerReady||!layoutFinished||!layoutPaintAcknowledged)return;
  const readyBindingId=bindingId;
  const readySequence=bindingSequence;
  cancelAnimationFrame(readyFrame);readyFrame=0;
  revealDocument(readyBindingId,readySequence)
}
window.addEventListener('error',event=>fail('zeta-runtime-error',event.message||config.text.runtimeError));
window.addEventListener('unhandledrejection',event=>fail('zeta-runtime-error',String(event.reason||config.text.startFailed)));
function safeName(value){return (value.split(/[\\/]/).pop()||'document.docx').replace(/[^A-Za-z0-9._-]+/g,'_').slice(0,128)}
function csvFilterOptions(){
  if(!filename.toLowerCase().endsWith('.csv'))return undefined;
  const header=new TextDecoder().decode(bytes.slice(0,8192)).split(/\\r?\\n/,1)[0]||'';
  const separator=csvSeparators.map(([character,code])=>({code,count:header.split(character).length-1})).sort((a,b)=>b.count-a.count)[0];
  return String((separator&&separator.count>0?separator.code:44))+','+csvQuoteCode+','+csvUtf8EncodingCode+',1,,0,true,true,true,false,false';
}
function upload(){if(!port||!bytes)return;filename=safeName(filename);try{FS.mkdir('/tmp/office')}catch(error){}FS.writeFile('/tmp/office/'+filename,bytes);port.postMessage({cmd:'upload',filename,processor,expectedDocumentKind,readOnly:!editable,csvOptions:csvFilterOptions(),bindingId})}
var Module={canvas,uno_scripts:[config.zetaUrl,config.policyUrl,config.governanceUrl,config.protectionUrl,config.searchUrl,config.embeddedUrl,config.caretUrl,config.paletteUrl,config.docUrl,config.docxUrl,config.selectionUrl,config.threadUrl],locateFile(path,prefix){return(prefix||config.assetsBaseUrl)+path}};
globalThis.Module=Module;
Module.mainScriptUrlOrBlob=new Blob(['importScripts('+JSON.stringify(config.assetsBaseUrl+'soffice.js')+');'],{type:'text/javascript'});
async function start(){
  if(started||starting||disposed)return;starting=true;startupStartedAt=performance.now();retry.hidden=true;delete status.dataset.error;
  progress(config.text.prepareFonts);diagnostic('font-prewarm');warmup('permission');post('font-permission-request');
}
async function startRuntimeWithFonts(){
  if(started||disposed)return;
  let failureReason='zeta-assets-failed';
  try{
    const defaultStartedAt=performance.now();
    const defaultFonts=await ZetaLocalFonts.readFontAssets(config.defaultFonts);
    const defaultFontBytes=defaultFonts.reduce((sum,font)=>sum+font.bytes.byteLength,0);
    diagnostic('default-font-read',{configuredDefaultFontCount:config.defaultFonts.length,loadedDefaultFontCount:defaultFonts.length,defaultFontBytes,durationMs:performance.now()-defaultStartedAt});
    failureReason='local-fonts-required';
    let systemFonts=[];
    const metadataStartedAt=performance.now();
    let unavailable=0,loadedBytes=defaultFontBytes;
    if(!('queryLocalFonts'in globalThis))throw new Error(config.text.fontsUnsupported);
    warmup('catalog');
    const entries=ZetaLocalFonts.dedupeFontEntries(await globalThis.queryLocalFonts());
    if(entries.length===0)throw new Error(config.text.fontsEmpty);
    diagnostic('font-metadata',{availableFontCount:entries.length,durationMs:performance.now()-metadataStartedAt});
    const readStartedAt=performance.now();
    systemFonts=await ZetaLocalFonts.readAllFontEntries(entries,(done,total,bytesRead)=>{loadedBytes=defaultFontBytes+bytesRead;progress(config.text.readingFonts.replace('{{done}}',String(done)).replace('{{total}}',String(total)));warmup('reading',{done,total,loadedBytes})},()=>{unavailable+=1});
    diagnostic('font-read',{selectedFontCount:entries.length,loadedFontCount:systemFonts.length,unavailable,durationMs:performance.now()-readStartedAt});
    const prepared=[...defaultFonts,...systemFonts];
    ZetaLocalFonts.registerFontsInPreRun(Module,prepared);
    const totalBytes=prepared.reduce((sum,font)=>sum+font.bytes.byteLength,0);
    diagnostic('font-register',{defaultFontCount:defaultFonts.length,systemFontCount:systemFonts.length,loadedFontCount:prepared.length,totalBytes});
    progress(config.text.loadingFonts.replace('{{fontTotal}}',String(prepared.length)).replace('{{size}}',(totalBytes/1048576).toFixed(1)));
  }catch(error){starting=false;retry.hidden=false;diagnostic('font-failed',{error:String(error)});fail(failureReason,failureReason==='zeta-assets-failed'?config.text.assetsFailed:String(error));return}
  started=true;starting=false;
  warmup('runtime');
  await ScholarSeedOfficeLocale.prepare(Module,config.assetsBaseUrl,config.locale);
  progress(config.text.loading);
  const script=document.createElement('script');script.src=config.assetsBaseUrl+'soffice.js';script.crossOrigin='anonymous';
  script.onerror=()=>fail('zeta-assets-failed',config.text.assetsFailed);
  script.onload=()=>{progress(config.text.initializing);Module.uno_main.then(value=>{port=value;port.onmessage=onThread}).catch(error=>fail('zeta-init-failed',String(error)))};
  document.body.appendChild(script);
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
    writer=message.documentKind==='writer';embeddedActive=false;workerReady=true;if(!writer)layoutFinished=true;
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
    post('selection',{selection:message.selection,point:selectionPoint})
  }
  else if(message.cmd==='persist'){serializedImagePaths=[...imagePaths];const saved=FS.readFile('/tmp/office/'+filename);post('saved-bytes',{bytes:saved},[saved.buffer])}
	  else if(message.cmd==='selection_replaced')post('selection-replaced',{requestId:message.requestId})
	  else if(message.cmd==='selection_replace_failed')post('selection-replace-failed',{requestId:message.requestId,error:message.error})
  else if(message.cmd==='office_search_result')post('office-search-result',message)
  else if(message.cmd==='office_search_failed')post('office-search-failed',{requestId:message.requestId,error:message.error})
  else if(message.cmd==='presentation_state')post('presentation-state',{current:message.current,total:message.total})
  else if(message.cmd==='paste_failed')post('operation-rejected',{message:'office_paste_failed'})
  else if(message.cmd==='save_failed')post('save-failed',{message:message.message})
  else if(message.cmd==='policy_failed')fail('office-policy-failed',message.message)
  else if(message.cmd==='operation_rejected')post('operation-rejected',{message:message.message})
  else if(message.cmd==='image_request')post('image-request',{requestId:message.requestId,source:message.source})
  else if(message.cmd==='image_failed'){
    const path=imageDirectory+message.requestId+'.png';
    if(imagePaths.has(path)){FS.unlink(path);imagePaths.delete(path)}
    post('image-failed',{requestId:message.requestId})
  }
  else if(message.cmd==='embedded_active')embeddedActive=Boolean(message.active)
  else if(message.cmd===caretCommand)officeInput.place(message)
}
window.addEventListener('message',event=>{
  if(event.source!==parent||event.data?.kind!=='scholarseed-office-control'||event.data?.token!==config.token)return;
  const message=event.data;
  if(message.type==='bind'){
    bindingId=String(message.bindingId||'');bindingSequence+=1;cancelDocumentReady();workerReady=false;layoutFinished=false;layoutPaintAcknowledged=false;layoutPaintRequestId=0;
    canvas.style.visibility='hidden';loading.hidden=false;status.textContent=config.text.loading;delete status.dataset.error;
    bytes=new Uint8Array(message.bytes);filename=message.filename;processor=message.processor;expectedDocumentKind=message.expectedDocumentKind;legacyDoc=String(filename||'').toLowerCase().endsWith(legacyDocSuffix);legacyDocSelectionDragging=false;editable=Boolean(message.editable);if(started)upload();else void start()
  }
  else if(message.type==='theme')applyPalette(message.palette);
  else if(message.type==='font-permission-result'){
    if(message.granted)void startRuntimeWithFonts();
    else{starting=false;retry.hidden=false;fail('local-fonts-required',config.text.permission)}
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
  else if(message.type==='dispose'){disposed=true;cancelDocumentReady();officeInput.destroy();port?.postMessage({cmd:'dispose'});port?.close()}
});
retry.addEventListener('click',()=>void start());
void start();
window.addEventListener('focus',()=>post('focus'));
document.addEventListener('pointerdown',event=>{selectionPoint={x:event.clientX,y:event.clientY};selectionPointAt=0;post('focus');if(writer&&legacyDoc&&event.isPrimary&&event.button===primaryPointerButton){legacyDocSelectionDragging=true;port?.postMessage({cmd:selectionDragCommand,active:true})}},true);
document.addEventListener('pointerup',event=>{
  selectionPoint={x:event.clientX,y:event.clientY};
  selectionPointAt=performance.now();
  if(legacyDocSelectionDragging){legacyDocSelectionDragging=false;port?.postMessage({cmd:selectionDragCommand,active:false});port?.postMessage({cmd:selectionCommitCommand})}
  if(documentKind==='impress')port?.postMessage({cmd:selectionCommitCommand});
},true);
document.addEventListener('pointercancel',()=>{if(legacyDocSelectionDragging){legacyDocSelectionDragging=false;port?.postMessage({cmd:selectionDragCommand,active:false});port?.postMessage({cmd:selectionCommitCommand})}},true);
document.addEventListener('keydown',event=>{
  if(shortcutMatches(event,config.shortcuts.save)){event.preventDefault();event.stopImmediatePropagation();post('save-request');return}
  if(shortcutMatches(event,config.shortcuts.find)){event.preventDefault();event.stopImmediatePropagation();post('office-search-open');return}
  if(editable&&documentKind==='writer'&&!embeddedActive&&shortcutMatches(event,config.shortcuts.paste)){event.preventDefault();event.stopImmediatePropagation();pasteShortcutPending=true;setTimeout(()=>{pasteShortcutPending=false},pasteShortcutResetDelay);port?.postMessage({cmd:'image_request'});return}
  if(searchVisible&&event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();post('office-search-close')}
},true);
document.addEventListener('paste',event=>{
  if(!editable||documentKind!=='writer'||embeddedActive)return;
  event.preventDefault();event.stopImmediatePropagation();if(pasteShortcutPending){pasteShortcutPending=false;return}port?.postMessage({cmd:'image_request'});
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
      URL.revokeObjectURL(inputUrl)
      URL.revokeObjectURL(protectionUrl)
      URL.revokeObjectURL(searchUrl)
      URL.revokeObjectURL(embeddedUrl)
      URL.revokeObjectURL(caretUrl)
      URL.revokeObjectURL(localFontsUrl)
      URL.revokeObjectURL(localeUrl)
      URL.revokeObjectURL(paletteUrl)
      URL.revokeObjectURL(clipboardUrl)
    }
  }
}
