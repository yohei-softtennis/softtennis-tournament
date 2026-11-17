'use strict';
/*
 * ソフトテニス大会進行表（独立Webサービス版）
 * Node.js 標準機能のみで動作します（外部パッケージ不要）。
 * 起動: node server.js   （ポートは環境変数 PORT、なければ 3000）
 * データは data.json に保存されます（初回起動時に自動生成）。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
// 永続ボリュームがある環境（Railway等）ではそちらに保存し、再起動・再デプロイでもデータを残す。
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');

/* ---------------- データ保存 ---------------- */
function initialData() { return { passwordHash: null, tournaments: [] }; }
function loadData() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (typeof d !== 'object' || d === null) return initialData();
    if (!('passwordHash' in d)) d.passwordHash = null;
    if (!Array.isArray(d.tournaments)) d.tournaments = [];
    // 旧形式（単一大会）からの移行
    if (d.tournament) {
      const t = d.tournament;
      if (!t.id) t.id = 'main';
      if (!d.tournaments.some((x) => x && x.id === t.id)) d.tournaments.push(t);
      delete d.tournament;
    }
    d.tournaments.forEach((t, i) => { if (t && !t.id) t.id = 't' + (i + 1); if (t && t.playing) { for (const k of Object.keys(t.playing)) { if (k.startsWith('br:') && t.playing[k] === true) delete t.playing[k]; } } });
    return d;
  } catch (e) { return initialData(); }
}
function saveData() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}
let data = loadData();
saveData();

/* ---------------- パスワード認証 ---------------- */
const tokens = new Set(); // ログイン中トークン（メモリ保持。再起動したら再ログイン）
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return salt + ':' + h;
}
function verifyPassword(pw, stored) {
  try {
    const parts = String(stored).split(':');
    if (parts.length !== 2) return false;
    const h = crypto.scryptSync(String(pw), parts[0], 64);
    const orig = Buffer.from(parts[1], 'hex');
    return h.length === orig.length && crypto.timingSafeEqual(h, orig);
  } catch (e) { return false; }
}
function newToken() {
  const t = crypto.randomBytes(24).toString('hex');
  tokens.add(t);
  return t;
}
function isAuthed(req) {
  const t = req.headers['x-admin-token'];
  return !!t && tokens.has(t);
}

/* ---------------- 共通ロジック（ブラウザとサーバーで共用） ----------------
 * 注意: この文字列はそのままブラウザへも配信されます。
 * テンプレートリテラル記号（バッククォートと ${ }）は使わないこと。 */
