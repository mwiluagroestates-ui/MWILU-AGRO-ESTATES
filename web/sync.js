/* Mwilu online persistence layer. Replaces localStorage as the source of truth for shared business data.
   Loaded AFTER the app's own scripts: it overrides load/save/gSync/login only; no module, layout or business rule is changed. */
(function(){
'use strict';
const API=(window.MWILU_API||'').replace(/\/$/,''),TK='mwilu_tok';
const ANON=['apps','cands','sord','spay','senq','agEnq','seq'];
let token=sessionStorage.getItem(TK)||'',synced={},vers={},busy=false,timer=null,retryT=null,fails=0,lastPayload='',opId='',conflict=false;

/* ---------- status pill ---------- */
const pill=document.createElement('div');pill.id='syncpill';
pill.style.cssText='position:fixed;left:10px;bottom:10px;z-index:99999;padding:7px 12px;border-radius:18px;font:600 12px system-ui,sans-serif;color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.3);max-width:80vw';
document.body.appendChild(pill);
const ST={saved:['#1d6b3a','✓ Saved to server'],saving:['#555','Saving…'],pending:['#b26a00','Pending – not yet saved'],
 offline:['#b26a00','Offline – changes NOT saved yet; they will be sent when connection returns'],
 down:['#b3261e','Server unavailable – changes NOT saved'],db:['#b3261e','Database error – changes NOT saved'],
 auth:['#b3261e','Not authorised – please log in again'],denied:['#b3261e','Your role may not change this – NOT saved'],
 conflict:['#b3261e','Changed by another user – NOT saved'],failed:['#b3261e','Save failed']};
function status(k,msg){const [c,t]=ST[k];pill.style.background=c;pill.textContent='';pill.append(msg||t);
  if(['down','db','failed','offline','pending'].includes(k)){const b=document.createElement('button');b.textContent='Retry now';b.style.cssText='margin-left:8px;border:0;border-radius:10px;padding:2px 8px;cursor:pointer';b.onclick=()=>{fails=0;flush()};pill.append(b)}
  if(k==='conflict'){const b=document.createElement('button');b.textContent='Reload latest';b.style.cssText='margin-left:8px;border:0;border-radius:10px;padding:2px 8px;cursor:pointer';b.onclick=()=>pull(true);pill.append(b)}}
if(!API)status('down','Backend URL not configured (config.js) – nothing can be saved');

/* ---------- http ---------- */
async function http(method,path,body){
  let r;try{r=await fetch(API+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined})}
  catch(e){const x=new Error(navigator.onLine?'down':'offline');x.kind=navigator.onLine?'down':'offline';throw x}
  let j={};try{j=await r.json()}catch(e){}
  if(!r.ok){const x=new Error(j.error||('HTTP '+r.status));x.http=r.status;x.body=j;x.kind=r.status==401?'auth':r.status==403?'denied':r.status==409?'conflict':(r.status>=502||r.status==503||r.status==504)?'down':j.code=='db'?'db':'failed';throw x}
  return j}

/* ---------- pull / apply server state ---------- */
function apply(j){D=j.data;vers=j.versions||{};synced={};for(const k of Object.keys(D))synced[k]=JSON.stringify(D[k]);gNorm();
  for(const k of Object.keys(D))synced[k]=JSON.stringify(D[k]);       // gNorm may add defaults: treat as baseline, not as a user change
  conflict=false}
function rebase(){for(const k of Object.keys(D))if(!dirtyByUser.has(k))synced[k]=JSON.stringify(D[k])}
const dirtyByUser=new Set();
async function pull(rerender){try{const j=await http('GET','/api/state');apply(j);
    if(token&&j.me){U=D.users.find(x=>x.u===j.me)||null}
    if(rerender)render();rebase();status('saved');fails=0;return true}
  catch(e){if(e.kind==='auth'&&token){token='';sessionStorage.removeItem(TK);U=null;D.users=[]; status('auth');render()}else status(e.kind||'failed');return false}}

/* ---------- save (replaces localStorage write) ---------- */
const dirtyKeys=()=>Object.keys(D).filter(k=>(token||ANON.includes(k))&&JSON.stringify(D[k])!==synced[k]);
window.save=function(){clearTimeout(timer);timer=setTimeout(flush,350);if(!busy&&!conflict)status('pending')};
async function flush(){
  if(busy||conflict)return;
  if(!navigator.onLine){status('offline');return}
  const changes={};for(const k of dirtyKeys())changes[k]=D[k];
  if(!Object.keys(changes).length){if(!fails)status('saved');return}
  const sent={};for(const k in changes)sent[k]=JSON.stringify(changes[k]);
  const payload=JSON.stringify({base:vers,sent});if(payload!==lastPayload){lastPayload=payload;opId=crypto.randomUUID()}  // same payload => same opId => server never duplicates
  busy=true;status('saving');
  try{const r=await http('PUT','/api/state',{opId,base:vers,changes});
    for(const k in sent){synced[k]=sent[k]}Object.assign(vers,r.versions||{});fails=0;lastPayload='';busy=false;status('saved');
    if(typeof pendingToast==='function')pendingToast();
    if(dirtyKeys().length)flush();
    else if(!token)setTimeout(()=>pull(false),300)}                  // public submit: refresh versions so later submits don't clash
  catch(e){busy=false;fails++;
    if(e.kind==='conflict'){conflict=true;status('conflict',(e.body&&e.body.error||'Changed by another user')+' – your change was NOT saved. Reload the latest data and redo it.')}
    else if(e.kind==='auth'){status('auth')}else if(e.kind==='denied'){status('denied',e.message+' – NOT saved')}
    else{status(e.kind||'failed');clearTimeout(retryT);retryT=setTimeout(flush,Math.min(60000,2000*2**Math.min(fails,5)))}}}
window.addEventListener('online',()=>{fails=0;flush()});window.addEventListener('offline',()=>status('offline'));
window.addEventListener('beforeunload',e=>{if(busy||dirtyKeys().length){e.preventDefault();e.returnValue=''}});
const _toast=window.toast;let ok=false;window.toast=function(s){if(/^saved\b/i.test(String(s))&&!ok)s='Saving to server…';return _toast(s)};
function pendingToast(){_toast('Saved to server')}

/* ---------- authentication (server-verified; PINs are never in the browser) ---------- */
window.login=async function(){
  const u=$('lu').value.trim(),p=$('lp').value;
  try{const r=await http('POST','/api/login',{u,p});token=r.token;sessionStorage.setItem(TK,token);
    if(!await pull(false))return;U=D.users.find(x=>x.u===r.user)||null;V='';ok=true;log('LOGIN',r.user);render()}
  catch(e){_toast(e.kind==='down'||e.kind==='offline'?'Cannot reach the server – try again':e.message)}};
const _render=window.render;let lastU=null;
window.render=function(){if(lastU&&!U&&token){token='';sessionStorage.removeItem(TK);pull(false).then(()=>_render())}lastU=U;return _render.apply(this,arguments)};

/* gSync() (cross-tab refresh used before critical edits) -> now a no-op; shared data is refreshed by polling below */
window.gSync=function(){};
setInterval(()=>{if(document.hidden||busy||conflict||!navigator.onLine)return;
  if(dirtyKeys().length)return;
  if(($('m')&&$('m').innerHTML.trim())||document.activeElement&&/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName))return;
  http('GET','/api/state').then(j=>{if(JSON.stringify(j.versions)!==JSON.stringify(vers)){apply(j);if(token&&j.me)U=D.users.find(x=>x.u===j.me)||U;render()}}).catch(()=>{})},20000);

/* ---------- start ---------- */
D={};try{gNorm()}catch(e){}D.users=[];                              // never trust/seed local data: wait for the server
pull(true);
})();
