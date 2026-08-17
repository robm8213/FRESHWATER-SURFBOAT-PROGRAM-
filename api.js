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
  res.setHeader("Pragma","no-cache");
  res.setHeader("Expires","0");
  res.end(JSON.stringify(obj));
}

function coach(req){
  const saved=String(process.env.COACH_KEY||"").trim();
  const entered=String(req.headers["x-coach-key"]||"").trim();
  return !!saved&&entered===saved;
}

async function body(req){
  if(req.body && typeof req.body==="object") return req.body;
  if(typeof req.body==="string"){
    try{return JSON.parse(req.body)}catch{}
  }
  let raw="";
  for await(const chunk of req)raw+=chunk;
  if(!raw)return{};
  try{return JSON.parse(raw)}catch{return{}}
}

function slug(v,fallback="open-men"){
  return String(v||fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g,"-")
    .replace(/^-|-$/g,"")||fallback;
}

function teamSlug(v){
  return slug(v,"team-1");
}

function stateId(div,team){
  return `freshwater:${slug(div)}:${teamSlug(team)}`;
}

function legacyStateId(div){
  return "freshwater:"+slug(div);
}

function inviteSquad(div,team,squad){
  return `fw2:${slug(div)}|${teamSlug(team)}|${String(squad||"")}`;
}

function parseInviteSquad(v){
  const s=String(v||"");

  if(s.startsWith("fw2:")){
    const p=s.slice(4).split("|");
    return {
      division:slug(p[0]),
      team:teamSlug(p[1]),
      squad:p.slice(2).join("|")
    };
  }

  if(s.startsWith("fw:")){
    const p=s.indexOf("|");
    return {
      division:slug(p>=0?s.slice(3,p):s.slice(3)),
      team:"team-1",
      squad:p>=0?s.slice(p+1):""
    };
  }

  return {
    division:"open-men",
    team:"team-1",
    squad:s
  };
}

function commsScope(v){
  return String(v||"all")==="division"
    ?"division"
    :"all";
}

function featureId(div,team){
  return `features:${slug(div)}:${teamSlug(team)}`;
}

async function ensureFeatureTables(){
  await pool.query(`
    create table if not exists team_features(
      id text primary key,
      data jsonb not null default '{}'::jsonb,
      updated_at timestamptz default now()
    )
  `);
}

async function athleteNameMapForTeam(div,team){
  const patterns=[
    `fw2:${slug(div)}|${teamSlug(team)}|%`
  ];

  if(teamSlug(team)==="team-1"){
    patterns.push(`fw:${slug(div)}|%`);
  }

  const q=await pool.query(
    `select distinct on (athlete_id)
       athlete_id,
       athlete_name,
       squad
     from athlete_invites
     where active=true
       and squad like any($1)
     order by athlete_id`,
    [patterns]
  );

  return q.rows;
}

async function ensureClubTables(){
  await pool.query(`
    create table if not exists club_announcements(
      id bigserial primary key,
      author text not null,
      text text not null,
      created_at timestamptz default now()
    )
  `);

  await pool.query(`
    alter table club_announcements
    add column if not exists scope text default 'all'
  `);

  await pool.query(`
    alter table club_announcements
    add column if not exists division text default ''
  `);

  await pool.query(`
    create table if not exists club_media(
      id bigserial primary key,
      author text not null,
      type text not null,
      url text not null,
      caption text,
      created_at timestamptz default now()
    )
  `);

  await pool.query(`
    alter table club_media
    add column if not exists scope text default 'all'
  `);

  await pool.query(`
    alter table club_media
    add column if not exists division text default ''
  `);
}

async function getTeamState(div,team){
  let q=await pool.query(
    `select data,updated_at
     from app_state
     where id=$1`,
    [stateId(div,team)]
  );

  if(!q.rowCount && teamSlug(team)==="team-1"){
    q=await pool.query(
      `select data,updated_at
       from app_state
       where id=$1`,
      [legacyStateId(div)]
    );
  }

  if(
    !q.rowCount &&
    slug(div)==="open-men" &&
    teamSlug(team)==="team-1"
  ){
    q=await pool.query(
      `select data,updated_at
       from app_state
       where id='master'`
    );
  }

  return q;
}

