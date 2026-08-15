const { Pool } = require("pg");
const crypto = require("crypto");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

function send(res,status,obj){
  res.statusCode=status;
  res.setHeader("Content-Type","application/json");
  res.setHeader("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma","no-cache");res.setHeader("Expires","0");
  res.end(JSON.stringify(obj));
}
function coach(req){return !!process.env.COACH_KEY && req.headers["x-coach-key"]===process.env.COACH_KEY}
async function body(req){
  if(req.body && typeof req.body==="object") return req.body;
  if(typeof req.body==="string"){try{return JSON.parse(req.body)}catch{}}
  let raw="";for await(const chunk of req)raw+=chunk;
  if(!raw)return{};try{return JSON.parse(raw)}catch{return{}}
}
function slug(v){return String(v||"open-men").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"")||"open-men"}
function stateId(div){return "freshwater:"+slug(div)}
function inviteSquad(div,squad){return `fw:${slug(div)}|${String(squad||"")}`}
function parseInviteSquad(v){
 const s=String(v||"");if(!s.startsWith("fw:"))return{division:"open-men",squad:s};
 const p=s.indexOf("|");return{division:slug(p>=0?s.slice(3,p):s.slice(3)),squad:p>=0?s.slice(p+1):""};
}


async function athleteFromToken(token){
 if(!token)return null;
 const q=await pool.query(`select athlete_id,athlete_name from athlete_invites where token=$1 and active=true`,[token]);
 return q.rowCount?q.rows[0]:null;
}
async function ensureClubTables(){
 await pool.query(`create table if not exists club_announcements(
  id bigserial primary key, author text not null, text text not null, created_at timestamptz default now()
 )`);
 await pool.query(`create table if not exists club_media(
  id bigserial primary key, author text not null, type text not null, url text not null, caption text, created_at timestamptz default now()
 )`);
}

