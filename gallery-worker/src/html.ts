/**
 * Mobile gallery HTML — server-rendered with the manifest inlined as JSON.
 *
 * Single self-contained page: no external CDNs, no build step. All CSS/JS
 * lives here so the Worker can serve it in one response.
 */

import type { GalleryMeta } from "./types";

interface InlineManifest {
  name: string;
  expires_at: string;
  default_decision: "ok" | "ng";
  photos: { pid: string; filename: string }[];
  decisions: Record<string, "ok" | "ng" | "fav">;
}

export function renderGalleryHtml(
  gid: string,
  meta: GalleryMeta,
  decisions: Record<string, "ok" | "ng" | "fav">,
): string {
  const manifest: InlineManifest = {
    name: meta.name,
    expires_at: meta.expires_at,
    default_decision: meta.default_decision,
    photos: meta.photos.map((p) => ({ pid: p.pid, filename: p.filename })),
    decisions,
  };

  const safeName = escapeHtml(meta.name);
  const data = escapeForScript(JSON.stringify({ gid, ...manifest }));

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="#111">
<title>${safeName}</title>
<style>${CSS}</style>
</head>
<body>
<header id="hdr">
  <h1>${safeName}</h1>
  <div class="meta">
    <span id="info"></span>
    <button id="selBtn" class="hdr-btn" type="button">選択</button>
    <a id="dl" href="/${gid}/zip">↓ 全部DL</a>
  </div>
  <div class="hint" id="hint"></div>
</header>
<main id="grid" class="grid"></main>
<div id="selBar" class="selbar" hidden>
  <span id="selCount">0 枚選択中</span>
  <button id="selSave" type="button">保存</button>
  <button id="selCancel" type="button">キャンセル</button>
</div>
<div id="toast" class="toast" hidden></div>
<div id="lb" class="lb" hidden>
  <button class="close" id="lbClose" aria-label="閉じる">×</button>
  <div class="lb-stage" id="lbStage">
    <img class="lb-img" id="lbImg" alt="">
  </div>
  <div class="lb-bottom">
    <div class="lb-meta" id="lbMeta"></div>
    <div class="lb-actions">
      <button class="dec ok" id="decOk">✓ OK</button>
      <button class="dec ng" id="decNg">× NG</button>
      <button class="dec fav" id="decFav">★ FAV</button>
    </div>
  </div>
  <button class="nav prev" id="lbPrev" aria-label="前へ">‹</button>
  <button class="nav next" id="lbNext" aria-label="次へ">›</button>
</div>
<script>window.__G__=${data};</script>
<script>${JS}</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&"
      ? "&amp;"
      : c === "<"
        ? "&lt;"
        : c === ">"
          ? "&gt;"
          : c === '"'
            ? "&quot;"
            : "&#39;",
  );
}