module.exports=async(req,res)=>{
  try{
    const u=new URL(
      req.url,
      "https://freshwater.local"
    );

    const action=u.searchParams.get("action");

    const division=slug(
      u.searchParams.get("division")
    );

    const team=teamSlug(
      u.searchParams.get("team")
    );

    /*
    ==========================================
    CLUB ANNOUNCEMENTS
    ==========================================
    */

    if(
      action==="club-announcements" &&
      req.method==="GET"
    ){
      await ensureClubTables();

      const scope=commsScope(
        u.searchParams.get("scope")
      );

      const div=
        scope==="division"
          ?division
          :"";

      const q=
        scope==="division"

        ?await pool.query(
          `select
             id,
             author,
             text,
             scope,
             division,
             created_at
           from club_announcements
           where scope='division'
             and division=$1
           order by created_at desc
           limit 100`,
          [div]
        )

        :await pool.query(
          `select
             id,
             author,
             text,
             scope,
             division,
             created_at
           from club_announcements
           where coalesce(scope,'all')='all'
           order by created_at desc
           limit 100`
        );

      return send(
        res,
        200,
        {items:q.rows}
      );
    }

    if(
      action==="club-announcement" &&
      req.method==="POST"
    ){
      await ensureClubTables();

      if(!coach(req)){
        return send(
          res,
          401,
          {error:"Coach access required"}
        );
      }

      const b=await body(req);

      const author=
        String(
          b.author||
          "Freshwater Coach"
        ).slice(0,100);

      const text=
        String(
          b.text||""
        )
        .trim()
        .slice(0,3000);

      const scope=
        commsScope(
          b.scope
        );

      const div=
        scope==="division"
          ?slug(b.division)
          :"";

      if(!text){
        return send(
          res,
          400,
          {error:"Announcement required"}
        );
      }

      await pool.query(
        `insert into club_announcements(
           author,
           text,
           scope,
           division
         )
         values($1,$2,$3,$4)`,
        [
          author,
          text,
          scope,
          div
        ]
      );

      return send(
        res,
        200,
        {
          ok:true,
          scope,
          division:div
        }
      );
    }

    /*
    ==========================================
    CLUB MEDIA
    ==========================================
    */

    if(
      action==="club-media" &&
      req.method==="GET"
    ){
      await ensureClubTables();

      const scope=
        commsScope(
          u.searchParams.get("scope")
        );

      const div=
        scope==="division"
          ?division
          :"";

      const q=
        scope==="division"

        ?await pool.query(
          `select
             id,
             author,
             type,
             url,
             caption,
             scope,
             division,
             created_at
           from club_media
           where scope='division'
             and division=$1
           order by created_at desc
           limit 200`,
          [div]
        )

        :await pool.query(
          `select
             id,
             author,
             type,
             url,
             caption,
             scope,
             division,
             created_at
           from club_media
           where coalesce(scope,'all')='all'
           order by created_at desc
           limit 200`
        );

      return send(
        res,
        200,
        {items:q.rows}
      );
    }

    if(
      action==="club-media-add" &&
      req.method==="POST"
    ){
      await ensureClubTables();

      if(!coach(req)){
        return send(
          res,
          401,
          {error:"Coach access required"}
        );
      }

      const b=await body(req);

      const author=
        String(
          b.author||
          "Freshwater Coach"
        ).slice(0,100);

      const type=
        b.type==="video"
          ?"video"
          :"photo";

      const url=
        String(
          b.url||""
        )
        .trim()
        .slice(0,2000);

      const caption=
        String(
          b.caption||""
        ).slice(0,500);

      const scope=
        commsScope(
          b.scope
        );

      const div=
        scope==="division"
          ?slug(b.division)
          :"";

      if(!/^https?:\/\//i.test(url)){
        return send(
          res,
          400,
          {error:"Valid media URL required"}
        );
      }

      await pool.query(
        `insert into club_media(
           author,
           type,
           url,
           caption,
           scope,
           division
         )
         values($1,$2,$3,$4,$5,$6)`,
        [
          author,
          type,
          url,
          caption,
          scope,
          div
        ]
      );

      return send(
        res,
        200,
        {
          ok:true,
          scope,
          division:div
        }
      );
    }

    /*
    ==========================================
    COACH VERIFY
    ==========================================
    */

    if(
      action==="coach-verify" &&
      req.method==="GET"
    ){
      if(!coach(req)){
        return send(
          res,
          401,
          {error:"Coach key invalid"}
        );
      }

      return send(
        res,
        200,
        {ok:true}
      );
    }

    /*
    ==========================================
    COACH PROGRAM SYNC
    ==========================================
    */

    if(
      action==="coach-sync" &&
      req.method==="POST"
    ){
      if(!coach(req)){
        return send(
          res,
          401,
          {error:"Coach key invalid"}
        );
      }

      const b=await body(req);

      const div=
        slug(
          b.division||
          division
        );

      const tm=
        teamSlug(
          b.team||
          team
        );

      await pool.query(
        `insert into app_state(
           id,
           data,
           updated_at
         )
         values($1,$2,now())
         on conflict(id)
         do update set
           data=excluded.data,
           updated_at=now()`,
        [
          stateId(div,tm),
          b.data||{}
        ]
      );

      return send(
        res,
        200,
        {
          ok:true,
          division:div,
          team:tm
        }
      );
    }

    /*
    ==========================================
    LOAD COACH TEAM PROGRAM
    ==========================================
    */

    if(
      action==="coach-state" &&
      req.method==="GET"
    ){
      if(!coach(req)){
        return send(
          res,
          401,
          {error:"Coach key invalid"}
        );
      }

      const q=
        await getTeamState(
          division,
          team
        );

      if(!q.rowCount){
        return send(
          res,
          404,
          {error:"No program found for this team"}
        );
      }

      return send(
        res,
        200,
        {
          data:q.rows[0].data,
          updatedAt:q.rows[0].updated_at,
          division,
          team
        }
      );
    }

    /*
    ==========================================
    CREATE ATHLETE INVITE
    ==========================================
    */

    if(
      action==="create-invite" &&
      req.method==="POST"
    ){
      if(!coach(req)){
        return send(
          res,
          401,
          {error:"Coach key invalid"}
        );
      }

      const b=await body(req);

      const a=b.athlete;

      const div=
        slug(
          b.division||
          division
        );

      const tm=
        teamSlug(
          b.team||
          team
        );

      if(!a?.id||!a?.name){
        return send(
          res,
          400,
          {error:"Athlete required"}
        );
      }

      const token=
        crypto
        .randomBytes(24)
        .toString("base64url");

      const sq=
        inviteSquad(
          div,
          tm,
          a.squad
        );

      await pool.query(
        `update athlete_invites
         set active=false
         where athlete_id=$1
           and (
             squad like $2
             or squad like $3
           )`,
        [
          a.id,
          `fw2:${div}|${tm}|%`,
          tm==="team-1"
            ?`fw:${div}|%`
            :"__never__"
        ]
      );

      await pool.query(
        `insert into athlete_invites(
           token,
           athlete_id,
           athlete_name,
           squad,
           active
         )
         values($1,$2,$3,$4,true)`,
        [
          token,
          a.id,
          a.name,
          sq
        ]
      );

      return send(
        res,
        200,
        {
          token,
          division:div,
          team:tm
        }
      );
    }

    /*
    ==========================================
    REVOKE ATHLETE
    ==========================================
    */

    if(
      action==="revoke-athlete" &&
      req.method==="POST"
    ){
      if(!coach(req)){
        return send(
          res,
          401,
          {error:"Coach key invalid"}
        );
      }

      const b=await body(req);

      const athleteId=
        String(
          b.athleteId||""
        ).trim();

      const div=
        slug(
          b.division||
          division
        );

      const tm=
        teamSlug(
          b.team||
          team
        );

      if(!athleteId){
        return send(
          res,
          400,
          {error:"Athlete id required"}
        );
      }

      await pool.query(
        `update athlete_invites
         set active=false
         where athlete_id=$1
           and (
             squad like $2
             or squad like $3
           )`,
        [
          athleteId,
          `fw2:${div}|${tm}|%`,
          tm==="team-1"
            ?`fw:${div}|%`
            :"__never__"
        ]
      );

      return send(
        res,
        200,
        {ok:true}
      );
    }

    /*
    ==========================================
    ATHLETE INVITE CHECK
    ==========================================
    */

    if(
      action==="invite-check" &&
      req.method==="GET"
    ){
      const token=
        u.searchParams.get("token");

      const q=
        await pool.query(
          `select
             athlete_id,
             squad
           from athlete_invites
           where token=$1
             and active=true`,
          [token]
        );

      if(!q.rowCount){
        return send(
          res,
          404,
          {error:"Invite unavailable"}
        );
      }

      const info=
        parseInviteSquad(
          q.rows[0].squad
        );

      const st=
        await getTeamState(
          info.division,
          info.team
        );

      if(
        !st.rowCount ||
        !Array.isArray(
          st.rows[0].data?.athletes
        ) ||
        !st.rows[0].data.athletes.some(
          a=>
            String(a.id)===
            String(q.rows[0].athlete_id)
        )
      ){
        return send(
          res,
          404,
          {error:"Athlete removed"}
        );
      }

      return send(
        res,
        200,
        {
          ok:true,
          division:info.division,
          team:info.team
        }
      );
    }

    /*
    ==========================================
    ATHLETE PERSONAL LINK
    ==========================================
    */

    if(
      action==="invite" &&
      req.method==="GET"
    ){
      const token=
        u.searchParams.get("token");

      const q=
        await pool.query(
          `select
             athlete_id,
             athlete_name,
             squad
           from athlete_invites
           where token=$1
             and active=true`,
          [token]
        );

      if(!q.rowCount){
        return send(
          res,
          404,
          {error:"Invite unavailable"}
        );
      }

      const a=q.rows[0];

      const info=
        parseInviteSquad(
          a.squad
        );

      const st=
        await getTeamState(
          info.division,
          info.team
        );

      if(!st.rowCount){
        return send(
          res,
          404,
          {error:"Program not synced yet"}
        );
      }

      const hist=
        await pool.query(
          `select
             kind,
             payload,
             created_at
           from athlete_submissions
           where athlete_id=$1
           order by created_at desc
           limit 500`,
          [a.athlete_id]
        );

      return send(
        res,
        200,
        {
          athlete:{
            id:a.athlete_id,
            name:a.athlete_name,
            squad:info.squad
          },
          data:st.rows[0].data,
          history:hist.rows,
          division:info.division,
          team:info.team
        }
      );
    }

    /*
    ==========================================
    ATHLETE SUBMIT RESULTS
    ==========================================
    */

    if(
      action==="athlete-submit" &&
      req.method==="POST"
    ){
      const b=await body(req);

      const q=
        await pool.query(
          `select athlete_id
           from athlete_invites
           where token=$1
             and active=true`,
          [b.token]
        );

      if(!q.rowCount){
        return send(
          res,
          401,
          {error:"Invite unavailable"}
        );
      }

      await pool.query(
        `insert into athlete_submissions(
           athlete_id,
           kind,
           payload
         )
         values($1,$2,$3)`,
        [
          q.rows[0].athlete_id,
          b.kind||"unknown",
          b.payload||{}
        ]
      );

      return send(
        res,
        200,
        {ok:true}
      );
    }

    /*
    ==========================================
    COACH READ ATHLETE SUBMISSIONS
    ==========================================
    */

    if(
      action==="coach-submissions" &&
      req.method==="GET"
    ){
      if(!coach(req)){
        return send(
          res,
          401,
          {error:"Coach key invalid"}
        );
      }

      const patterns=[
        `fw2:${division}|${team}|%`
      ];

      if(team==="team-1"){
        patterns.push(
          `fw:${division}|%`
        );
      }

      const ids=
        await pool.query(
          `select distinct athlete_id
           from athlete_invites
           where squad like any($1)`,
          [patterns]
        );

      const athleteIds=
        ids.rows.map(
          r=>r.athlete_id
        );

      if(!athleteIds.length){
        return send(
          res,
          200,
          {items:[]}
        );
      }

      const q=
        await pool.query(
          `select
             id,
             athlete_id,
             kind,
             payload,
             created_at
           from athlete_submissions
           where athlete_id=any($1)
           order by created_at desc
           limit 500`,
          [athleteIds]
        );

      return send(
        res,
        200,
        {items:q.rows}
      );
    }

    /*
    ==========================================
    SHARED TEAM FEATURES
    Attendance / Templates / Archive /
    Permissions / Activity
    ==========================================
    */

    if(
      action==="team-features" &&
      req.method==="GET"
    ){
      if(!coach(req)){
        return send(
          res,
          401,
          {error:"Coach key invalid"}
        );
      }

      await ensureFeatureTables();

      const q=
        await pool.query(
          `select
             data,
             updated_at
           from team_features
           where id=$1`,
          [
            featureId(
              division,
              team
            )
          ]
        );

      const roster=
        await athleteNameMapForTeam(
          division,
          team
        );

      const athleteIds=
        roster.map(
          r=>String(r.athlete_id)
        );

      let submissions=[];

      if(athleteIds.length){
        const h=
          await pool.query(
            `select
               athlete_id,
               kind,
               payload,
               created_at
             from athlete_submissions
             where athlete_id=any($1)
               and kind=any($2)
             order by created_at asc`,
            [
              athleteIds,
              [
                "availability",
                "carnival-availability",
                "notification-prefs"
              ]
            ]
          );

        const names=
          Object.fromEntries(
            roster.map(
              r=>[
                String(r.athlete_id),
                r.athlete_name
              ]
            )
          );

        submissions=
          h.rows.map(
            x=>({
              ...x,
              athlete_name:
                names[
                  String(x.athlete_id)
                ]||
                "Athlete"
            })
          );
      }

      return send(
        res,
        200,
        {
          data:
            q.rowCount
              ?q.rows[0].data
              :{},
          updatedAt:
            q.rowCount
              ?q.rows[0].updated_at
              :null,
          submissions,
          division,
          team
        }
      );
    }

    if(
      action==="team-features" &&
      req.method==="POST"
    ){
      if(!coach(req)){
        return send(
          res,
          401,
          {error:"Coach key invalid"}
        );
      }

      await ensureFeatureTables();

      const b=await body(req);

      const div=
        slug(
          b.division||
          division
        );

      const tm=
        teamSlug(
          b.team||
          team
        );

      await pool.query(
        `insert into team_features(
           id,
           data,
           updated_at
         )
         values($1,$2,now())
         on conflict(id)
         do update set
           data=excluded.data,
           updated_at=now()`,
        [
          featureId(div,tm),
          b.data||{}
        ]
      );

      return send(
        res,
        200,
        {
          ok:true,
          division:div,
          team:tm
        }
      );
    }

    /*
    ==========================================
    ATHLETE SHARED FEATURE SUBMISSION
    ==========================================
    */

    if(
      action==="athlete-feature" &&
      req.method==="POST"
    ){
      const b=await body(req);

      const allowed=
        new Set([
          "availability",
          "carnival-availability",
          "notification-prefs"
        ]);

      if(
        !allowed.has(
          String(
            b.kind||""
          )
        )
      ){
        return send(
          res,
          400,
          {error:"Unsupported feature"}
        );
      }

      const q=
        await pool.query(
          `select athlete_id
           from athlete_invites
           where token=$1
             and active=true`,
          [b.token]
        );

      if(!q.rowCount){
        return send(
          res,
          401,
          {error:"Invite unavailable"}
        );
      }

      await pool.query(
        `insert into athlete_submissions(
           athlete_id,
           kind,
           payload
         )
         values($1,$2,$3)`,
        [
          q.rows[0].athlete_id,
          b.kind,
          b.payload||{}
        ]
      );

      return send(
        res,
        200,
        {ok:true}
      );
    }

    /*
    ==========================================
    ATHLETE LOAD SHARED FEATURES
    ==========================================
    */

    if(
      action==="athlete-features" &&
      req.method==="GET"
    ){
      const token=
        u.searchParams.get("token");

      const q=
        await pool.query(
          `select
             athlete_id,
             athlete_name,
             squad
           from athlete_invites
           where token=$1
             and active=true`,
          [token]
        );

      if(!q.rowCount){
        return send(
          res,
          401,
          {error:"Invite unavailable"}
        );
      }

      const a=q.rows[0];

      const info=
        parseInviteSquad(
          a.squad
        );

      const h=
        await pool.query(
          `select
             kind,
             payload,
             created_at
           from athlete_submissions
           where athlete_id=$1
             and kind=any($2)
           order by created_at asc`,
          [
            a.athlete_id,
            [
              "availability",
              "carnival-availability",
              "notification-prefs"
            ]
          ]
        );

      return send(
        res,
        200,
        {
          athlete:{
            id:a.athlete_id,
            name:a.athlete_name
          },
          division:info.division,
          team:info.team,
          items:h.rows
        }
      );
    }

    /*
    ==========================================
    UNKNOWN ACTION
    ==========================================
    */

    return send(
      res,
      404,
      {error:"Unknown action"}
    );

  }catch(e){
    console.error(e);

    return send(
      res,
      500,
      {error:"Server error"}
    );
  }
};
