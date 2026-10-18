'use strict';
const express=require('express'),cors=require('cors'),helmet=require('helmet'),rate=require('express-rate-limit');
const bcrypt=require('bcryptjs'),jwt=require('jsonwebtoken'),{Pool}=require('pg');
const {DATABASE_URL,JWT_SECRET,FRONTEND_ORIGIN}=process.env;
if(!DATABASE_URL||!JWT_SECRET||JWT_SECRET.length<32){console.error('DATABASE_URL and a JWT_SECRET (32+ chars) are required');process.exit(1)}
const pool=new Pool({connectionString:DATABASE_URL,ssl:/localhost|127\.0\.0\.1/.test(DATABASE_URL)?false:{rejectUnauthorized:false}});

/* ---- PERMISSION MATRIX (enforced on the server). REVIEW against your business rules before go-live. ---- */
const ADMIN_ONLY=['users','roles'];
const STAFF_WRITE=['goats','gapps','gnot','insp','vets','births','kids','breed','shares','alloc','gasg','gho','fvis','agAct','leaves','lapp'];
const WRITE={admin:'*',owner:'*',manager:{except:ADMIN_ONLY},caretaker:STAFF_WRITE,staff:STAFF_WRITE};
const APPEND_ONLY=['audit'];
const ANON_APPEND=['apps','cands','sord','spay','senq','agEnq','seq'];
const ANON_READ=['news','vacs','sitems','scats','spromo','shopset','agItem','agSet','agTrn','agAct','agOpp','mgmt','fvis','hbg','settings','xset'];
const roleOf=(u,roles)=>{const b=['admin','owner','manager','caretaker'];if(b.includes(u.role))return u.role;
  const r=(roles||[]).find(z=>z.id==u.role);return r&&r.base=='owner'?'owner':r&&r.base=='manager'?'manager':'staff'};
const canWrite=(role,k)=>{const w=WRITE[role];return w==='*'||(Array.isArray(w)?w.includes(k):!!w&&!w.except.includes(k))};

const app=express();app.set('trust proxy',1);
app.use(helmet());app.use(cors({origin:FRONTEND_ORIGIN||false,methods:['GET','PUT','POST'],allowedHeaders:['Content-Type','Authorization']}));
app.use(express.json({limit:'5mb'}));
const A=fn=>(q,s,n)=>Promise.resolve(fn(q,s,n)).catch(n);

async function authUser(req){
  const h=req.headers.authorization||'';if(!h.startsWith('Bearer '))return null;
  let p;try{p=jwt.verify(h.slice(7),JWT_SECRET)}catch(e){return null}
  const m=Object.fromEntries((await pool.query("SELECT key,data FROM collections WHERE key IN('users','roles')")).rows.map(r=>[r.key,r.data]));
  const u=(m.users||[]).find(x=>x.u===p.u);if(!u||u.disabled)return null;
  return {u:u.u,role:roleOf(u,m.roles)};
}
app.get('/api/health',A(async(q,s)=>{await pool.query('SELECT 1');s.json({ok:true})}));

app.post('/api/login',rate({windowMs:15*60e3,limit:20}),A(async(q,s)=>{
  const {u,p}=q.body||{};if(typeof u!=='string'||typeof p!=='string')return s.status(400).json({error:'Username and PIN required'});
  const c=(await pool.query('SELECT pin_hash FROM credentials WHERE username=$1',[u])).rows[0];
  const ok=await bcrypt.compare(p,c?c.pin_hash:'$2a$10$abcdefghijklmnopqrstuuabcdefghijklmnopqrstuvwxyz01234');
  if(!c||!ok)return s.status(401).json({error:'Wrong username or PIN'});
  const users=(await pool.query("SELECT data FROM collections WHERE key='users'")).rows[0];
  const row=users&&users.data.find(x=>x.u===u);if(!row||row.disabled)return s.status(403).json({error:'Account disabled'});
  s.json({token:jwt.sign({u},JWT_SECRET,{expiresIn:'12h'}),user:u});
}));

app.get('/api/state',A(async(q,s)=>{
  const me=await authUser(q);if(q.headers.authorization&&!me)return s.status(401).json({error:'Session expired – please log in again'});
  const {rows}=await pool.query('SELECT key,version,data FROM collections');
  const data={},versions={};
  for(const r of rows){if(me||ANON_READ.includes(r.key)){data[r.key]=r.data;versions[r.key]=r.version}}
  s.json({me:me&&me.u,versions,data});
}));