const SHARED = [
"function esc(s){return String(s==null?'':s).replace(/[&<>\"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c];});}",
"function nextPow2(n){var p=1;while(p<n)p*=2;return p;}",
"function seedPositions(size){var arr=[0,1];while(arr.length<size){var n=arr.length*2;var next=[];for(var i=0;i<arr.length;i++){next.push(arr[i]);next.push(n-1-arr[i]);}arr=next;}return arr;}",
"function pairById(t,id){for(var i=0;i<t.pairs.length;i++){if(t.pairs[i].id===id)return t.pairs[i];}return null;}",
"function registeredPairs(t){return t.pairs.filter(function(p){return p.name&&p.name.trim()!=='';});}",
"function leagueCount(t){var N=t.pairCount;var L=Math.max(1,Math.ceil(N/Math.max(1,t.pairsPerLeague)));if(N>5){while(L>1&&Math.floor(N/L)<3)L--;}return L;}",
"function leagueMatchList(ids){",
"  if(ids.length<2)return [];",
"  var pos={};ids.forEach(function(id,i){pos[id]=i;});",
"  var arr=ids.slice();if(arr.length%2===1)arr.push(null);",
"  var n=arr.length;var cur=arr.slice();var ms=[];",
"  for(var round=0;round<n-1;round++){",
"    for(var i=0;i<n/2;i++){var x=cur[i],y=cur[n-1-i];if(x!=null&&y!=null){var a=pos[x]<pos[y]?x:y;var b=(a===x)?y:x;ms.push({a:a,b:b,key:a+'|'+b});}}",
"    var next=[cur[0],cur[n-1]];for(var k=1;k<n-1;k++)next.push(cur[k]);cur=next;",
"  }",
"  return ms;",
"}",
"function computeStandings(t,ids){",
"  var rows={};ids.forEach(function(id){rows[id]={id:id,w:0,l:0,gf:0,ga:0,diff:0};});",
"  var ms=leagueMatchList(ids);",
"  ms.forEach(function(m){var sc=t.leagueScores[m.key];if(!sc)return;",
"    rows[m.a].gf+=sc.ga;rows[m.a].ga+=sc.gb;rows[m.b].gf+=sc.gb;rows[m.b].ga+=sc.ga;",
"    if(sc.ga>sc.gb){rows[m.a].w++;rows[m.b].l++;}else if(sc.gb>sc.ga){rows[m.b].w++;rows[m.a].l++;}});",
"  var arr=ids.map(function(id){return rows[id];});",
"  arr.forEach(function(r){r.diff=r.gf-r.ga;});",
"  function h2h(x,y){for(var k=0;k<ms.length;k++){var m=ms[k];if((m.a===x.id&&m.b===y.id)||(m.a===y.id&&m.b===x.id)){var sc=t.leagueScores[m.key];if(!sc)return 0;var xg=(m.a===x.id)?sc.ga:sc.gb;var yg=(m.a===x.id)?sc.gb:sc.ga;if(xg>yg)return -1;if(yg>xg)return 1;return 0;}}return 0;}",
"  arr.sort(function(x,y){if(y.w!==x.w)return y.w-x.w;if(y.diff!==x.diff)return y.diff-x.diff;if(y.gf!==x.gf)return y.gf-x.gf;return h2h(x,y);});",
"  return arr;}",
"function computeBracket(slots,scores){",
"  var rounds=[];var current=slots.slice();var r=0;",
"  while(current.length>=2){",
"    var matches=[];",
"    for(var i=0;i<current.length;i+=2){",
"      var a=current[i],b=current[i+1];var key=r+'-'+(i/2);",
"      var ga=null,gb=null,winner=null;var sc=scores[key];",
"      if(a==='BYE'&&b==='BYE'){winner='BYE';}",
"      else if(a==='BYE'){winner=b;}",
"      else if(b==='BYE'){winner=a;}",
"      else if(a!=null&&b!=null){if(sc&&sc.a===a&&sc.b===b){ga=sc.ga;gb=sc.gb;if(ga>gb)winner=a;else if(gb>ga)winner=b;}}",
"      matches.push({a:a,b:b,ga:ga,gb:gb,winner:winner,key:key});",
"    }",
"    rounds.push(matches);",
"    current=matches.map(function(m){return m.winner;});",
"    r++;",
"  }",
"  return rounds;}",
"function circledNum(n){var c='①②③④⑤⑥⑦⑧⑨';return n>=1&&n<=9?c.charAt(n-1):String(n);}",
"function annotateLabels(rounds,slotSrc){",
"  rounds.forEach(function(matches,r){",
"    matches.forEach(function(m,i){",
"      if(m.a==null)m.la=(r===0)?(slotSrc?slotSrc[i*2]:null):(roundName(rounds.length,r-1)+circledNum(i*2+1)+'の勝者');",
"      if(m.b==null)m.lb=(r===0)?(slotSrc?slotSrc[i*2+1]:null):(roundName(rounds.length,r-1)+circledNum(i*2+2)+'の勝者');",
"    });",
"  });",
"}",
"function roundName(total,r){var fe=total-1-r;if(fe===0)return '決勝';if(fe===1)return '準決勝';if(fe===2)return '準々決勝';return (r+1)+'回戦';}",
"function buildView(t){",
"  if(!t)return null;",
"  var view={leagues:[],bracket:null,qualifiers:[]};",
"  if(t.format==='league_tournament'){",
"    var L=Math.max(leagueCount(t),(t.leagueAssignment||[]).length);",
"    for(var li=0;li<L;li++){",
"      var ids=(t.leagueAssignment&&t.leagueAssignment[li])||[];",
"      var st=computeStandings(t,ids);",
"      var ms=leagueMatchList(ids).map(function(m){var sc=t.leagueScores[m.key];return {a:m.a,b:m.b,key:m.key,ga:sc?sc.ga:null,gb:sc?sc.gb:null,winner:sc?(sc.ga>sc.gb?m.a:(sc.gb>sc.ga?m.b:null)):null};});",
"      view.leagues.push({index:li,pairIds:ids,standings:st,matches:ms});",
"    }",
"    var ordered=[];var srcs=[];",
"    for(var rank=0;rank<t.advanceCount;rank++){view.leagues.forEach(function(lg){var done=lg.matches.length>0&&lg.matches.every(function(m){return m.ga!=null&&m.gb!=null;});ordered.push(done&&lg.standings[rank]?lg.standings[rank].id:null);srcs.push(String.fromCharCode(65+lg.index)+'リーグ'+(rank+1)+'位');});}",
"    view.qualifiers=ordered;",
"    if(ordered.length===0){view.bracket={slots:[],rounds:[]};}",
"    else{var B=nextPow2(Math.max(2,ordered.length));var pos=seedPositions(B);var LC=view.leagues.length;",
"      var occ=pos.map(function(si){return si<ordered.length?{id:ordered[si],src:srcs[si],league:si%LC,rank:Math.floor(si/LC)}:{id:'BYE',src:null,league:-1,rank:99};});",
"      var bad=function(x,y){if(x.rank>90||y.rank>90)return 0;if(x.league===y.league)return 2;if(x.rank===y.rank)return 1;return 0;};",
"      for(var pass=0;pass<12;pass++){var improved=false;",
"        for(var i=0;i+1<occ.length;i+=2){var bi=bad(occ[i],occ[i+1]);if(bi===0)continue;",
"          for(var j=0;j+1<occ.length&&bi>0;j+=2){if(j===i)continue;var bj=bad(occ[j],occ[j+1]);",
"            for(var s1=0;s1<2&&bi>0;s1++){for(var s2=0;s2<2;s2++){var xi=(s1===0?i:i+1),xj=(s2===0?j:j+1);",
"              if(occ[xi].rank>90||occ[xj].rank>90)continue;",
"              if(occ[xi^1].rank>90||occ[xj^1].rank>90)continue;",
"              var tmp=occ[xi];occ[xi]=occ[xj];occ[xj]=tmp;",
"              var ni=bad(occ[i],occ[i+1]),nj=bad(occ[j],occ[j+1]);",
"              if(ni+nj<bi+bj&&(ni!==2||bi===2)&&(nj!==2||bj===2)){bi=ni;improved=true;}",
"              else{var tmp2=occ[xi];occ[xi]=occ[xj];occ[xj]=tmp2;}",
"            }}",
"          }",
"        }",
"        if(!improved)break;",
"      }",
"      var slots=occ.map(function(o){return o.id;});var slotSrc=occ.map(function(o){return o.src;});",
"      var rounds=computeBracket(slots,t.bracketScores);annotateLabels(rounds,slotSrc);view.bracket={slots:slots,rounds:rounds};}",
"  }else{",
"    var slots=t.bracketSlots||[];",
"    var roundsT=computeBracket(slots,t.bracketScores);annotateLabels(roundsT,null);",
"    view.bracket={slots:slots,rounds:roundsT};",
"  }",
"  return view;}",
"function shuffleArr(a){for(var i=a.length-1;i>0;i--){var j=Math.floor(Math.random()*(i+1));var tmp=a[i];a[i]=a[j];a[j]=tmp;}return a;}",
"function leaguePenalty(t,leagues){",
"  var pen=0;",
"  leagues.forEach(function(lg){",
"    var teamCount={},seedCount=0;",
"    lg.forEach(function(id){var p=pairById(t,id);if(!p)return;if(p.team)teamCount[p.team]=(teamCount[p.team]||0)+1;if(p.seed)seedCount++;});",
"    if(t.separateTeams){for(var k in teamCount){if(teamCount[k]>1)pen+=(teamCount[k]-1)*10;}}",
"    if(t.separateSeeds){if(seedCount>1)pen+=(seedCount-1)*5;}",
"  });",
"  return pen;}",
"function assignLeagues(t){",
"  var pairs=registeredPairs(t);var L=leagueCount(t);",
"  var best=null,bestPen=Infinity;",
"  for(var iter=0;iter<400;iter++){",
"    var seeds=shuffleArr(pairs.filter(function(p){return p.seed;}).slice());",
"    var rest=shuffleArr(pairs.filter(function(p){return !p.seed;}).slice());",
"    var order=seeds.concat(rest);var leagues=[];for(var i=0;i<L;i++)leagues.push([]);",
"    var offset=L>1?Math.floor(Math.random()*L):0;",
"    order.forEach(function(p,idx){leagues[(idx+offset)%L].push(p.id);});",
"    var pen=leaguePenalty(t,leagues);",
"    if(pen<bestPen){bestPen=pen;best=leagues;if(pen===0)break;}",
"  }",
"  t.leagueAssignment=best;pruneScores(t);}",
"function bracketPenalty(t,slots){",
"  var pen=0;var B=slots.length;var sec=Math.max(2,B/4);var i,j;",
"  function teamOf(v){var p=(typeof v==='number')?pairById(t,v):null;return p?p.team:null;}",
"  function seedOf(v){var p=(typeof v==='number')?pairById(t,v):null;return p?!!p.seed:false;}",
"  if(t.separateTeams){",
"    for(i=0;i+1<B;i+=2){var t1=teamOf(slots[i]),t2=teamOf(slots[i+1]);if(t1&&t2&&t1===t2)pen+=20;}",
"    for(i=0;i<B;i+=sec){var counts={};for(j=i;j<Math.min(i+sec,B);j++){var tm=teamOf(slots[j]);if(tm)counts[tm]=(counts[tm]||0)+1;}for(var k in counts){if(counts[k]>1)pen+=(counts[k]-1)*4;}}",
"  }",
"  if(t.separateSeeds){",
"    for(i=0;i<B;i+=sec){var c=0;for(j=i;j<Math.min(i+sec,B);j++){if(seedOf(slots[j]))c++;}if(c>1)pen+=(c-1)*5;}",
"  }",
"  return pen;}",
"function assignBracket(t){",
"  var B=nextPow2(Math.max(2,t.pairCount));",
"  var fill=[];var i;for(i=0;i<B;i+=2)fill.push(i);for(i=1;i<B;i+=2)fill.push(i);",
"  var pairs=registeredPairs(t);",
"  var filler=(pairs.length>=t.pairCount)?'BYE':null;",
"  var best=null,bestPen=Infinity;",
"  for(var iter=0;iter<400;iter++){",
"    var ps=shuffleArr(pairs.slice());",
"    var slots=[];for(i=0;i<B;i++)slots.push(filler);",
"    ps.forEach(function(p,idx){if(idx<fill.length)slots[fill[idx]]=p.id;});",
"    var pen=bracketPenalty(t,slots);",
"    if(pen<bestPen){bestPen=pen;best=slots;if(pen===0)break;}",
"  }",
"  t.bracketSlots=best;}",
"function pruneScores(t){",
"  var ids={};t.pairs.forEach(function(p){ids[p.id]=true;});",
"  for(var k in t.leagueScores){var parts=k.split('|');if(!ids[parts[0]]||!ids[parts[1]])delete t.leagueScores[k];}",
"  if(t.format==='league_tournament'){",
"    var valid={};",
"    (t.leagueAssignment||[]).forEach(function(lg){leagueMatchList(lg).forEach(function(m){valid[m.key]=true;});});",
"    for(var k2 in t.leagueScores){if(!valid[k2])delete t.leagueScores[k2];}",
"  }",
"  if(t.playing){for(var pk in t.playing){if(pk.indexOf('br:')===0){var pv=t.playing[pk];if(!pv||typeof pv!=='object')delete t.playing[pk];}}}",
"}",
"function slotLabel(t,v){if(v==='BYE')return '不戦勝（BYE）';if(v==null)return '未定';var p=pairById(t,v);return p?(p.name||'（未入力）'):'未定';}",
"function slotTeam(t,v){if(typeof v==='number'){var p=pairById(t,v);return (p&&p.team)?p.team:'';}return '';}",
"function matchQueue(t,v){",
"  var q=[];",
"  var maxM=0;(v.leagues||[]).forEach(function(lg){if(lg.matches.length>maxM)maxM=lg.matches.length;});",
"  for(var mi=0;mi<maxM;mi++){(v.leagues||[]).forEach(function(lg){var m=lg.matches[mi];if(m)q.push({type:'lg',key:'lg:'+m.key,a:m.a,b:m.b,ga:m.ga,gb:m.gb,finished:(m.ga!=null&&m.gb!=null),playing:!!(t.playing&&t.playing['lg:'+m.key]),label:String.fromCharCode(65+lg.index)+'リーグ'});});}",
"  if(v.bracket&&v.bracket.rounds){v.bracket.rounds.forEach(function(matches,r){matches.forEach(function(m,i){if(m.a!=null&&m.b!=null&&m.a!=='BYE'&&m.b!=='BYE'){var pf=t.playing?t.playing['br:'+m.key]:null;var isp=(!!pf&&typeof pf==='object'&&pf.a===m.a&&pf.b===m.b);q.push({type:'br',key:'br:'+m.key,a:m.a,b:m.b,ga:m.ga,gb:m.gb,finished:m.winner!=null,playing:isp,label:roundName(v.bracket.rounds.length,r)+circledNum(i+1)});}});});}",
"  var cnt={};q.forEach(function(x){if(x.playing&&!x.finished){cnt[x.a]=(cnt[x.a]||0)+1;cnt[x.b]=(cnt[x.b]||0)+1;}});",
"  q.forEach(function(x){if(x.playing&&!x.finished&&(cnt[x.a]>1||cnt[x.b]>1))x.conflict=true;});",
"  return q;",
"}",
"function callLists(t,v){",
"  var q=matchQueue(t,v);",
"  var playing=q.filter(function(x){return x.playing&&!x.finished;});",
"  var rest=q.filter(function(x){return !x.playing&&!x.finished;});",
"  var n=(typeof t.waitCount==='number')?t.waitCount:3;if(n<0)n=0;",
"  var busy={};playing.forEach(function(x){busy[x.a]=true;busy[x.b]=true;});",
"  var waiting=[],upcoming=[];",
"  rest.forEach(function(x){if(waiting.length<n&&!busy[x.a]&&!busy[x.b]){waiting.push(x);busy[x.a]=true;busy[x.b]=true;}else{upcoming.push(x);}});",
"  return {playing:playing,waiting:waiting,upcoming:upcoming,queue:q,conflicts:playing.filter(function(x){return x.conflict;})};",
"}"
].join('\n');

