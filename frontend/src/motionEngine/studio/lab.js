/* global GreenLightMotion, RV */   // window globals the studio parts share (studio/index.js)
/* Review lab shell: mounts the engine page and runs the left rail (Sources, Layers, Project, Keys).
   React keeps ownership of the engine UI; nothing it renders is reparented. Edits use the page API. */
export function install(STUDIO) {
  const $ = s => document.querySelector(s);
  const icons = {
    sources:'<rect x="3" y="3" width="18" height="18" rx="2.5"/><path d="M8 3v18M16 3v18M3 12h18M3 7.5h5M3 16.5h5M16 7.5h5M16 16.5h5"/>',
    layers:'<path d="m3 7 9-5 9 5-9 5zM3 12l9 5 9-5M3 17l9 5 9-5"/>',
    sliders:'<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="18" r="2"/>',
    keys:'<rect x="2" y="5" width="20" height="14" rx="3"/><path d="M5 9h2m2 0h2m2 0h2m2 0h2M5 12h2m2 0h2m2 0h2m2 0h2M7 16h10"/>'
  };
  document.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">'+icons[el.dataset.icon]+'</svg>'; });
  if (!window.GreenLightMotion) { $('#loading').textContent='The local engine bundle is missing. Run: cd frontend && npm run build:motion-engine'; return; }
  let handle=GreenLightMotion.mountPage(STUDIO.el, {project:window.GL_LAB_PROJECT,theme:'dark',assets:STUDIO.assets});
  const api = () => GreenLightMotion.page;
  // a card without Edit (rendered videos: nothing to edit here) has no Layers or Project tab and opens on Sources
  const CFG=window.RV_CONFIG||{}, EDIT=!CFG.modes||CFG.modes.includes('edit');
  if(!EDIT)document.querySelectorAll('[data-tab=layers],[data-tab=project]').forEach(b=>b.hidden=true);
  let activeTab=EDIT?'layers':'sources', toastTimer;
  function toast(message){$('#lab-toast').textContent=message;$('#lab-toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#lab-toast').classList.remove('visible'),2500);}
  function options(){ const back=$('.glm-side .glm-icon[aria-label="Back to Options"]');if(back)back.click();api().selectTransition(null);api().select(null); }
  const titles={sources:'Sources',layers:'Layers',project:'Project',keys:'Keys'};
  function tab(name,{expand=true}={}){
    if(!EDIT&&(name==='layers'||name==='project'))return;
    if(expand)$('.lab-side').classList.toggle('expanded', activeTab!==name || !$('.lab-side').classList.contains('expanded'));
    activeTab=name;
    document.querySelectorAll('[data-tab]').forEach(el=>{const on=el.dataset.tab===name;el.classList.toggle('active',on);el.setAttribute('aria-pressed',String(on));});
    ['sources','layers','project','keys'].forEach(key=>{$('#'+key+'-pane').hidden=key!==name;});
    $('#pane-title').textContent=titles[name];
    $('#layer-count').hidden=name!=='sources';$('#nav-tools').hidden=name!=='layers';
    if(name==='layers'&&window.RV&&RV.mode()!=='edit')RV.setMode('edit');   // the layers live in Edit: the Navigator takes you there
    if(name==='project'&&window.RV?.mode()==='edit')options();
    syncCount();
  }
  function syncCount(){ $('#layer-count').textContent=activeTab==='sources'?(window.RV?`keys 1–${RV.sources().length}`:''):String(api()?.layers?.().length||''); }
  document.querySelectorAll('[data-tab]').forEach(el=>el.onclick=()=>tab(el.dataset.tab));
  $('#save-project').onclick=async()=>{
    try {
      const data=await api().exportProject();
      const url=URL.createObjectURL(new Blob([JSON.stringify(data.project,null,2)],{type:'application/json'}));
      const a=document.createElement('a');a.href=url;a.download='make-it-move.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
      toast('Project JSON saved');
    }catch(e){toast('Could not save: '+e.message);}
  };
  window.LabSide={tab:(name,o)=>tab(name,o),active:()=>activeTab,toast};

  // ── Layers: the app's Navigator (videoEditor/NavigatorPanel.jsx). Sort: By Channel (the timeline's draw order, the
  //    top row first), By Type, By Time in 1-minute or 10-second chunks (by where a layer starts; empty chunks
  //    skipped). Groups collapse; a row selects its layer; the pencil renames it in place (kept in this browser: the
  //    engine page has no layer names of its own to write). ──
  const GLYPHS={text:'<path d="M5 5.5V4h14v1.5M12 4v16M9 20h6"/>',video:'<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M8.5 5v14M15.5 5v14"/>',image:'<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.6"/><path d="m4.5 17 4.8-4.5 3.6 3.3 3-2.7 3.6 3.6"/>',audio:'<path d="M3 12h2.4M7.5 7v10M11 9.5v5M14.5 5v14M18 9.5v5M21 12h-1.6"/>',camera:'<rect x="2.5" y="7" width="13" height="10" rx="2"/><path d="m15.5 12 6-3.4v6.8z"/>',layer:'<rect x="5" y="5" width="14" height="14" rx="2"/>'};
  const TYPE_LABELS={text:'Text',video:'Video',image:'Images',audio:'Audio',camera:'Camera',html:'HTML',shape:'Shapes',layer:'Other'};
  const store={get:(k,d)=>{try{return localStorage.getItem(k)??d;}catch{return d;}},set:(k,v)=>{try{localStorage.setItem(k,v);}catch{}}};
  let sortMode=store.get('rv-nav-sort','channel'),collapsed=new Set(),renaming=null,navSig='';
  const names=(()=>{try{return JSON.parse(store.get('rv-layer-names','{}'))||{};}catch{return {};}})();
  const nameOf=l=>names[l.id]||l.name;
  $('#nav-sort').value=sortMode;
  $('#nav-sort').onchange=e=>{sortMode=e.target.value;store.set('rv-nav-sort',sortMode);collapsed=new Set();renderNav(true);};
  $('#nav-collapse').onclick=()=>{const g=navGroups();collapsed=collapsed.size>=g.length?new Set():new Set(g.map(x=>x.key));renderNav(true);};
  function navGroups(){
    const byId=new Map(api().layers().map(l=>[l.id,l]));
    const chans=[...window.GL_LAB_PROJECT.channels].reverse().map(ch=>({ch,rows:ch.items.map(it=>byId.get(it.id)).filter(Boolean)}));
    const flat=chans.flatMap(c=>c.rows);
    if(sortMode==='type'){const m=new Map();flat.forEach(l=>{const t=GLYPHS[l.type]?l.type:(l.type==='shape'?'shape':'layer');if(!m.has(t))m.set(t,[]);m.get(t).push(l);});return [...m].map(([t,rows])=>({key:'type:'+t,label:TYPE_LABELS[t]||t,sub:null,rows}));}
    if(sortMode==='time60'||sortMode==='time10'){const size=sortMode==='time10'?10:60,m=new Map();flat.forEach(l=>{const b=Math.floor((l.start||0)/size);if(!m.has(b))m.set(b,[]);m.get(b).push(l);});return [...m].sort(([a],[b])=>a-b).map(([b,rows])=>({key:`time${size}:${b}`,label:size===60?`${b}–${b+1} min`:`${b*10}–${b*10+10}s`,sub:null,rows:rows.sort((x,y)=>(x.start||0)-(y.start||0))}));}
    return chans.map(c=>({key:'ch:'+c.ch.id,label:names[c.ch.items[0]?.id]&&c.ch.items.length===1?names[c.ch.items[0].id]:c.ch.name,sub:c.ch.kind||(c.ch.unsnapped?'free':'sequence'),rows:c.rows}));
  }
  const svg=(p,w=11,sw=1.8)=>`<svg width="${w}" height="${w}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
  function renderNav(force){
    if(renaming)return;
    const groups=navGroups(),sel=api().selected();
    const sig=JSON.stringify([sortMode,[...collapsed],sel,names,selMarker,markers,muted,groups.map(g=>[g.key,g.rows.map(l=>[l.id,l.name,l.start,l.end])])]);
    if(!force&&sig===navSig)return;navSig=sig;renderActs();
    const list=$('#layer-list');list.replaceChildren();
    groups.forEach(g=>{
      const open=!collapsed.has(g.key);const box=document.createElement('div');box.className='ve-nav-channel'+(open?' open':'');
      const head=document.createElement('div');head.className='ve-nav-channel-head';head.setAttribute('role','button');head.tabIndex=0;
      head.innerHTML=`<svg class="ve-nav-arrow" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>`;
      const nm=document.createElement('span');nm.className='ve-nav-channel-name';nm.textContent=g.label;head.append(nm);
      if(g.sub){const t=document.createElement('span');t.className='ve-nav-channel-type';t.textContent=g.sub;head.append(t);}
      const cnt=document.createElement('span');cnt.className='ve-nav-count';cnt.textContent=g.rows.length;head.append(cnt);
      head.onclick=()=>{if(collapsed.has(g.key))collapsed.delete(g.key);else collapsed.add(g.key);renderNav(true);};
      box.append(head);
      if(open){const rows=document.createElement('div');rows.className='ve-nav-layers';
        if(!g.rows.length){const e=document.createElement('div');e.className='ve-nav-empty';e.textContent='No layers';rows.append(e);}
        g.rows.forEach(l=>rows.append(navRow(l,l.id===sel)));box.append(rows);}
      list.append(box);
    });
    if(markers.length){const box=document.createElement('div');box.className='ve-nav-channel open';box.innerHTML=`<div class="ve-nav-channel-head"><svg class="ve-nav-arrow" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg><span class="ve-nav-channel-name">Markers</span><span class="ve-nav-count">${markers.length}</span></div>`;
      const rows=document.createElement('div');rows.className='ve-nav-layers';markers.forEach(m=>{const row=document.createElement('div');row.className='ve-nav-layer rv-nav-marker'+(m.id===selMarker?' selected':'');row.dataset.marker=m.id;row.innerHTML=`<span class="ve-nav-glyph" style="color:${m.color}">${svg(ACT.marker)}</span><span class="ve-nav-name"></span><span class="ve-nav-time">${fmtT(m.time)}</span>`;row.querySelector('.ve-nav-name').textContent=m.label;
        row.onclick=()=>{selMarker=m.id;api().select(null);api().pause();api().seek(m.time);navSig='';renderNav(true);renderActs();drawMarkers();};rows.append(row);});box.append(rows);list.append(box);}
    if(!groups.length){const e=document.createElement('div');e.className='ve-nav-empty';e.textContent='The timeline is empty';list.append(e);}
  }
  function navRow(l,selected){
    const row=document.createElement('div');row.className='ve-nav-layer'+(selected?' selected':'')+(muted[l.id]!=null?' is-muted':'');row.setAttribute('role','button');row.tabIndex=0;row.dataset.id=l.id;
    const glyph=document.createElement('span');glyph.className='ve-nav-glyph';glyph.innerHTML=svg(GLYPHS[l.type]||GLYPHS.layer);row.append(glyph);
    const name=document.createElement('span');name.className='ve-nav-name';name.textContent=nameOf(l);row.append(name);
    const time=document.createElement('span');time.className='ve-nav-time';time.textContent=`${(l.start||0).toFixed(1)}–${(l.end||0).toFixed(1)}s`;row.append(time);
    const pen=document.createElement('button');pen.type='button';pen.className='ve-nav-edit';pen.title='Rename layer';pen.innerHTML=svg('<path d="M17 3.5 20.5 7 8 19.5H4.5V16z"/>');row.append(pen);
    // a click selects the layer (the inspector shows it), as in the app
    row.onclick=()=>{if(renaming)return;selMarker=null;window.RV?.setMode('edit');api().pause();options();api().select(l.id);$('.lab-side').classList.remove('expanded');renderNav(true);};
    pen.onclick=e=>{e.stopPropagation();renaming=l.id;const input=document.createElement('input');input.className='ve-nav-rename';input.value=nameOf(l);input.spellcheck=false;input.autocomplete='off';
      const done=commit=>{if(renaming!==l.id)return;renaming=null;const v=input.value.trim();if(commit&&v&&v!==l.name)names[l.id]=v;else if(commit&&(!v||v===l.name))delete names[l.id];store.set('rv-layer-names',JSON.stringify(names));renderNav(true);syncGutter();};
      input.onclick=ev=>ev.stopPropagation();input.onkeydown=ev=>{ev.stopPropagation();if(ev.key==='Enter')done(true);else if(ev.key==='Escape')done(false);};input.onblur=()=>done(true);
      name.replaceWith(input);input.focus();input.select();};
    return row;
  }
  // the Edit timeline's channel rows: a type glyph, the name, Hide (Mute: the layer stays, it doesn't draw) and Remove;
  // the engine's bars (same order as its layers) carry their layer's id, so a hidden layer's bar reads dimmed
  let gutterSig='';
  function renderGutter(layers){
    const box=$('.glm-tlwrap .lab-track-labels');if(!box)return;
    const bars=[...document.querySelectorAll('.glm-rows .glm-layer')];bars.forEach((b,i)=>{const l=layers[i];if(!l)return;b.dataset.rvId=l.id;b.classList.toggle('rv-hidden',muted[l.id]!=null);});
    const sig=JSON.stringify([layers.map(l=>[l.id,l.type,nameOf(l)]),muted]);if(sig===gutterSig)return;gutterSig=sig;box.replaceChildren();
    layers.forEach(l=>{const row=document.createElement('div');row.className='lab-track-label'+(muted[l.id]!=null?' is-muted':'');row.dataset.id=l.id;
      const g=document.createElement('span');g.className='rv-gl-glyph';g.innerHTML=svg(GLYPHS[l.type]||GLYPHS.layer);
      const n=document.createElement('span');n.className='rv-gl-name';n.textContent=nameOf(l);
      const hide=document.createElement('button');hide.type='button';hide.className='rv-gl-btn'+(muted[l.id]!=null?' on':'');hide.dataset.act='hide';hide.title=muted[l.id]!=null?'Show the layer':'Hide the layer';hide.innerHTML=svg(muted[l.id]!=null?ACT.hide:ACT.show,12,1.8);hide.onclick=e=>{e.stopPropagation();toggleMute(l.id);};
      const del=document.createElement('button');del.type='button';del.className='rv-gl-btn rv-gl-del';del.dataset.act='remove';del.title='Remove the layer';del.innerHTML=svg(ACT.del,12,1.8);del.onclick=e=>{e.stopPropagation();remove(l.id);};
      row.append(g,n,hide,del);row.onclick=()=>{selMarker=null;api().pause();options();api().select(l.id);navSig='';renderNav(true);};box.append(row);});
  }
  function syncGutter(){gutterSig='';renderGutter(api().layers());}
  window.LabNav={names:()=>({...names}),sort:()=>sortMode};

  // ── Edit: add layers (Text, Shape) and markers; a selected layer's Duplicate · Copy · Paste · Mute · Delete
  //    (the Video Editor's selected-layer row). The engine page edits existing layers only, so adding, duplicating
  //    and deleting rebuild the page from its exported project (every edit kept) and the card re-attaches its parts. ──
  const ACT={text:'<path d="M5 5.5V4h14v1.5M12 4v16M9 20h6"/>',shape:'<rect x="4" y="4" width="16" height="16" rx="3"/>',marker:'<path d="M4 22V4a1 1 0 0 1 1-1h13l-3 5 3 5H5"/>',
    duplicate:'<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',copy:'<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    paste:'<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>',
    mute:'<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a9 9 0 0 1 0 14"/>',unmute:'<path d="M11 5 6 9H2v6h4l5 4z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>',
    hide:'<path d="M2 12s3.5-7 10-7c2 0 3.7.6 5.1 1.5M22 12s-3.5 7-10 7c-2 0-3.7-.6-5.1-1.5M3 3l18 18"/>',show:'<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    del:'<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'};
  let rebuilding=false,clipboard=null,selMarker=null;
  const muted=(()=>{try{return JSON.parse(store.get('rv-muted','{}'))||{};}catch{return {};}})();   // layer id → its opacity before Mute
  const markers=(()=>{try{return JSON.parse(store.get('rv-markers','[]'))||[];}catch{return [];}})();
  const saveMarkers=()=>store.set('rv-markers',JSON.stringify(markers));
  const fmtT=t=>`${Math.floor(t/60)}:${(t%60).toFixed(2).padStart(5,'0')}`;
  function itemOfId(id,proj=window.GL_LAB_PROJECT){for(const ch of proj.channels)for(const it of ch.items)if(it.id===id)return {ch,it};return null;}
  const newId=p=>p+Date.now().toString(36)+Math.random().toString(36).slice(2,5);
  // put PROJECT on the page (a rebuild, or another source's own project on a card) and re-attach every part of the card
  async function remount(proj,{at=null,select=null}={}){
    const p=api(),t=at??p?.state().currentTime??0;
    window.GL_LAB_PROJECT=proj;
    handle.unmount();handle=GreenLightMotion.mountPage(STUDIO.el,{project:proj,theme:'dark',assets:STUDIO.assets});
    await new Promise(r=>{const w=()=>{const q=GreenLightMotion.page;if(q&&q!==p&&q.ready&&$('.glm-side')&&$('.glm-tlwrap')&&$('.glm-top'))r();else setTimeout(w,50);};w();});
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    api().seek(Math.min(t,api().duration));if(select)api().select(select);
    window.dispatchEvent(new CustomEvent('rv:remount'));
    navSig='';gutterSig='';renderNav(true);renderActs();drawMarkers();
  }
  async function rebuild(mutate,{select=null}={}){
    if(rebuilding)return;rebuilding=true;document.body.classList.add('rv-rebuilding');
    try{
      // a card keeps the page's changes before they are baked in, and turns the rebuild itself into changes (card.js)
      window.dispatchEvent(new CustomEvent('rv:before-rebuild'));
      const p=api();let proj;
      try{proj=structuredClone((await p.exportProject()).project);}catch{proj=structuredClone(window.GL_LAB_PROJECT);}
      if(!proj.template&&window.GL_LAB_PROJECT.template)proj.template=window.GL_LAB_PROJECT.template;
      const before=structuredClone(proj);
      const sel=mutate(proj)??select;
      await remount(proj,{select:sel});
      window.dispatchEvent(new CustomEvent('rv:rebuilt',{detail:{before,after:proj}}));
    }finally{rebuilding=false;document.body.classList.remove('rv-rebuilding');}
  }
  // a card: another source's project (or the empty film its videos play over)
  async function mount(proj,o={}){
    if(rebuilding)return false;rebuilding=true;document.body.classList.add('rv-rebuilding');
    try{selMarker=null;await remount(proj,o);return true;}finally{rebuilding=false;document.body.classList.remove('rv-rebuilding');}
  }
  window.LabEdit={rebuild,mount,rebuilding:()=>rebuilding,markers:()=>markers.slice(),muted:()=>({...muted}),clipboard:()=>clipboard};
  function addLayer(kind){
    window.RV?.setMode('edit');const at=api().state().currentTime,D=api().duration,len=Math.max(0.5,Math.min(4,D-at)),bg=(api().values().background||'#c9bdf2').toLowerCase();
    const darkBg=parseInt(bg.slice(1,3),16)*.299+parseInt(bg.slice(3,5),16)*.587+parseInt(bg.slice(5,7),16)*.114<128;
    rebuild(proj=>{const id=newId(kind==='text'?'text-':'shape-'),n=proj.channels.filter(c=>c.items.some(i=>(proj.clips.find(k=>k.id===i.clipId)||{}).mediaType===(kind==='text'?'text':'shape'))).length+1;
      const name=kind==='text'?`Text ${n}`:`Shape ${n}`;
      proj.clips.push({id:'c-'+id,mediaType:kind==='text'?'text':'shape',name,duration:len});
      const item=kind==='text'?{id,clipId:'c-'+id,freeStart:at,trimStart:0,trimEnd:len,textContent:'Your words',textFontFamily:'Helvetica Neue, Arial, sans-serif',textFontSize:110,textFontWeight:700,textColor:darkBg?'#edf1ee':'#232128',textAlign:'center',textWidthPct:60,panX:0,panY:0}
        :{id,clipId:'c-'+id,freeStart:at,trimStart:0,trimEnd:len,shapeType:'rectangle',shapeFillColor:api().values().accent||'#33efab',shapeWidthPct:24,shapeHeightPct:24,panX:0,panY:0};
      proj.channels.push({id:'ch-'+id,name,unsnapped:true,items:[item]});return id;});
  }
  function addMarker(){window.RV?.setMode('edit');const t=api().state().currentTime;const m={id:newId('m'),time:+t.toFixed(3),label:`Marker ${markers.length+1}`,color:'#8b5cf6'};markers.push(m);markers.sort((a,b)=>a.time-b.time);saveMarkers();selMarker=m.id;api().select(null);navSig='';renderNav(true);renderActs();drawMarkers();toast(`${m.label} at ${fmtT(m.time)}`);}
  function duplicate(id){rebuild(proj=>{const f=itemOfId(id,proj);if(!f)return null;const nid=newId('copy-');const clip=proj.clips.find(c=>c.id===f.it.clipId);const nclip={...structuredClone(clip||{}),id:'c-'+nid,name:(clip?.name||'Layer')+' copy'};proj.clips.push(nclip);
    const item={...structuredClone(f.it),id:nid,clipId:nclip.id};const ch={...structuredClone(f.ch),id:'ch-'+nid,name:(names[id]||f.ch.name)+' copy',items:[item]};if(f.ch.items.length>1){ch.unsnapped=true;}
    proj.channels.splice(proj.channels.indexOf(f.ch)+1,0,ch);if(muted[id]!=null)muted[nid]=muted[id];store.set('rv-muted',JSON.stringify(muted));return nid;});}
  function remove(id){if(selMarker===id||markers.some(m=>m.id===id)){const i=markers.findIndex(m=>m.id===id);if(i>=0){const m=markers.splice(i,1)[0];saveMarkers();selMarker=null;toast(`${m.label} deleted`);navSig='';renderNav(true);renderActs();drawMarkers();}return;}
    const nm=nameOf(api().layers().find(l=>l.id===id)||{id,name:'the layer'});
    rebuild(proj=>{const f=itemOfId(id,proj);if(!f)return null;f.ch.items=f.ch.items.filter(i=>i!==f.it);if(!f.ch.items.length)proj.channels.splice(proj.channels.indexOf(f.ch),1);if(!proj.channels.some(c=>c.items.some(i=>i.clipId===f.it.clipId)))proj.clips=proj.clips.filter(c=>c.id!==f.it.clipId);delete muted[id];store.set('rv-muted',JSON.stringify(muted));return null;}).then(()=>toast(`${nm} deleted`));}
  // the settings a layer can hand to another: its look, place and motion (never its words, its timing or its identity)
  const NOT_SETTINGS=new Set(['id','clipId','trimStart','trimEnd','freeStart','textContent','customName','name']);
  function settingsOf(id){const f=itemOfId(id);if(!f)return null;const ed=api().edits().itemEdits[id]||{};const all={...structuredClone(f.it),...structuredClone(ed)};const type=(window.GL_LAB_PROJECT.clips.find(c=>c.id===f.it.clipId)||{}).mediaType;
    return {type,from:nameOf(api().layers().find(l=>l.id===id)||{id,name:''}),values:Object.fromEntries(Object.entries(all).filter(([k])=>!NOT_SETTINGS.has(k)))};}
  const SHARED=['panX','panY','scale','scaleX','scaleY','rotation','opacity','propertyKeyframes'];
  function paste(id){if(!clipboard)return;const f=itemOfId(id);if(!f)return;const type=(window.GL_LAB_PROJECT.clips.find(c=>c.id===f.it.clipId)||{}).mediaType;
    const keys=Object.keys(clipboard.values).filter(k=>type===clipboard.type||SHARED.includes(k));keys.forEach(k=>api().setLayerValue(id,k,structuredClone(clipboard.values[k])));
    toast(type===clipboard.type?`Pasted ${clipboard.from}'s settings`:`Pasted ${clipboard.from}'s place and motion`);}
  function toggleMute(id){if(muted[id]!=null){api().setLayerValue(id,'opacity',muted[id]);delete muted[id];}else{const ed=api().edits().itemEdits[id]||{};const f=itemOfId(id);muted[id]=ed.opacity??f?.it.opacity??100;api().setLayerValue(id,'opacity',0);}store.set('rv-muted',JSON.stringify(muted));navSig='';renderNav(true);renderActs();syncGutter();}
  function actBtn(key,label,title,fn,{disabled=false,on=false}={}){const b=document.createElement('button');b.type='button';b.className='rv-act'+(on?' is-on':'');b.dataset.act=key;b.title=title;b.disabled=disabled;b.innerHTML=svg(ACT[key],14,2)+`<span>${label}</span>`;b.onclick=e=>{e.stopPropagation();fn();};return b;}
  // the Edit timeline's toolbar row (the Video Editor's layer buttons): Text · Shape · Marker | the selected layer's
  // Duplicate · Copy · Paste · Mute · Delete (off until a layer is picked; a marker has Delete)
  let editBar=null;
  function renderActs(){
    const wrap=$('.glm-tlwrap');if(!wrap)return;
    if(!editBar){editBar=document.createElement('div');editBar.className='rv-edit-toolbar';editBar.setAttribute('role','toolbar');editBar.setAttribute('aria-label','Layer tools');}
    if(editBar.parentNode!==wrap)wrap.append(editBar);
    const id=api().selected(),mk=selMarker&&markers.find(m=>m.id===selMarker),isMuted=!!id&&muted[id]!=null;
    const sep=document.createElement('i');sep.className='rv-tsep';
    editBar.replaceChildren(
      actBtn('text','Text','Add a text layer at the playhead',()=>addLayer('text')),actBtn('shape','Shape','Add a shape layer at the playhead',()=>addLayer('shape')),...(CFG.markers===false?[]:[actBtn('marker','Marker','Add a timeline marker at the playhead',addMarker)]),sep,
      actBtn('duplicate','Duplicate','Duplicate layer',()=>duplicate(id),{disabled:!id}),
      actBtn('copy','Copy','Copy settings',()=>{clipboard=settingsOf(id);toast(`Copied ${clipboard.from}'s settings`);renderActs();},{disabled:!id}),
      actBtn('paste','Paste','Paste settings'+(clipboard?'':' — copy a layer’s settings first'),()=>paste(id),{disabled:!id||!clipboard}),
      actBtn(isMuted?'unmute':'mute',isMuted?'Unmute':'Mute',isMuted?'Show this layer again':'Turn this layer off: it stays, it does not draw',()=>toggleMute(id),{disabled:!id,on:isMuted}),
      actBtn('del','Delete',mk?'Delete this marker':'Delete layer',()=>remove(mk?mk.id:id),{disabled:!id&&!mk}));
  }
  // markers: the Video Editor's purple pins on the Edit timeline's ruler; a click goes there
  function drawMarkers(){const bar=$('.glm-bar');if(!bar)return;let box=bar.querySelector('.rv-markers');if(!box){box=document.createElement('div');box.className='rv-markers';bar.append(box);}box.replaceChildren();
    markers.forEach(m=>{const b=document.createElement('button');b.type='button';b.className='rv-marker'+(m.id===selMarker?' on':'');b.style.left=`${m.time/api().duration*100}%`;b.title=`${m.label} · ${fmtT(m.time)}`;b.innerHTML='<i></i>';b.onpointerdown=e=>e.stopPropagation();b.onclick=e=>{e.stopPropagation();selMarker=m.id;api().select(null);api().pause();api().seek(m.time);navSig='';renderNav(true);renderActs();drawMarkers();};box.append(b);});}
  window.addEventListener('rv:remount',()=>{});
  function sync(){
    if(!api()?.ready||rebuilding){setTimeout(sync,100);return;}
    if(!$('.glm-bar .rv-markers'))drawMarkers();
    $('.lab-side').hidden=false;
    const layers=api().layers(),selected=api().selected();
    syncCount();
    renderNav();
    const timeline=$('.glm-tlwrap');
    if(timeline&&!timeline.querySelector('.lab-track-labels')){
      const labels=document.createElement('div');labels.className='lab-track-labels';
      timeline.append(labels);gutterSig='';
      // the names follow the rows; cut off what moved up past the rows' top, or they would slide over the toolbar and the ruler
      $('.glm-rows').addEventListener('scroll',e=>{const y=e.target.scrollTop;labels.style.transform=`translateY(-${y}px)`;labels.style.clipPath=y?`inset(${y}px 0 0 0)`:'';});
    }
    renderGutter(layers);
    if(!editBar||!editBar.isConnected||editBar.dataset.sel!==String(api().selected())+'|'+selMarker){renderActs();editBar.dataset.sel=String(api().selected())+'|'+selMarker;}
    const mode=$('.glm-mode span');
    if(mode&&mode.textContent!=='Live preview')mode.textContent='Live preview';
    setTimeout(sync,180);
  }
  const start=setInterval(()=>{if(api()?.ready){clearInterval(start);if(!EDIT)tab(activeTab,{expand:false});api().seek(CFG.startAt??2.4);sync();}},100);
}