app.put('/api/state',A(async(q,s)=>{
  const me=await authUser(q);if(q.headers.authorization&&!me)return s.status(401).json({error:'Session expired – please log in again'});
  const {opId,base={},changes}=q.body||{};
  if(typeof opId!=='string'||!changes||typeof changes!=='object')return s.status(400).json({error:'Bad request'});
  const c=await pool.connect();
  const fail=async(code,error,extra)=>{await c.query('ROLLBACK');return s.status(code).json({error,...extra})};
  try{
    await c.query('BEGIN');
    const prev=(await c.query('SELECT result FROM ops WHERE op_id=$1',[opId])).rows[0];
    if(prev){await c.query('COMMIT');return s.json({...prev.result,replayed:true})}
    const keys=Object.keys(changes);
    const cur=Object.fromEntries((await c.query('SELECT key,version,data FROM collections WHERE key=ANY($1) FOR UPDATE',[keys])).rows.map(r=>[r.key,r]));
    const role=me?me.role:'public',out={};
    for(const k of keys){
      const v=changes[k],row=cur[k],old=row?row.data:(Array.isArray(v)?[]:null);let next;
      if(!me&&!ANON_APPEND.includes(k))return fail(401,'Please log in to save changes');
      if(me&&!APPEND_ONLY.includes(k)&&!canWrite(role,k))return fail(403,`Your role (${role}) may not change "${k}"`);
      if(!me||APPEND_ONLY.includes(k)){
        if(k==='seq'){next={...(old||{})};for(const [a,b] of Object.entries(v||{}))next[a]=Math.max(+next[a]||0,+b||0)}
        else{if(!Array.isArray(v)||!Array.isArray(old||[]))return fail(400,`"${k}" must be a list`);
          const have=new Set((old||[]).map(x=>JSON.stringify(x)));const add=v.filter(x=>!have.has(JSON.stringify(x)));
          if(add.length>50)return fail(400,'Too many new records');
          const ids=new Set((old||[]).map(x=>x&&x.id).filter(Boolean));
          if(add.some(x=>x&&x.id&&ids.has(x.id)))return fail(409,'Reference number already used – reload and try again',{conflict:[k]});
          next=APPEND_ONLY.includes(k)?[...add,...(old||[])]:[...(old||[]),...add]}
      }else{
        if(row&&+base[k]!==row.version)return fail(409,`"${k}" was changed by another user`,{conflict:[k]});
        next=v;
        if(k==='users'){
          if(!Array.isArray(v))return fail(400,'users must be a list');
          next=[];for(const x of v){const {p,...rest}=x;next.push(rest);if(typeof p==='string'&&p.length>=4)
            await c.query('INSERT INTO credentials VALUES($1,$2) ON CONFLICT(username) DO UPDATE SET pin_hash=EXCLUDED.pin_hash',[x.u,await bcrypt.hash(p,10)])}
          await c.query('DELETE FROM credentials WHERE username<>ALL($1)',[next.map(x=>x.u)]);
          if(!next.some(x=>x.role==='admin'&&!x.disabled))return fail(400,'At least one active admin is required');
        }
      }
      const ver=row?row.version+1:1;
      await c.query('INSERT INTO collections(key,version,data,updated_by) VALUES($1,$2,$3,$4) ON CONFLICT(key) DO UPDATE SET version=$2,data=$3,updated_at=now(),updated_by=$4',[k,ver,JSON.stringify(next),me?me.u:'public']);
      await c.query('INSERT INTO collection_history(key,version,data,saved_by) VALUES($1,$2,$3,$4)',[k,ver,JSON.stringify(next),me?me.u:'public']);
      out[k]=ver;
    }
    const result={ok:true,versions:out};
    await c.query('INSERT INTO ops(op_id,result) VALUES($1,$2)',[opId,JSON.stringify(result)]);
    await c.query('COMMIT');s.json(result);
  }catch(e){try{await c.query('ROLLBACK')}catch(_){}throw e}finally{c.release()}
}));

app.use((e,q,s,n)=>{console.error(e);s.status(500).json({error:'Database error – your change was NOT saved',code:'db'})});
if(require.main===module){app.listen(process.env.PORT||3000,()=>console.log('Mwilu API listening'))}
module.exports={app,pool};