/** Escape a JSON literal so it can be safely inlined inside <script>. */
function escapeForScript(s: string): string {
  return s.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
}

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#111;color:#eee;font-family:-apple-system,BlinkMacSystemFont,"Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif;line-height:1.4;-webkit-font-smoothing:antialiased}
body{min-height:100vh;padding-bottom:env(safe-area-inset-bottom)}
header{padding:16px 14px 10px;border-bottom:1px solid #222;position:sticky;top:0;background:rgba(17,17,17,.96);backdrop-filter:blur(8px);z-index:10}
header h1{font-size:18px;font-weight:600;margin-bottom:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
header .meta{display:flex;justify-content:space-between;align-items:center;font-size:12px;color:#aaa;gap:12px}
header .meta #info{flex:1;min-width:0}
header .meta #dl{color:#9cf;text-decoration:none;padding:6px 10px;border:1px solid #345;border-radius:6px;white-space:nowrap}
header .meta #dl:active{background:#234}
.hdr-btn{background:transparent;color:#9cf;border:1px solid #345;border-radius:6px;padding:6px 10px;font-size:12px;cursor:pointer;white-space:nowrap}
.hdr-btn:active{background:#234}
.hdr-btn.active{background:#234;color:#fff;border-color:#56a}
.hint{font-size:11px;color:#777;margin-top:6px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:2px;padding:2px}
@media(min-width:640px){.grid{grid-template-columns:repeat(4,1fr)}}
@media(min-width:960px){.grid{grid-template-columns:repeat(6,1fr)}}
.tile{position:relative;aspect-ratio:1/1;background:#000;border:0;padding:0;cursor:pointer;overflow:hidden}
.tile img{width:100%;height:100%;object-fit:cover;display:block}
.tile .badge{position:absolute;top:4px;right:4px;width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.6);box-shadow:0 1px 2px rgba(0,0,0,.4)}
.tile .badge[data-d="ok"]{background:#0a7d3a}
.tile .badge[data-d="ng"]{background:#a8261c}
.tile .badge[data-d="fav"]{background:#c08a00}
.tile.is-default .badge{opacity:.55}
.tile .sel-mark{position:absolute;top:4px;left:4px;width:24px;height:24px;border-radius:50%;background:rgba(0,0,0,.5);border:2px solid #fff;display:none;align-items:center;justify-content:center;color:#fff;font-size:14px;font-weight:700}
body.selecting .tile .sel-mark{display:flex}
body.selecting .tile.selected{outline:3px solid #56a;outline-offset:-3px}
body.selecting .tile.selected .sel-mark{background:#56a;border-color:#fff}
body.selecting .tile .badge{display:none}
.selbar{position:sticky;bottom:0;z-index:9;display:flex;align-items:center;gap:10px;padding:10px 14px max(10px,env(safe-area-inset-bottom));background:rgba(20,20,20,.95);border-top:1px solid #333;backdrop-filter:blur(8px)}
.selbar #selCount{flex:1;font-size:13px}
.selbar button{padding:8px 14px;font-size:13px;border-radius:6px;border:1px solid #345;background:#1f1f1f;color:#e8e8e8;cursor:pointer}
.selbar #selSave{background:#0a7d3a;border-color:#0a7d3a;color:#fff;font-weight:600}
.selbar #selSave[disabled]{opacity:.4}
.toast{position:fixed;left:50%;bottom:30%;transform:translateX(-50%);background:rgba(0,0,0,.85);color:#fff;padding:10px 16px;border-radius:8px;font-size:13px;z-index:100;pointer-events:none;max-width:80vw;text-align:center}
.lb{position:fixed;inset:0;background:#000;z-index:50;display:flex;flex-direction:column}
.lb[hidden]{display:none}
.lb .close{position:absolute;top:max(10px,env(safe-area-inset-top));right:10px;width:44px;height:44px;background:rgba(0,0,0,.5);border:0;color:#fff;font-size:24px;border-radius:50%;cursor:pointer;z-index:2}
.lb-stage{flex:1;display:flex;align-items:center;justify-content:center;overflow:hidden;touch-action:pan-y;user-select:none}
.lb-img{max-width:100%;max-height:100%;object-fit:contain;-webkit-user-drag:none;pointer-events:none}
.lb-bottom{padding:10px 14px max(14px,env(safe-area-inset-bottom));background:rgba(0,0,0,.85);border-top:1px solid #222}
.lb-meta{text-align:center;font-size:12px;color:#aaa;margin-bottom:10px}
.lb-actions{display:flex;gap:10px}
.dec{flex:1;height:56px;border-radius:10px;font-size:18px;font-weight:600;border:2px solid transparent;background:#1a1a1a;color:#bbb;cursor:pointer;transition:transform .08s,background .15s,border-color .15s}
.dec:active{transform:scale(.97)}
.dec.ok{border-color:#0a7d3a}
.dec.ng{border-color:#a8261c}
.dec.fav{border-color:#c08a00}
.dec.ok.active{background:#0a7d3a;color:#fff}
.dec.ng.active{background:#a8261c;color:#fff}
.dec.fav.active{background:#c08a00;color:#fff}
.nav{position:absolute;top:50%;transform:translateY(-50%);width:48px;height:48px;border-radius:50%;border:0;background:rgba(0,0,0,.5);color:#fff;font-size:32px;cursor:pointer;z-index:1;display:flex;align-items:center;justify-content:center}
.nav.prev{left:8px}
.nav.next{right:8px}
.nav[disabled]{opacity:.3;pointer-events:none}
.expired{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:60vh;color:#888;text-align:center;padding:20px}
`;

const JS = `(function(){
const G=window.__G__;
const $=id=>document.getElementById(id);
const grid=$("grid"),lb=$("lb"),lbImg=$("lbImg"),lbMeta=$("lbMeta"),lbPrev=$("lbPrev"),lbNext=$("lbNext"),lbClose=$("lbClose"),lbStage=$("lbStage");
const decOk=$("decOk"),decNg=$("decNg"),decFav=$("decFav");
const info=$("info"),hint=$("hint");
const selBtn=$("selBtn"),selBar=$("selBar"),selCount=$("selCount"),selSave=$("selSave"),selCancel=$("selCancel"),toast=$("toast");
const photos=G.photos,decisions=G.decisions||{},def=G.default_decision;
const photoUrl=p=>"/"+G.gid+"/p/"+p.pid;
const fbUrl="/"+G.gid+"/feedback";
const selectedPids=new Set();
let selecting=false;

// ---------- header ----------
const expMs=Date.parse(G.expires_at)-Date.now();
const days=Math.max(0,Math.floor(expMs/86400000));
info.textContent=photos.length+"枚 · 期限 "+(days>0?(days+"日"):"本日中");
hint.textContent="タップして拡大、　"+(def==="ok"?"すべて初期 OK":"すべて初期 NG")+"、ボタンで変更";

// ---------- grid ----------
function decisionFor(pid){return decisions[pid]||def;}
function isDefault(pid){return !decisions[pid];}
function decisionGlyph(d){return d==="ok"?"✓":d==="ng"?"✕":"★";}
function renderGrid(){
  grid.innerHTML=photos.map((p,i)=>{
    const d=decisionFor(p.pid),defCls=isDefault(p.pid)?"is-default":"";
    const selCls=selectedPids.has(p.pid)?" selected":"";
    return '<button class="tile '+defCls+selCls+'" data-i="'+i+'" data-pid="'+p.pid+'" type="button"><img src="'+photoUrl(p)+'" alt="" loading="lazy"><span class="badge" data-d="'+d+'">'+decisionGlyph(d)+'</span><span class="sel-mark">'+(selectedPids.has(p.pid)?"✓":"")+'</span></button>';
  }).join("");
}
renderGrid();

grid.addEventListener("click",e=>{
  const t=e.target.closest(".tile");
  if(!t)return;
  if(selecting){
    toggleSelect(t.dataset.pid,t);
  }else{
    openAt(parseInt(t.dataset.i,10));
  }
});

// ---------- selection mode ----------
function setSelecting(on){
  selecting=on;
  document.body.classList.toggle("selecting",on);
  selBtn.classList.toggle("active",on);
  selBtn.textContent=on?"完了":"選択";
  selBar.hidden=!on;
  if(!on){
    selectedPids.clear();
    grid.querySelectorAll(".tile.selected").forEach(t=>{
      t.classList.remove("selected");
      const m=t.querySelector(".sel-mark");if(m)m.textContent="";
    });
    updateSelCount();
  }
}
function toggleSelect(pid,tileEl){
  if(selectedPids.has(pid)){selectedPids.delete(pid);tileEl.classList.remove("selected");}
  else{selectedPids.add(pid);tileEl.classList.add("selected");}
  const m=tileEl.querySelector(".sel-mark");if(m)m.textContent=selectedPids.has(pid)?"✓":"";
  updateSelCount();
}
function updateSelCount(){
  selCount.textContent=selectedPids.size+" 枚選択中";
  selSave.disabled=selectedPids.size===0;
}
selBtn.addEventListener("click",()=>setSelecting(!selecting));
selCancel.addEventListener("click",()=>setSelecting(false));
selSave.addEventListener("click",()=>downloadSelected([...selectedPids]));

function showToast(msg,ms){
  toast.textContent=msg;toast.hidden=false;
  if(ms){clearTimeout(showToast._t);showToast._t=setTimeout(()=>{toast.hidden=true;},ms);}
}
function hideToast(){toast.hidden=true;}

async function downloadSelected(pids){
  if(pids.length===0)return;
  selSave.disabled=true;
  showToast(pids.length+" 枚を取得中…");
  try{
    const files=[];
    for(let i=0;i<pids.length;i++){
      const pid=pids[i];
      const photo=photos.find(p=>p.pid===pid);
      if(!photo)continue;
      showToast("取得中 "+(i+1)+"/"+pids.length);
      const resp=await fetch(photoUrl(photo));
      if(!resp.ok)throw new Error("fetch "+pid+" failed: "+resp.status);
      const blob=await resp.blob();
      files.push(new File([blob],photo.filename,{type:blob.type||"image/jpeg"}));
    }
    if(navigator.canShare&&navigator.canShare({files:files})){
      hideToast();
      try{
        await navigator.share({files:files});
        // share sheet closed (saved or cancelled); leave selection mode regardless.
        setSelecting(false);
      }catch(err){
        // AbortError just means the user dismissed the sheet — not a real failure.
        if(err&&err.name!=="AbortError"){
          showToast("保存に失敗しました: "+err.message,4000);
        }
      }
    }else{
      // Older browser — fall back to ZIP download.
      hideToast();
      window.location.href="/"+G.gid+"/zip?pids="+pids.join(",");
      setSelecting(false);
    }
  }catch(e){
    showToast("ダウンロード失敗: "+(e&&e.message||e),4000);
  }finally{
    selSave.disabled=selectedPids.size===0;
  }
}

// ---------- lightbox ----------
let cur=-1;
function open(){lb.hidden=false;document.body.style.overflow="hidden";}
function close(){lb.hidden=true;document.body.style.overflow="";cur=-1;}
function openAt(i){cur=i;updateLightbox();open();}
function updateLightbox(){
  const p=photos[cur];lbImg.src=photoUrl(p);
  lbMeta.textContent=(cur+1)+" / "+photos.length+(p.filename?(" · "+p.filename):"");
  lbPrev.disabled=cur<=0;
  lbNext.disabled=cur>=photos.length-1;
  paintDec(p.pid);
}
function paintDec(pid){
  const d=decisionFor(pid);
  decOk.classList.toggle("active",d==="ok");
  decNg.classList.toggle("active",d==="ng");
  decFav.classList.toggle("active",d==="fav");
}
function setDecision(pid,d){
  // Tapping the already-active button clears back to default.
  if(decisions[pid]===d){
    delete decisions[pid];
    post(pid,"clear");
  }else{
    decisions[pid]=d;
    post(pid,d);
  }
  paintDec(pid);
  updateTileBadge(pid);
}
function updateTileBadge(pid){
  const i=photos.findIndex(p=>p.pid===pid);
  if(i<0)return;
  const tile=grid.querySelector('.tile[data-i="'+i+'"]');
  if(!tile)return;
  const badge=tile.querySelector(".badge");
  const d=decisionFor(pid);
  badge.dataset.d=d;
  badge.textContent=decisionGlyph(d);
  tile.classList.toggle("is-default",isDefault(pid));
}
function post(pid,decision){
  fetch(fbUrl,{
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify({pid:pid,decision:decision})
  }).catch(()=>{/* best effort; on next nav model can retry */});
}
lbClose.addEventListener("click",close);
lbPrev.addEventListener("click",()=>{if(cur>0){cur--;updateLightbox();}});
lbNext.addEventListener("click",()=>{if(cur<photos.length-1){cur++;updateLightbox();}});
decOk.addEventListener("click",()=>setDecision(photos[cur].pid,"ok"));
decNg.addEventListener("click",()=>setDecision(photos[cur].pid,"ng"));
decFav.addEventListener("click",()=>setDecision(photos[cur].pid,"fav"));

// keyboard (desktop convenience)
document.addEventListener("keydown",e=>{
  if(lb.hidden)return;
  if(e.key==="Escape")close();
  else if(e.key==="ArrowLeft"&&cur>0){cur--;updateLightbox();}
  else if(e.key==="ArrowRight"&&cur<photos.length-1){cur++;updateLightbox();}
  else if(e.key==="o"||e.key==="O")setDecision(photos[cur].pid,"ok");
  else if(e.key==="x"||e.key==="X")setDecision(photos[cur].pid,"ng");
  else if(e.key==="f"||e.key==="F")setDecision(photos[cur].pid,"fav");
});

// swipe
let tx=0,ty=0,active=false;
lbStage.addEventListener("touchstart",e=>{
  if(e.touches.length!==1)return;
  tx=e.touches[0].clientX;ty=e.touches[0].clientY;active=true;
},{passive:true});
lbStage.addEventListener("touchend",e=>{
  if(!active)return;active=false;
  const t=e.changedTouches[0];
  const dx=t.clientX-tx,dy=t.clientY-ty;
  if(Math.abs(dx)<40||Math.abs(dx)<Math.abs(dy)*1.2)return;
  if(dx<0&&cur<photos.length-1){cur++;updateLightbox();}
  else if(dx>0&&cur>0){cur--;updateLightbox();}
},{passive:true});
})();
`;
