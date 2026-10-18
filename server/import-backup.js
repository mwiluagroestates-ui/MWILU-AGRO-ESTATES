// One-time migration from the app's existing "Download JSON backup" file.
// Usage: DATABASE_URL=... node import-backup.js mwilu-backup-YYYY-MM-DD.json   (--force to overwrite a non-empty DB)
'use strict';const fs=require('fs'),bcrypt=require('bcryptjs'),{Pool}=require('pg');
(async()=>{
  const f=process.argv[2],force=process.argv.includes('--force');if(!f||!process.env.DATABASE_URL)throw new Error('Usage: DATABASE_URL=... node import-backup.js <backup.json>');
  const j=JSON.parse(fs.readFileSync(f,'utf8'));if(j.app!=='MWILU-AGRO-ESTATE'||!j.data)throw new Error('Not a Mwilu backup file');
  const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)?false:{rejectUnauthorized:false}});
  await pool.query(fs.readFileSync(__dirname+'/schema.sql','utf8'));
  const n=(await pool.query('SELECT count(*)::int n FROM collections')).rows[0].n;
  if(n&&!force)throw new Error('Database already has data – refusing to overwrite (take a backup, then use --force)');
  const c=await pool.connect();try{await c.query('BEGIN');
    for(const [k,v] of Object.entries(j.data)){let d=v;
      if(k==='users'){d=[];for(const u of v){const {p,...r}=u;d.push(r);if(p)await c.query('INSERT INTO credentials VALUES($1,$2) ON CONFLICT(username) DO UPDATE SET pin_hash=EXCLUDED.pin_hash',[u.u,await bcrypt.hash(String(p),10)])}}
      await c.query('INSERT INTO collections(key,version,data,updated_by) VALUES($1,1,$2,$3) ON CONFLICT(key) DO UPDATE SET version=collections.version+1,data=$2,updated_by=$3',[k,JSON.stringify(d),'import']);
      await c.query('INSERT INTO collection_history(key,version,data,saved_by) SELECT key,version,data,$2 FROM collections WHERE key=$1',[k,'import'])}
    await c.query('COMMIT');
    const t=(await pool.query("SELECT key,CASE WHEN jsonb_typeof(data)='array' THEN jsonb_array_length(data) END n FROM collections ORDER BY key")).rows;
    console.log('Imported. Records per list (compare with your backup):');console.table(t);
  }catch(e){await c.query('ROLLBACK');throw e}finally{c.release();await pool.end()}
})().catch(e=>{console.error('IMPORT FAILED:',e.message);process.exit(1)});