const shared = new Function(
  SHARED + '\nreturn {esc:esc,nextPow2:nextPow2,seedPositions:seedPositions,pairById:pairById,' +
  'registeredPairs:registeredPairs,leagueCount:leagueCount,leagueMatchList:leagueMatchList,' +
  'computeStandings:computeStandings,computeBracket:computeBracket,roundName:roundName,' +
  'buildView:buildView,assignLeagues:assignLeagues,assignBracket:assignBracket,' +
  'matchQueue:matchQueue,callLists:callLists,' +
  'pruneScores:pruneScores,slotLabel:slotLabel,slotTeam:slotTeam};'
)();

/* ---------------- 画面（共通CSS） ---------------- */
const CSS = `
:root{--green:#178a4c;--dark:#0d5c31;--light:#eafaf1;--border:#cfe8d8;--gray:#5b6b60;}
*{box-sizing:border-box;}
body{margin:0;font-family:-apple-system,'Hiragino Kaku Gothic ProN','Noto Sans JP',sans-serif;background:#f4faf6;color:#17301f;}
header{background:var(--dark);color:#fff;padding:14px 16px;}
header h1{margin:0;font-size:27px;font-weight:800;letter-spacing:.02em;}
header .sub{font-size:12px;opacity:.85;margin-top:2px;}
main{max-width:980px;margin:0 auto;padding:14px 12px 40px;}
.card{background:#fff;border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:14px;}
.card h2{margin:0 0 10px;font-size:16px;color:var(--dark);border-left:5px solid var(--green);padding-left:8px;}
.card h3{margin:12px 0 6px;font-size:14px;color:var(--dark);}
table{border-collapse:collapse;width:100%;font-size:13px;}
th,td{border:1px solid var(--border);padding:5px 6px;text-align:center;}
th{background:var(--light);color:var(--dark);}
td.name,th.name{text-align:left;}
tr.qualify td{background:#f2fbf5;}
.rank1 td{font-weight:bold;}
.matchline{display:flex;align-items:center;gap:6px;padding:5px 2px;border-bottom:1px dashed #e2efe6;font-size:13px;flex-wrap:wrap;}
.matchline:last-child{border-bottom:none;}
.pairname{flex:1;min-width:90px;}
.pairname .team{display:block;font-size:11px;color:var(--gray);}
.score{font-weight:bold;font-size:15px;min-width:44px;text-align:center;}
.winner{color:var(--green);font-weight:bold;}
.winner .pairname,.winname{color:#0a7d2c;font-weight:800;}
.matchno{font-size:12px;font-weight:bold;color:var(--dark);margin-top:8px;}
.score .wnum{background:#1d9e4b;color:#fff;border-radius:50%;width:23px;height:23px;line-height:23px;display:inline-block;text-align:center;font-weight:800;}
.bmatch .row.win{background:#e6f6ec;border-radius:5px;}
.bmatch .row .sc.win{background:#1d9e4b;color:#fff;border-radius:50%;width:23px;height:23px;line-height:23px;text-align:center;font-weight:800;flex:none;}
.bracket{display:flex;gap:10px;overflow-x:auto;padding-bottom:6px;}
.round{flex:1;min-width:180px;}
.round h4{margin:0 0 8px;font-size:13px;color:#fff;background:var(--green);border-radius:6px;padding:4px 8px;text-align:center;}
.bmatch{border:1px solid var(--border);border-radius:8px;padding:7px 8px;margin-bottom:10px;background:#fff;font-size:12.5px;}
.bmatch .row{display:flex;justify-content:space-between;gap:6px;padding:2px 0;}
.bmatch .row .sc{font-weight:bold;min-width:16px;text-align:right;}
.bmatch .bye{color:var(--gray);}
.champ{font-size:15px;color:var(--dark);font-weight:bold;background:var(--light);border:1px solid var(--border);border-radius:8px;padding:10px;text-align:center;}
input[type=text],input[type=password],input[type=number],select{font-size:15px;padding:7px 8px;border:1px solid #b9d6c2;border-radius:7px;background:#fff;}
input[type=number]{width:64px;text-align:center;}
button{background:var(--green);color:#fff;border:none;border-radius:8px;padding:9px 14px;font-size:14px;cursor:pointer;}
button.sub{background:#fff;color:var(--dark);border:1px solid var(--green);}
button.danger{background:#b3261e;}
button:disabled{opacity:.5;}
.stepper{display:inline-flex;align-items:center;gap:6px;}
.stepper button{width:36px;height:36px;padding:0;font-size:18px;}
label.f{display:block;margin:10px 0 4px;font-size:13px;color:var(--dark);font-weight:bold;}
.hint{font-size:12px;color:var(--gray);}
.adminlink{text-align:center;padding:20px 0 28px;font-size:13px;}
.adminlink a{color:var(--dark);}
.printbar{text-align:right;margin:0 0 10px;}
.callbox{border:2px solid var(--green);background:#fbfefc;}
.ctx{display:block;font-size:11px;color:var(--gray);}
.matchline.conflict{background:#fdecea;border:1px solid #e57373;border-radius:6px;}
.alertbox{background:#fdecea;border:1px solid #e57373;color:#b3261e;border-radius:8px;padding:8px 10px;font-size:13px;font-weight:bold;margin:8px 0;}
.tswitch{display:flex;gap:8px;flex-wrap:wrap;align-items:center;}
.tswitch a{padding:6px 12px;border:1px solid var(--dark);border-radius:999px;color:var(--dark);text-decoration:none;font-size:13px;}
.tswitch a.cur{background:var(--dark);color:#fff;}
@media print{
  .printbar,.adminlink,.tswitch{display:none !important;}
  header{background:#fff;color:#000;border-bottom:2px solid #333;}
  body{background:#fff;}
  .card{box-shadow:none;border:1px solid #bbb;break-inside:avoid;}
  .bracket{overflow:visible;flex-wrap:wrap;}
}
.err{color:#b3261e;font-size:13px;}
.ok{color:var(--green);font-size:13px;}
.chips{display:flex;flex-wrap:wrap;gap:6px;min-height:38px;padding:6px;border:1px dashed var(--border);border-radius:8px;background:#fbfefc;}
.chip{display:inline-block;background:var(--light);border:1px solid var(--green);color:var(--dark);border-radius:16px;padding:5px 10px;font-size:12.5px;cursor:pointer;}
.chip small{color:var(--gray);}
.chip.sel{background:var(--green);color:#fff;}
.chip.sel small{color:#dff3e6;}
.chip.bye{background:#f0f0f0;border-color:#bbb;color:#666;cursor:pointer;}
.chip.empty{background:#fff;border-color:#ccc;color:#999;}
.scoreinput{width:46px !important;padding:5px 4px !important;}
.mtxwrap{overflow-x:auto;}
table.mtx{border-collapse:collapse;width:100%;}
table.mtx th,table.mtx td{border:1px solid #bbb;padding:4px 3px;text-align:center;font-size:13px;min-width:32px;background:#fff;}
table.mtx td.diag,table.mtx th.diag{background:linear-gradient(to top right,transparent calc(50% - 1px),#bbb calc(50% - 1px),#bbb calc(50% + 1px),transparent calc(50% + 1px));background-color:#f4f4f4;}
table.mtx .ord{display:block;font-size:10px;color:#999;text-align:left;line-height:1.1;}
table.mtx td.wl{font-weight:bold;white-space:nowrap;}
table.mtx td.qrk{color:var(--dark);font-weight:800;}
table.mtx input{width:32px !important;padding:3px 1px !important;font-size:13px;}
table.mtx .maru{display:inline-block;border:1.6px solid #c62828;color:#c62828;border-radius:50%;min-width:20px;line-height:20px;padding:0 2px;font-weight:800;}
.pairrow{display:flex;gap:6px;align-items:center;margin-bottom:6px;flex-wrap:wrap;}
.pairrow .no{width:22px;text-align:right;color:var(--gray);font-size:12px;}
.pairrow input[type=text]{flex:1;min-width:110px;}
.pairrow .teamin{flex:0.7;min-width:90px;}
.tabs{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;}
.tabs a{text-decoration:none;}
@media (max-width:600px){ .score{font-size:14px;} table{font-size:12px;} }
`;

/* ---------------- 閲覧ページ ---------------- */
const VIEWER_HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>大会進行表</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <h1 id="title">大会進行表</h1>
  <div class="sub" id="subtitle">読み込み中…</div>