module.exports=async(req,res)=>{
 try{
  const u=new URL(req.url,"https://freshwater.local"),action=u.searchParams.get("action"),division=slug(u.searchParams.get("division"));

  if(action==="club-announcements"&&req.method==="GET"){
   await ensureClubTables();
   const q=await pool.query(`select id,author,text,created_at from club_announcements order by created_at desc limit 100`);
   return send(res,200,{items:q.rows});
  }
  if(action==="club-announcement"&&req.method==="POST"){
   await ensureClubTables();const b=await body(req);
   const athlete=await athleteFromToken(b.token);if(!coach(req)&&!athlete)return send(res,401,{error:"Athlete or coach access required"});
   const author=String(b.author||athlete?.athlete_name||"Freshwater Athlete").slice(0,100),text=String(b.text||"").trim().slice(0,3000);
   if(!text)return send(res,400,{error:"Announcement required"});
   await pool.query(`insert into club_announcements(author,text) values($1,$2)`,[author,text]);
   return send(res,200,{ok:true});
  }
  if(action==="club-media"&&req.method==="GET"){
   await ensureClubTables();
   const q=await pool.query(`select id,author,type,url,caption,created_at from club_media order by created_at desc limit 200`);
   return send(res,200,{items:q.rows});
  }
  if(action==="club-media-add"&&req.method==="POST"){
   await ensureClubTables();const b=await body(req);
   const athlete=await athleteFromToken(b.token);if(!coach(req)&&!athlete)return send(res,401,{error:"Athlete or coach access required"});
   const author=String(b.author||athlete?.athlete_name||"Freshwater Athlete").slice(0,100),type=b.type==="video"?"video":"photo",url=String(b.url||"").trim().slice(0,2000),caption=String(b.caption||"").slice(0,500);
   if(!/^https?:\/\//i.test(url))return send(res,400,{error:"Valid media URL required"});
   await pool.query(`insert into club_media(author,type,url,caption) values($1,$2,$3,$4)`,[author,type,url,caption]);
   return send(res,200,{ok:true});
  }


  if(action==="coach-sync"&&req.method==="POST"){
   if(!coach(req))return send(res,401,{error:"Coach key invalid"});
   const b=await body(req),div=slug(b.division||division);
   await pool.query(`insert into app_state(id,data,updated_at) values($1,$2,now()) on conflict(id) do update set data=excluded.data,updated_at=now()`,[stateId(div),b.data||{}]);
   return send(res,200,{ok:true,division:div});
  }

  if(action==="coach-state"&&req.method==="GET"){
   if(!coach(req))return send(res,401,{error:"Coach key invalid"});
   let q=await pool.query(`select data,updated_at from app_state where id=$1`,[stateId(division)]);
   // Safe one-time migration path: Open Men can read the old Rob's Training master if Freshwater Open Men is not seeded yet.
   if(!q.rowCount&&division==="open-men")q=await pool.query(`select data,updated_at from app_state where id='master'`);
   if(!q.rowCount)return send(res,404,{error:"No program found for this division"});
   return send(res,200,{data:q.rows[0].data,updatedAt:q.rows[0].updated_at,division});
  }

  if(action==="create-invite"&&req.method==="POST"){
   if(!coach(req))return send(res,401,{error:"Coach key invalid"});
   const b=await body(req),a=b.athlete,div=slug(b.division||division);
   if(!a?.id||!a?.name)return send(res,400,{error:"Athlete required"});
   const token=crypto.randomBytes(24).toString("base64url"),sq=inviteSquad(div,a.squad);
   await pool.query(`update athlete_invites set active=false where athlete_id=$1 and squad like $2`,[a.id,`fw:${div}|%`]);
   await pool.query(`insert into athlete_invites(token,athlete_id,athlete_name,squad,active) values($1,$2,$3,$4,true)`,[token,a.id,a.name,sq]);
   return send(res,200,{token,division:div});
  }

  if(action==="revoke-athlete"&&req.method==="POST"){
   if(!coach(req))return send(res,401,{error:"Coach key invalid"});
   const b=await body(req),athleteId=String(b.athleteId||"").trim(),div=slug(b.division||division);
   if(!athleteId)return send(res,400,{error:"Athlete id required"});
   await pool.query(`update athlete_invites set active=false where athlete_id=$1 and squad like $2`,[athleteId,`fw:${div}|%`]);
   return send(res,200,{ok:true});
  }

  if(action==="invite-check"&&req.method==="GET"){
   const token=u.searchParams.get("token");
   const q=await pool.query(`select athlete_id,squad from athlete_invites where token=$1 and active=true`,[token]);
   if(!q.rowCount)return send(res,404,{error:"Invite unavailable"});
   const info=parseInviteSquad(q.rows[0].squad),st=await pool.query(`select data from app_state where id=$1`,[stateId(info.division)]);
   if(!st.rowCount||!Array.isArray(st.rows[0].data?.athletes)||!st.rows[0].data.athletes.some(a=>String(a.id)===String(q.rows[0].athlete_id)))return send(res,404,{error:"Athlete removed"});
   return send(res,200,{ok:true,division:info.division});
  }

  if(action==="invite"&&req.method==="GET"){
   const token=u.searchParams.get("token");
   const q=await pool.query(`select athlete_id,athlete_name,squad from athlete_invites where token=$1 and active=true`,[token]);
   if(!q.rowCount)return send(res,404,{error:"Invite unavailable"});
   const a=q.rows[0],info=parseInviteSquad(a.squad);
   let st=await pool.query(`select data from app_state where id=$1`,[stateId(info.division)]);
   if(!st.rowCount&&info.division==="open-men")st=await pool.query(`select data from app_state where id='master'`);
   if(!st.rowCount)return send(res,404,{error:"Program not synced yet"});
   const hist=await pool.query(`select kind,payload,created_at from athlete_submissions where athlete_id=$1 order by created_at desc limit 500`,[a.athlete_id]);
   return send(res,200,{athlete:{id:a.athlete_id,name:a.athlete_name,squad:info.squad},data:st.rows[0].data,history:hist.rows,division:info.division});
  }

  if(action==="athlete-submit"&&req.method==="POST"){
   const b=await body(req),q=await pool.query(`select athlete_id from athlete_invites where token=$1 and active=true`,[b.token]);
   if(!q.rowCount)return send(res,401,{error:"Invite unavailable"});
   await pool.query(`insert into athlete_submissions(athlete_id,kind,payload) values($1,$2,$3)`,[q.rows[0].athlete_id,b.kind||"unknown",b.payload||{}]);
   return send(res,200,{ok:true});
  }

  if(action==="coach-submissions"&&req.method==="GET"){
   if(!coach(req))return send(res,401,{error:"Coach key invalid"});
   const ids=await pool.query(`select distinct athlete_id from athlete_invites where squad like $1`,[`fw:${division}|%`]);
   const athleteIds=ids.rows.map(r=>r.athlete_id);
   if(!athleteIds.length)return send(res,200,{items:[]});
   const q=await pool.query(`select id,athlete_id,kind,payload,created_at from athlete_submissions where athlete_id=any($1) order by created_at desc limit 500`,[athleteIds]);
   return send(res,200,{items:q.rows});
  }

  return send(res,404,{error:"Unknown action"});
 }catch(e){console.error(e);return send(res,500,{error:"Server error"})}
};