</header>
<main id="app"></main>
<footer class="adminlink"><a href="/admin">管理者ページへ（パスワードが必要です）</a></footer>
<script>
${SHARED}
var state=null;
function pairName(t,id){var p=pairById(t,id);return p?esc(p.name||'（未入力）'):'未定';}
function pairTeam(t,id){var p=pairById(t,id);return (p&&p.team)?esc(p.team):'';}
function render(){
  var app=document.getElementById('app');
  var t=state&&state.tournament;
  if(!t){
    document.getElementById('title').textContent='大会進行表';
    document.getElementById('subtitle').textContent='大会はまだ作成されていません';
    app.innerHTML='<div class="card">大会の準備中です。しばらくお待ちください。</div>';
    return;
  }
  document.getElementById('title').textContent=t.name||'大会進行表';
  document.getElementById('subtitle').textContent=(t.format==='league_tournament'?'リーグ戦 → トーナメント':'トーナメント方式')+' ／ '+t.pairCount+'ペア ／ 最終更新 '+new Date().toLocaleTimeString('ja-JP');
  var v=state.view;
  var html='';
  if(state.list&&state.list.length>1){
    html+='<div class="card tswitch"><strong>大会：</strong>'+state.list.map(function(x){return '<a href="?id='+encodeURIComponent(x.id)+'"'+(t.id===x.id?' class="cur"':'')+'>'+esc(x.name||'（無題）')+'</a>';}).join('')+'</div>';
  }
  html+='<div class="printbar"><button onclick="window.print()">📄 結果をPDFで保存（印刷）</button></div>';
  var cl=callLists(t,v);
  if(cl.playing.length>0||cl.waiting.length>0){
    html+='<div class="card callbox"><h2>📣 呼び出し</h2>';
    html+='<div class="hint" style="margin-bottom:6px">コート数：'+((typeof t.courtCount==='number')?t.courtCount:4)+'面 ｜ 試合中 '+cl.playing.length+'試合</div>';
    function callRow(m,badge){
      return '<div style="margin:6px 0"><div class="ctx" style="font-size:12px;font-weight:bold;color:var(--dark)">'+badge+' '+esc(m.label)+'</div><div class="matchline'+(m.conflict?' conflict':'')+'"><span class="pairname">'+pairName(t,m.a)+'<span class="team">'+pairTeam(t,m.a)+'</span></span><span class="score">vs</span><span class="pairname" style="text-align:right">'+pairName(t,m.b)+'<span class="team">'+pairTeam(t,m.b)+'</span></span></div></div>';
    }
    if(cl.playing.length>0){html+='<h3>試合中</h3>';cl.playing.forEach(function(m){html+=callRow(m,'🟢');});}
    if(cl.waiting.length>0){html+='<h3>待機（呼び出し中）</h3>';cl.waiting.forEach(function(m,i){html+=callRow(m,'待機'+(i+1));});}
    if(cl.conflicts&&cl.conflicts.length>0){html+='<div class="alertbox">同じペアが複数の試合に入っています。大会本部にご確認ください。</div>';}
    html+='<div class="hint">待機の試合は、待機順に空いたコートへ入ります。</div></div>';
  }
  if(t.format==='league_tournament'){
    v.leagues.forEach(function(lg,li){
      html+='<div class="card"><h2>'+String.fromCharCode(65+li)+'リーグ</h2>';
      html+=leagueMatrixHtml(t,lg);
      html+='<div class="hint">セルの数字は、その行のペアの獲得ゲーム数です（丸囲みは勝ち）</div>';
      html+='<h3>順位表</h3><table><tr><th>順位</th><th class="name">ペア</th><th>勝</th><th>負</th><th>得</th><th>失</th><th>差</th></tr>';
      lg.standings.forEach(function(r,idx){
        html+='<tr class="'+(idx<t.advanceCount?'qualify':'')+(idx===0?' rank1':'')+'"><td>'+(idx+1)+'</td><td class="name">'+pairName(t,r.id)+(pairTeam(t,r.id)?' <small>（'+pairTeam(t,r.id)+'）</small>':'')+'</td><td>'+r.w+'</td><td>'+r.l+'</td><td>'+r.gf+'</td><td>'+r.ga+'</td><td>'+(r.diff>0?'+':'')+r.diff+'</td></tr>';
      });
      html+='</table><div class="hint">上位'+t.advanceCount+'ペアがトーナメントへ進出します（リーグの全試合が終わると確定します）</div>';
      html+='</div>';
    });
  }
  if(v.bracket&&v.bracket.rounds.length>0){
    html+='<div class="card"><h2>トーナメント表</h2><div class="bracket">';
    v.bracket.rounds.forEach(function(matches,r){
      html+='<div class="round"><h4>'+roundName(v.bracket.rounds.length,r)+'</h4>';
      matches.forEach(function(m){
        html+=bmatchHtml(t,m);
      });
      html+='</div>';
    });
    html+='</div>';
    var lastRound=v.bracket.rounds[v.bracket.rounds.length-1];
    if(lastRound.length===1&&lastRound[0].winner!=null&&lastRound[0].winner!=='BYE'){
      html+='<div class="champ">🏆 優勝：'+pairName(t,lastRound[0].winner)+(pairTeam(t,lastRound[0].winner)?'（'+pairTeam(t,lastRound[0].winner)+'）':'')+'</div>';
    }
    html+='</div>';
  }
  if(t.format==='tournament'){
    html+='<div class="card"><h2>参加ペア</h2>';
    registeredPairs(t).forEach(function(p){html+='<div class="matchline"><span class="pairname">'+esc(p.name)+(p.seed?' <small>（シード）</small>':'')+'<span class="team">'+esc(p.team||'')+'</span></span></div>';});
    html+='</div>';
  }
  app.innerHTML=html;
}
function leagueMatrixHtml(t,lg){
  var ids=lg.pairIds||[];
  var byKey={};lg.matches.forEach(function(m){byKey[m.key]=m;});
  var stById={};lg.standings.forEach(function(r,idx){stById[r.id]={w:r.w,l:r.l,rank:idx+1};});
  var ord={};lg.matches.forEach(function(m,i){ord[m.key]=i+1;});
  var h='<div class="mtxwrap"><table class="mtx"><tr><th class="name diag"></th>';
  ids.forEach(function(id,i){h+='<th>'+(i+1)+'</th>';});
  h+='<th>勝敗</th><th>順位</th></tr>';
  ids.forEach(function(rid,i){
    var st=stById[rid]||{w:0,l:0,rank:''};
    h+='<tr><td class="name">'+(i+1)+' '+pairName(t,rid)+(pairTeam(t,rid)?' <small>（'+pairTeam(t,rid)+'）</small>':'')+'</td>';
    ids.forEach(function(cid,j){
      if(i===j){h+='<td class="diag"></td>';return;}
      var key=(i<j)?(rid+'|'+cid):(cid+'|'+rid);
      var m=byKey[key];var cell='';
      if(m&&m.ga!=null){var rs=(m.a===rid)?m.ga:m.gb;var cs=(m.a===rid)?m.gb:m.ga;cell=(rs>cs)?('<span class="maru">'+rs+'</span>'):String(rs);}
      if(i<j&&m){cell='<span class="ord">'+circledNum(ord[key])+'</span>'+cell;}
      h+='<td>'+cell+'</td>';
    });
    h+='<td class="wl">'+st.w+' - '+st.l+'</td><td class="'+(st.rank&&st.rank<=t.advanceCount?'qrk':'')+'">'+st.rank+'</td></tr>';
  });
  h+='</table></div>';
  return h;
}
function bmatchHtml(t,m){
  function row(v,sc,isWin,label){
    if(v==='BYE')return '<div class="row bye"><span>不戦勝（BYE）</span><span class="sc"></span></div>';
    if(v==null)return '<div class="row bye"><span>'+(label?esc(label):'未定')+'</span><span class="sc"></span></div>';
    return '<div class="row'+(isWin?' win':'')+'"><span class="'+(isWin?'winname':'')+'">'+pairName(t,v)+(pairTeam(t,v)?' <small>（'+pairTeam(t,v)+'）</small>':'')+'</span><span class="sc'+(isWin?' win':'')+'">'+(sc==null?'':sc)+'</span></div>';
  }
  return '<div class="bmatch">'+row(m.a,m.ga,m.winner===m.a&&m.a!=null,m.la)+row(m.b,m.gb,m.winner===m.b&&m.b!=null,m.lb)+'</div>';
}
function load(){
  var tid=new URLSearchParams(location.search).get('id');
  fetch('/api/state'+(tid?('?id='+encodeURIComponent(tid)):'')).then(function(r){return r.json();}).then(function(d){state=d;render();}).catch(function(){});
}
load();
setInterval(load,30000);
</script>
</body>
</html>`;

/* ---------------- 管理者ページ ---------------- */
const ADMIN_HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>管理者ページ｜大会進行表</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <h1>管理者ページ</h1>
  <div class="sub">大会進行表の運営用ページです。<a href="/" style="color:#bff0d2">閲覧ページを開く</a></div>
</header>
<main id="app"></main>
<script>
${SHARED}
var token=localStorage.getItem('st_admin_token')||'';
var T=null;
var TLIST=[];
var DRAFT=false;
var sel=null;
var msg='';
function api(path,opts){
  opts=opts||{};opts.headers=opts.headers||{};
  if(token)opts.headers['x-admin-token']=token;
  if(opts.body&&typeof opts.body!=='string'){opts.body=JSON.stringify(opts.body);opts.headers['Content-Type']='application/json';}
  return fetch(path,opts);
}
function pairName(t,id){var p=pairById(t,id);return p?esc(p.name||'（未入力）'):'未定';}
function pairTeam(t,id){var p=pairById(t,id);return (p&&p.team)?esc(p.team):'';}
function showMsg(m,isErr){msg=(isErr?'<div class="err">':'<div class="ok">')+esc(m)+'</div>';var el=document.getElementById('msg');if(el)el.innerHTML=msg;}
function save(after){
  api('/api/admin/save',{method:'POST',body:{tournament:T}}).then(function(r){
    if(r.status===401){alert('ログインの有効期限が切れました。再度ログインしてください。');localStorage.removeItem('st_admin_token');token='';init();return;}
    return r.json();
  }).then(function(d){if(d&&d.ok){showMsg('保存しました');if(T){var ix=TLIST.findIndex(function(x){return x.id===T.id;});if(ix>=0)TLIST[ix]=T;else TLIST.push(T);}if(after)after();renderApp();}}).catch(function(){showMsg('保存に失敗しました',true);});
}
function init(){
  api('/api/auth/status').then(function(r){return r.json();}).then(function(d){
    if(!d.hasPassword){renderSetup();return;}
    if(!d.authed){renderLogin();return;}
    api('/api/admin/state').then(function(r){return r.json();}).then(function(s){TLIST=s.tournaments||[];if(T){var ix=TLIST.findIndex(function(x){return x.id===T.id;});T=ix>=0?TLIST[ix]:null;}renderApp();});
  }).catch(function(){document.getElementById('app').innerHTML='<div class="card err">サーバーに接続できませんでした</div>';});
}
function renderSetup(){
  document.getElementById('app').innerHTML='<div class="card"><h2>管理者パスワードの設定</h2>'
  +'<p class="hint">最初に管理者パスワードを設定してください。以後、このパスワードを知っている人だけが管理者ページに入れます。</p>'
  +'<label class="f">パスワード</label><input type="password" id="pw1">'
  +'<label class="f">パスワード（確認）</label><input type="password" id="pw2">'
  +'<div id="msg"></div><p><button onclick="doSetup()">パスワードを設定する</button></p></div>';
}
function doSetup(){
  var p1=document.getElementById('pw1').value,p2=document.getElementById('pw2').value;
  if(!p1){showMsg('パスワードを入力してください',true);return;}
  if(p1!==p2){showMsg('パスワードが一致しません',true);return;}
  fetch('/api/auth/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:p1})})
  .then(function(r){return r.json();}).then(function(d){
    if(d.token){token=d.token;localStorage.setItem('st_admin_token',token);init();}
    else{showMsg(d.error||'設定に失敗しました',true);}
  });
}
function renderLogin(){
  document.getElementById('app').innerHTML='<div class="card"><h2>管理者ログイン</h2>'
  +'<label class="f">パスワード</label><input type="password" id="pw">'
  +'<div id="msg"></div><p><button onclick="doLogin()">ログイン</button></p></div>';
}
function doLogin(){
  var p=document.getElementById('pw').value;
  fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:p})})
  .then(function(r){return r.json();}).then(function(d){
    if(d.token){token=d.token;localStorage.setItem('st_admin_token',token);init();}
    else{showMsg('パスワードが違います',true);}
  });
}
function doLogout(){localStorage.removeItem('st_admin_token');token='';T=null;init();}

/* ---------- 大会の作成・設定 ---------- */
function newTid(){return 't'+Date.now().toString(36)+Math.floor(Math.random()*100000).toString(36);}
function blankTournament(name,format,pairCount,ppl,adv){
  var t={id:newTid(),name:name,format:format,pairCount:pairCount,pairsPerLeague:ppl,advanceCount:adv,
    separateTeams:true,separateSeeds:true,pairs:[],leagueAssignment:[],bracketSlots:[],leagueScores:{},bracketScores:{},waitCount:3,courtCount:4,playing:{}};
  for(var i=1;i<=pairCount;i++)t.pairs.push({id:i,name:'',team:'',seed:false});
  if(format==='league_tournament'){var L=leagueCount(t);for(var j=0;j<L;j++)t.leagueAssignment.push([]);}
  else{var B=nextPow2(Math.max(2,pairCount));for(var k=0;k<B;k++)t.bracketSlots.push(null);}
  return t;
}
function tournamentForm(isNew){
  var t=isNew?{name:'',format:'league_tournament',pairCount:8,pairsPerLeague:4,advanceCount:2}:T;
  var h='<div class="card"><h2>'+(isNew?'大会を作成する':'大会設定の変更')+'</h2>';
  h+='<label class="f">大会名</label><input type="text" id="f_name" value="'+esc(t.name)+'" placeholder="例：〇〇大会" style="width:100%">';
  h+='<label class="f">大会方式</label><select id="f_format" onchange="toggleLeagueFields()"><option value="league_tournament"'+(t.format==='league_tournament'?' selected':'')+'>リーグ戦 → トーナメント</option><option value="tournament"'+(t.format==='tournament'?' selected':'')+'>トーナメントのみ</option></select>';
  h+='<label class="f">参加ペア数</label><span class="stepper"><button type="button" onclick="stepCount(-1)">−</button><input type="number" id="f_count" value="'+t.pairCount+'" min="2" max="128"><button type="button" onclick="stepCount(1)">＋</button></span>';
  h+='<div id="league_fields">';
  h+='<label class="f">1リーグのペア数</label><span class="stepper"><button type="button" onclick="stepField(\\'f_ppl\\',-1)">−</button><input type="number" id="f_ppl" value="'+t.pairsPerLeague+'" min="3" max="16"><button type="button" onclick="stepField(\\'f_ppl\\',1)">＋</button></span>';
  h+='<label class="f">トーナメント進出数（各リーグ上位）</label><span class="stepper"><button type="button" onclick="stepField\(\\'f_adv\\',-1)">−</button><input type="number" id="f_adv" value="'+t.advanceCount+'" min="1" max="4"><button type="button" onclick="stepField\(\\'f_adv\\',1)">＋</button></span>';
  h+='</div>';
  h+='<div id="msg"></div>';
  if(isNew){h+='<p><button onclick="doCreate()">この内容で大会を作成</button></p>';}
  else{h+='<p><button onclick="doSettings()">設定を変更して表を作り直す</button> <span class="hint">※割り振りと結果はリセットされます（ペア名・所属は残ります）</span></p>';}
  h+='</div>';
  return h;
}
function stepCount(d){stepField('f_count',d);}
function stepField(id,d){var el=document.getElementById(id);var v=parseInt(el.value||'0',10)+d;if(v<parseInt(el.min||'1',10))v=parseInt(el.min||'1',10);if(el.max&&v>parseInt(el.max,10))v=parseInt(el.max,10);el.value=v;}
function toggleLeagueFields(){var f=document.getElementById('f_format').value;document.getElementById('league_fields').style.display=(f==='league_tournament')?'block':'none';}
function readForm(){
  return {name:document.getElementById('f_name').value.trim(),
    format:document.getElementById('f_format').value,
    pairCount:Math.max(2,parseInt(document.getElementById('f_count').value||'2',10)),
    pairsPerLeague:Math.max(3,parseInt(document.getElementById('f_ppl').value||'4',10)),
    advanceCount:Math.max(1,parseInt(document.getElementById('f_adv').value||'2',10))};
}
function doCreate(){
  var f=readForm();
  if(!f.name){showMsg('大会名を入力してください',true);return;}
  T=blankTournament(f.name,f.format,f.pairCount,f.pairsPerLeague,f.advanceCount);
  DRAFT=false;sel=null;save();
}
function doSettings(){
  var f=readForm();
  if(!f.name){showMsg('大会名を入力してください',true);return;}
  if(!confirm('設定を変更すると、割り振りと結果がリセットされます。よろしいですか？'))return;
  var old=T;
  var nt=blankTournament(f.name,f.format,f.pairCount,f.pairsPerLeague,f.advanceCount);
  nt.id=old.id;
  nt.separateTeams=old.separateTeams;nt.separateSeeds=old.separateSeeds;
  for(var i=0;i<Math.min(old.pairs.length,nt.pairs.length);i++){nt.pairs[i].name=old.pairs[i].name;nt.pairs[i].team=old.pairs[i].team;nt.pairs[i].seed=old.pairs[i].seed;}
  T=nt;sel=null;save();
}

/* ---------- ペア登録 ---------- */
function pairsForm(){
  var h='<div class="card"><h2>参加ペアの登録</h2>';
  h+='<div class="hint">ペア名（選手名ペア）と所属（チーム名）を入力してください。「強者」にチェックしたペアはシード扱いで、割り振りで分散されます。入力すると自動で保存されます。</div><br>';
  T.pairs.forEach(function(p,i){
    h+='<div class="pairrow"><span class="no">'+(i+1)+'.</span>'
      +'<input type="text" placeholder="ペア名（例：山田・佐藤）" value="'+esc(p.name)+'" onchange="pairEdit('+p.id+',\\'name\\',this.value)">'
      +'<input type="text" class="teamin" placeholder="所属（例：〇〇中）" value="'+esc(p.team)+'" onchange="pairEdit('+p.id+',\\'team\\',this.value)">'
      +'<label><input type="checkbox" '+(p.seed?'checked':'')+' onchange="pairEdit('+p.id+',\\'seed\\',this.checked)"> 強者</label></div>';
  });
  h+='</div>';
  return h;
}
function pairEdit(id,field,val){
  var p=pairById(T,id);if(!p)return;
  p[field]=val;
  pruneScores(T);
  save();
}

/* ---------- 割り振り ---------- */
function unassignedIds(){
  var used={};
  if(T.format==='league_tournament'){(T.leagueAssignment||[]).forEach(function(lg){lg.forEach(function(id){used[id]=true;});});}
  else{(T.bracketSlots||[]).forEach(function(v){if(typeof v==='number')used[v]=true;});}
  return registeredPairs(T).filter(function(p){return !used[p.id];}).map(function(p){return p.id;});
}
function chipHtml(label,sub,cls,onclick){
  return '<span class="chip '+cls+'" onclick="'+onclick+'">'+esc(label)+(sub?' <small>'+esc(sub)+'</small>':'')+'</span>';
}
function assignSection(){
  var h='<div class="card"><h2>割り振り</h2>';
  h+='<label><input type="checkbox" '+(T.separateTeams?'checked':'')+' onchange="ruleEdit(\\'separateTeams\\',this.checked)"> 同所属を離す</label>　'
    +'<label><input type="checkbox" '+(T.separateSeeds?'checked':'')+' onchange="ruleEdit(\\'separateSeeds\\',this.checked)"> 強者を離す</label>';
  h+='<p><button onclick="doRandom()">ランダム割り振り</button> <span class="hint">ペアをタップで選んで、もう一方をタップすると入れ替え／移動ができます</span></p>';
  var pool=unassignedIds();
  h+='<h3>未配置のペア</h3><div class="chips">';
  if(pool.length===0)h+='<span class="hint">なし</span>';
  pool.forEach(function(id){var p=pairById(T,id);var s=(sel&&sel.kind==='pool'&&sel.id===id)?'sel':'';
    h+=chipHtml(p.name,(p.team||'')+(p.seed?'・強者':''),s,'pickPool('+id+')');});
  h+='</div>';
  if(T.format==='league_tournament'){
    T.leagueAssignment.forEach(function(lg,li){
      h+='<h3>'+String.fromCharCode(65+li)+'リーグ（タップで移動先に指定）</h3><div class="chips" onclick="moveToLeague('+li+')">';
      if(lg.length===0)h+='<span class="hint">（空き）</span>';
      lg.forEach(function(id,idx){var p=pairById(T,id);var s=(sel&&sel.kind==='league'&&sel.league===li&&sel.idx===idx)?'sel':'';
        h+=chipHtml(p.name,(p.team||'')+(p.seed?'・強者':''),s,'pickLeague(event,'+li+','+idx+')');});
      h+='</div>';
    });
  }else{
    h+='<h3>トーナメント表の枠（タップで入れ替え）</h3><div class="chips">';
    T.bracketSlots.forEach(function(v,idx){
      var s=(sel&&sel.kind==='slot'&&sel.idx===idx)?'sel':'';
      if(v==='BYE')h+=chipHtml('不戦勝（BYE）','','bye '+s,'pickSlot('+idx+')');
      else if(v==null)h+=chipHtml('（空き）','','empty '+s,'pickSlot('+idx+')');
      else{var p=pairById(T,v);h+=chipHtml(p.name,(p.team||'')+(p.seed?'・強者':''),s,'pickSlot('+idx+')');}
    });
    h+='</div>';
  }
  h+='</div>';
  return h;
}
function ruleEdit(field,val){T[field]=val;save();}
function doRandom(){
  if(registeredPairs(T).length===0){showMsg('先にペア名を入力してください',true);return;}
  if(T.format==='league_tournament')assignLeagues(T);else assignBracket(T);
  sel=null;save();
}
function pickPool(id){
  if(sel&&sel.kind==='pool'&&sel.id===id){sel=null;renderApp();return;}
  if(sel&&(sel.kind==='league'||sel.kind==='slot')){placeFromSelection({kind:'pool',id:id});return;}
  sel={kind:'pool',id:id};renderApp();
}
function pickLeague(ev,li,idx){
  ev.stopPropagation();
  if(sel&&sel.kind==='league'&&sel.league===li&&sel.idx===idx){sel=null;renderApp();return;}
  if(!sel){sel={kind:'league',league:li,idx:idx,id:T.leagueAssignment[li][idx]};renderApp();return;}
  placeFromSelection({kind:'league',league:li,idx:idx});
}
function moveToLeague(li){
  if(!sel)return;
  if(sel.kind==='pool'){
    T.leagueAssignment[li].push(sel.id);
  }else if(sel.kind==='league'&&sel.league!==li){
    T.leagueAssignment[sel.league].splice(sel.idx,1);
    T.leagueAssignment[li].push(sel.id);
  }else{return;}
  sel=null;pruneScores(T);save();
}
function pickSlot(idx){
  if(sel&&sel.kind==='slot'&&sel.idx===idx){sel=null;renderApp();return;}
  if(!sel){sel={kind:'slot',idx:idx};renderApp();return;}
  placeFromSelection({kind:'slot',idx:idx});
}
function placeFromSelection(target){
  if(!sel)return;
  if(sel.kind==='pool'&&target.kind==='league'){
    T.leagueAssignment[target.league][target.idx]=sel.id;
  }else if(sel.kind==='league'&&target.kind==='pool'){
    T.leagueAssignment[sel.league][sel.idx]=target.id;
  }else if(sel.kind==='league'&&target.kind==='league'){
    var tmp=T.leagueAssignment[sel.league][sel.idx];
    T.leagueAssignment[sel.league][sel.idx]=T.leagueAssignment[target.league][target.idx];
    T.leagueAssignment[target.league][target.idx]=tmp;
  }else if(sel.kind==='pool'&&target.kind==='slot'){
    T.bracketSlots[target.idx]=sel.id;
  }else if(sel.kind==='slot'&&target.kind==='pool'){
    T.bracketSlots[sel.idx]=target.id;
  }else if(sel.kind==='slot'&&target.kind==='slot'){
    var tmp2=T.bracketSlots[sel.idx];T.bracketSlots[sel.idx]=T.bracketSlots[target.idx];T.bracketSlots[target.idx]=tmp2;
  }
  sel=null;pruneScores(T);save();
}

/* ---------- 結果入力 ---------- */
function scoreInputs(prefix,key,a,b,ga,gb){
  return '<input type="number" class="scoreinput" id="'+prefix+'-'+key+'-a" min="0" max="99" value="'+(ga==null?'':ga)+'" onchange="scoreEdit(\\''+prefix+'\\',\\''+key+'\\','+a+','+b+')">'
    +' － '
    +'<input type="number" class="scoreinput" id="'+prefix+'-'+key+'-b" min="0" max="99" value="'+(gb==null?'':gb)+'" onchange="scoreEdit(\\''+prefix+'\\',\\''+key+'\\','+a+','+b+')">';
}
function scoreEdit(prefix,key,a,b){
  var ea=document.getElementById(prefix+'-'+key+'-a'),eb=document.getElementById(prefix+'-'+key+'-b');
  var va=ea.value===''?null:parseInt(ea.value,10),vb=eb.value===''?null:parseInt(eb.value,10);
  var store=(prefix==='lg')?T.leagueScores:T.bracketScores;
  if(va===null&&vb===null){delete store[key];save();return;}
  if(va===null||vb===null){showMsg('スコアは両方入力してください',true);return;}
  if(va===vb){showMsg('同点は入力できません（勝敗が決まるスコアを入れてください）',true);return;}
  store[key]={a:a,b:b,ga:va,gb:vb};
  if(T.playing)delete T.playing[prefix+':'+key];
  save();
}
function stepWait(d){var el=document.getElementById('waitCount');var v=parseInt(el.value||'0',10)+d;if(v<0)v=0;if(v>20)v=20;el.value=v;}
function stepCourt(d){var el=document.getElementById('courtCount');var v=parseInt(el.value||'0',10)+d;if(v<1)v=1;if(v>30)v=30;el.value=v;}
function callWaitSave(){var el=document.getElementById('waitCount');var v=parseInt(el.value,10);if(isNaN(v)||v<0)v=0;if(v>20)v=20;T.waitCount=v;var ce=document.getElementById('courtCount');var cv=parseInt(ce.value,10);if(isNaN(cv)||cv<1)cv=1;if(cv>30)cv=30;T.courtCount=cv;save();}
function playingToggle(key,on,a,b){if(!T.playing)T.playing={};if(on){if(key.indexOf('br:')===0&&a!=null&&b!=null)T.playing[key]={a:a,b:b};else T.playing[key]=true;}else delete T.playing[key];save();}
function callScoreEdit(kind,key,a,b){
  var p=(kind==='lg')?'clg':'cbr';
  var ea=document.getElementById(p+'-'+key+'-a'),eb=document.getElementById(p+'-'+key+'-b');
  var va=ea.value===''?null:parseInt(ea.value,10),vb=eb.value===''?null:parseInt(eb.value,10);
  var store=(kind==='lg')?T.leagueScores:T.bracketScores;
  if(va===null&&vb===null){delete store[key];save();return;}
  if(va===null||vb===null){showMsg('スコアは両方入力してください',true);return;}
  if(va===vb){showMsg('同点は入力できません（勝敗が決まるスコアを入れてください）',true);return;}
  store[key]={a:a,b:b,ga:va,gb:vb};
  if(T.playing)delete T.playing[kind+':'+key];
  save();
}
function callSection(v){
  var cl=callLists(T,v);
  var h='<div class="card"><h2>呼び出し</h2>';
  h+='<label class="f">待機ゲーム数</label><span class="stepper"><button type="button" onclick="stepWait(-1)">−</button><input type="number" id="waitCount" value="'+(typeof T.waitCount==='number'?T.waitCount:3)+'" min="0" max="20"><button type="button" onclick="stepWait(1)">＋</button></span>';
  h+='<label class="f">コート数</label><span class="stepper"><button type="button" onclick="stepCourt(-1)">−</button><input type="number" id="courtCount" value="'+(typeof T.courtCount==='number'?T.courtCount:4)+'" min="1" max="30"><button type="button" onclick="stepCourt(1)">＋</button></span> <button class="sub" onclick="callWaitSave()">呼び出し設定を保存</button>';
  h+='<div class="hint">待機ゲーム数のぶんだけ、次の試合が「待機（呼び出し中）」になります。待機は、同じペアの試合が重ならず、各ペアの試合間隔が空きすぎない順番で選ばれます。試合がコートに入ったら「試合中」にチェックを入れてください。結果を入力すると、その試合のチェックは自動で外れます。トーナメントの試合は、対戦相手が確定した時点で呼び出しの対象になります。</div>';
  function row(m,checked,badge){
    var p=(m.type==='lg')?'clg':'cbr';var raw=m.key.slice(3);
    var inputs='<span class="scorein"><input type="number" id="'+p+'-'+raw+'-a" min="0" max="9" value="'+(m.ga==null?'':m.ga)+'" onchange="callScoreEdit(\\''+m.type+'\\',\\''+raw+'\\','+m.a+','+m.b+')"> − <input type="number" id="'+p+'-'+raw+'-b" min="0" max="9" value="'+(m.gb==null?'':m.gb)+'" onchange="callScoreEdit(\\''+m.type+'\\',\\''+raw+'\\','+m.a+','+m.b+')"></span>';
    return '<div class="matchline'+(m.conflict?' conflict':'')+'"><label style="flex:none"><input type="checkbox" '+(checked?'checked':'')+' onchange="playingToggle(\\''+m.key+'\\',this.checked,'+m.a+','+m.b+')"> 試合中</label><span class="pairname"><span class="ctx">'+(badge?badge+'｜':'')+esc(m.label)+'</span>'+pairName(T,m.a)+'<span class="team">'+pairTeam(T,m.a)+'</span></span>'+inputs+'<span class="pairname" style="text-align:right">'+pairName(T,m.b)+'<span class="team">'+pairTeam(T,m.b)+'</span></span></div>';
  }
  if(cl.conflicts&&cl.conflicts.length>0){
    var cnt={};cl.playing.forEach(function(m){cnt[m.a]=(cnt[m.a]||0)+1;cnt[m.b]=(cnt[m.b]||0)+1;});
    var dups=Object.keys(cnt).filter(function(k){return cnt[k]>1;}).map(function(k){return pairName(T,+k);});
    h+='<div class="alertbox">⚠ 同じペアが複数の試合で「試合中」になっています：'+dups.map(esc).join('、')+'（赤い行を確認してください）</div>';
  }
  var cc=(typeof T.courtCount==='number')?T.courtCount:4;
  if(cl.playing.length>cc)h+='<div class="alertbox">⚠ 試合中がコート数（'+cc+'面）を超えています</div>';
  if(cl.playing.length>0){h+='<h3>試合中</h3>';cl.playing.forEach(function(m){h+=row(m,true,'');});}
  if(cl.waiting.length>0){h+='<h3>待機（呼び出し中）</h3>';cl.waiting.forEach(function(m,i){h+=row(m,false,'待機'+(i+1));});}
  if(cl.playing.length===0&&cl.waiting.length===0)h+='<div class="hint">いま呼び出し中の試合はありません</div>';
  if(cl.upcoming.length>0){
    h+='<h3>このあとの試合（予定順）</h3>';
    cl.upcoming.slice(0,10).forEach(function(m){
      h+='<div class="matchline"><span class="pairname"><span class="ctx">'+esc(m.label)+'</span>'+pairName(T,m.a)+'</span><span class="score">vs</span><span class="pairname" style="text-align:right">'+pairName(T,m.b)+'</span></div>';
    });
  }
  h+='</div>';
  return h;
}
function leagueMatrixAdminHtml(lg){
  var ids=lg.pairIds||[];
  var byKey={};lg.matches.forEach(function(m){byKey[m.key]=m;});
  var stById={};lg.standings.forEach(function(r,idx){stById[r.id]={w:r.w,l:r.l,rank:idx+1};});
  var ord={};lg.matches.forEach(function(m,i){ord[m.key]=i+1;});
  var h='<div class="mtxwrap"><table class="mtx"><tr><th class="name diag"></th>';
  ids.forEach(function(id,i){h+='<th>'+(i+1)+'</th>';});
  h+='<th>勝敗</th><th>順位</th></tr>';
  ids.forEach(function(rid,i){
    var st=stById[rid]||{w:0,l:0,rank:''};
    h+='<tr><td class="name">'+(i+1)+' '+pairName(T,rid)+(pairTeam(T,rid)?' <small>（'+pairTeam(T,rid)+'）</small>':'')+'</td>';
    ids.forEach(function(cid,j){
      if(i===j){h+='<td class="diag"></td>';return;}
      if(i<j){
        var key=rid+'|'+cid;var m=byKey[key];var rv='',cv='';
        if(m&&m.ga!=null){rv=(m.a===rid)?m.ga:m.gb;cv=(m.a===rid)?m.gb:m.ga;}
        h+='<td><span class="ord">'+(m?circledNum(ord[key]):'')+'</span><input type="number" id="mx-'+key+'-r" min="0" max="99" value="'+rv+'" onchange="matrixScoreEdit(\\''+key+'\\','+rid+','+cid+')"> - <input type="number" id="mx-'+key+'-c" min="0" max="99" value="'+cv+'" onchange="matrixScoreEdit(\\''+key+'\\','+rid+','+cid+')"></td>';
        return;
      }
      var key2=cid+'|'+rid;var mm=byKey[key2];var cell='';
      if(mm&&mm.ga!=null){var rs=(mm.a===rid)?mm.ga:mm.gb;var cs=(mm.a===rid)?mm.gb:mm.ga;cell=(rs>cs)?('<span class="maru">'+rs+'</span>'):String(rs);}
      h+='<td>'+cell+'</td>';
    });
    h+='<td class="wl">'+st.w+' - '+st.l+'</td><td class="'+(st.rank&&st.rank<=T.advanceCount?'qrk':'')+'">'+st.rank+'</td></tr>';
  });
  h+='</table></div>';
  return h;
}
function matrixScoreEdit(key,rid,cid){
  var er=document.getElementById('mx-'+key+'-r'),ec=document.getElementById('mx-'+key+'-c');
  if(!er||!ec)return;
  var vr=er.value===''?null:parseInt(er.value,10),vc=ec.value===''?null:parseInt(ec.value,10);
  if(vr===null&&vc===null){delete T.leagueScores[key];if(T.playing)delete T.playing['lg:'+key];save();return;}
  if(vr===null||vc===null){showMsg('スコアは両方入力してください',true);return;}
  if(vr===vc){showMsg('同点は入力できません（勝敗が決まるスコアを入れてください）',true);return;}
  T.leagueScores[key]={a:rid,b:cid,ga:vr,gb:vc};
  if(T.playing)delete T.playing['lg:'+key];
  save();
}
function leagueInputSection(v){
  var h='';
  v.leagues.forEach(function(lg,li){
    h+='<div class="card"><h2>'+String.fromCharCode(65+li)+'リーグ｜結果入力と順位</h2>';
    if(lg.matches.length===0){h+='<div class="hint">ペアを割り振ると対戦が表示されます</div>';}
    else{
      h+=leagueMatrixAdminHtml(lg);
      h+='<div class="hint">上側のセルに「その行のペアの得点 − 相手の得点」を入力してください。反対側のセルには自動で反転して表示されます</div>';
    }
    h+='<h3>順位表</h3><table><tr><th>順位</th><th class="name">ペア</th><th>勝</th><th>負</th><th>得</th><th>失</th><th>差</th></tr>';
    lg.standings.forEach(function(r,idx){
      h+='<tr class="'+(idx<T.advanceCount?'qualify':'')+(idx===0?' rank1':'')+'"><td>'+(idx+1)+'</td><td class="name">'+pairName(T,r.id)+(pairTeam(T,r.id)?' <small>（'+pairTeam(T,r.id)+'）</small>':'')+'</td><td>'+r.w+'</td><td>'+r.l+'</td><td>'+r.gf+'</td><td>'+r.ga+'</td><td>'+(r.diff>0?'+':'')+r.diff+'</td></tr>';
    });
    h+='</table></div>';
  });
  return h;
}
function bracketSection(v){
  var h='<div class="card"><h2>トーナメント表</h2>';
  if(!v.bracket||v.bracket.rounds.length===0){h+='<div class="hint">対戦相手が決まると表示されます</div></div>';return h;}
  h+='<div class="bracket">';
  v.bracket.rounds.forEach(function(matches,r){
    h+='<div class="round"><h4>'+roundName(v.bracket.rounds.length,r)+'</h4>';
    matches.forEach(function(m){h+=bmatchAdminHtml(m);});
    h+='</div>';
  });
  h+='</div>';
  var lastRound=v.bracket.rounds[v.bracket.rounds.length-1];
  if(lastRound.length===1&&lastRound[0].winner!=null&&lastRound[0].winner!=='BYE'){
    h+='<div class="champ">🏆 優勝：'+pairName(T,lastRound[0].winner)+'</div>';
  }
  h+='</div>';
  return h;
}
function bmatchAdminHtml(m){
  function row(v,sc,isWin,label){
    if(v==='BYE')return '<div class="row bye"><span>不戦勝（BYE）</span><span class="sc"></span></div>';
    if(v==null)return '<div class="row bye"><span>'+(label?esc(label):'未定')+'</span><span class="sc"></span></div>';
    return '<div class="row'+(isWin?' win':'')+'"><span class="'+(isWin?'winname':'')+'">'+pairName(T,v)+'</span><span class="sc'+(isWin?' win':'')+'">'+(sc==null?'':sc)+'</span></div>';
  }
  var h='<div class="bmatch">'+row(m.a,m.ga,m.winner===m.a&&m.a!=null,m.la)+row(m.b,m.gb,m.winner===m.b&&m.b!=null,m.lb);
  if(typeof m.a==='number'&&typeof m.b==='number'){
    h+='<div style="text-align:center;margin-top:4px">'+scoreInputs('br',m.key,m.a,m.b,m.ga,m.gb)+'</div>';
  }else if(m.winner!=null&&m.winner!=='BYE'){
    h+='<div class="hint" style="text-align:center">不戦勝などで自動進出</div>';
  }
  h+='</div>';
  return h;
}

/* ---------- 大会一覧 ---------- */
function renderList(){
  var app=document.getElementById('app');
  var h='<div id="msg">'+msg+'</div>';
  h+='<p style="text-align:right"><button class="sub" onclick="doLogout()">ログアウト</button></p>';
  h+='<div class="card"><h2>大会一覧</h2>';
  if(TLIST.length===0){h+='<div class="hint">大会はまだありません</div>';}
  TLIST.forEach(function(t){
    h+='<div class="pairrow"><span style="flex:1">'+esc(t.name||'（無題）')+' <small>（'+(t.format==='league_tournament'?'リーグ戦 → トーナメント':'トーナメントのみ')+'／'+t.pairCount+'ペア）</small></span>'
      +'<button onclick="openTournament(\\''+t.id+'\\')">編集する</button> '
      +'<button class="danger" onclick="deleteTournamentById(\\''+t.id+'\\')">削除</button></div>';
  });
  h+='<p><button onclick="newTournament()">＋ 新しい大会を作成</button></p></div>';
  app.innerHTML=h;
}
function openTournament(id){var t=TLIST.find(function(x){return x.id===id;});if(!t)return;T=t;DRAFT=false;sel=null;renderApp();}
function newTournament(){DRAFT=true;T=null;sel=null;renderApp();}
function backToList(){T=null;DRAFT=false;sel=null;renderApp();}
function deleteTournamentById(id){
  var t=TLIST.find(function(x){return x.id===id;});
  if(!confirm('大会「'+(t?(t.name||'（無題）'):'')+'」を削除します。よろしいですか？'))return;
  api('/api/admin/delete',{method:'POST',body:{id:id}}).then(function(r){return r.json();}).then(function(d){
    if(d&&d.ok){TLIST=TLIST.filter(function(x){return x.id!==id;});if(T&&T.id===id)T=null;showMsg('削除しました');renderApp();}
    else{showMsg('削除に失敗しました',true);}
  }).catch(function(){showMsg('削除に失敗しました',true);});
}

/* ---------- 画面全体 ---------- */
function renderApp(){
  var app=document.getElementById('app');
  var h='<div id="msg">'+msg+'</div>';
  h+='<p style="text-align:right">'+(TLIST.length>0?'<button class="sub" onclick="backToList()">← 大会一覧に戻る</button>　':'')+'<button class="sub" onclick="doLogout()">ログアウト</button></p>';
  if(!T){
    if(!DRAFT&&TLIST.length>0){renderList();return;}
    h+=tournamentForm(true);
    app.innerHTML=h;toggleLeagueFields();return;
  }
  h+='<div class="card"><h2 style="font-size:22px">'+esc(T.name)+'</h2><div class="hint">'+(T.format==='league_tournament'?'リーグ戦 → トーナメント':'トーナメントのみ')+' ／ '+T.pairCount+'ペア</div></div>';
  h+=tournamentForm(false);
  h+=pairsForm();
  h+=assignSection();
  var v=buildView(T);
  h+=callSection(v);
  if(T.format==='league_tournament')h+=leagueInputSection(v);
  h+=bracketSection(v);
  h+='<div class="card"><h2>その他の操作</h2>'
    +'<p><button class="sub" onclick="clearScores()">結果だけをクリア</button>　'
    +'<button class="danger" onclick="deleteTournament()">大会を削除する</button></p></div>';
  app.innerHTML=h;
  toggleLeagueFields();
}
function clearScores(){
  if(!confirm('入力した結果をすべて消します。よろしいですか？'))return;
  T.leagueScores={};T.bracketScores={};save();
}
function deleteTournament(){
  if(!T)return;
  deleteTournamentById(T.id);
}
init();
</script>
</body>
</html>`;

/* ---------------- HTTPサーバー ---------------- */
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
function sendHtml(res, html) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}
function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 5 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); } catch (e) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}
function validateTournament(t) {
  if (t === null) return true;
  if (typeof t !== 'object' || Array.isArray(t)) return false;
  if (typeof t.name !== 'string') return false;
  if (t.format !== 'tournament' && t.format !== 'league_tournament') return false;
  if (!Array.isArray(t.pairs) || !Array.isArray(t.leagueAssignment) || !Array.isArray(t.bracketSlots)) return false;
  if (typeof t.leagueScores !== 'object' || typeof t.bracketScores !== 'object') return false;
  if (t.id !== undefined && typeof t.id !== 'string') return false;
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && p === '/') return sendHtml(res, VIEWER_HTML);
    if (req.method === 'GET' && p === '/admin') return sendHtml(res, ADMIN_HTML);

    if (req.method === 'GET' && p === '/api/state') {
      const list = data.tournaments.map((t) => ({ id: t.id, name: t.name, format: t.format, pairCount: t.pairCount }));
      const want = url.searchParams.get('id');
      let selT = want ? data.tournaments.find((t) => t.id === want) : null;
      if (!selT) selT = data.tournaments[data.tournaments.length - 1] || null;
      return sendJson(res, 200, {
        hasPassword: !!data.passwordHash,
        list,
        tournament: selT,
        view: selT ? shared.buildView(selT) : null,
      });
    }
    if (req.method === 'GET' && p === '/api/admin/state') {
      if (!isAuthed(req)) return sendJson(res, 401, { error: '認証が必要です' });
      return sendJson(res, 200, { tournaments: data.tournaments });
    }
    if (req.method === 'GET' && p === '/api/auth/status') {
      return sendJson(res, 200, { hasPassword: !!data.passwordHash, authed: isAuthed(req) });
    }
    if (req.method === 'POST' && p === '/api/auth/setup') {
      if (data.passwordHash) return sendJson(res, 400, { error: 'パスワードは設定済みです' });
      const body = await readBody(req);
      if (!body.password || String(body.password).length < 4) {
        return sendJson(res, 400, { error: 'パスワードは4文字以上にしてください' });
      }
      data.passwordHash = hashPassword(body.password);
      saveData();
      return sendJson(res, 200, { token: newToken() });
    }
    if (req.method === 'POST' && p === '/api/auth/login') {
      const body = await readBody(req);
      if (!data.passwordHash || !verifyPassword(body.password || '', data.passwordHash)) {
        return sendJson(res, 401, { error: 'パスワードが違います' });
      }
      return sendJson(res, 200, { token: newToken() });
    }
    if (req.method === 'POST' && p === '/api/admin/save') {
      if (!isAuthed(req)) return sendJson(res, 401, { error: '認証が必要です' });
      const body = await readBody(req);
      if (!validateTournament(body.tournament)) {
        return sendJson(res, 400, { error: 'データ形式が正しくありません' });
      }
      const t = body.tournament;
      if (!t.id) t.id = 'main';
      const ix = data.tournaments.findIndex((x) => x.id === t.id);
      if (ix >= 0) data.tournaments[ix] = t; else data.tournaments.push(t);
      saveData();
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/admin/delete') {
      if (!isAuthed(req)) return sendJson(res, 401, { error: '認証が必要です' });
      const body = await readBody(req);
      data.tournaments = data.tournaments.filter((x) => x.id !== body.id);
      saveData();
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/admin/reset') {
      if (!isAuthed(req)) return sendJson(res, 401, { error: '認証が必要です' });
      data.tournaments = [];
      saveData();
      return sendJson(res, 200, { ok: true });
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  } catch (e) {
    sendJson(res, 500, { error: 'サーバーエラー' });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log('ソフトテニス大会進行表サーバーを起動しました: http://localhost:' + PORT);
    console.log('  閲覧ページ: http://localhost:' + PORT + '/');
    console.log('  管理者ページ: http://localhost:' + PORT + '/admin');
  });
}

module.exports = { shared, server };
