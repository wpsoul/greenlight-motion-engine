/* Lab inspector. Native React inputs remain in place; this view forwards edits
   through the page API and reuses native preset dialogs. Nothing is reparented. */
export function install(STUDIO) {
  const $ = s => document.querySelector(s);
  const api = () => window.GreenLightMotion?.page;
  const svg = (paths) => `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const icons = {
    text:svg('<path d="M4 5h16M12 5v14M8 19h8"/>'),
    shape:svg('<path d="m12 3 9 9-9 9-9-9z"/>'),
    content:svg('<path d="M4 5h16M4 10h16M4 15h10M4 20h7"/>'),
    appearance:svg('<circle cx="12" cy="12" r="8"/><path d="M12 4v16"/>'),
    motion:svg('<path d="M3 17c5 0 4-10 9-10h7M16 3l4 4-4 4"/>'),
    clock:svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    project:svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 4v5M16 4v5"/>'),
    arrow:svg('<path d="M6 18 18 6M6 6h12v12"/>'),
    close:svg('<path d="m7 7 10 10M7 17 17 7"/>'),
    save:svg('<path d="M12 3v12m-4-4 4 4 4-4M4 17v4h16v-4"/>'),
    position:svg('<path d="M12 3v18M3 12h18M9.5 5.5 12 3l2.5 2.5M9.5 18.5 12 21l2.5-2.5M5.5 9.5 3 12l2.5 2.5M18.5 9.5 21 12l-2.5 2.5"/>'),
    mirrorH:svg('<path d="M12 3v18M8 7l-5 5 5 5V7zM16 7l5 5-5 5V7z"/>'),
    mirrorV:svg('<path d="M3 12h18M7 8l5-5 5 5H7zM7 16l5 5 5-5H7z"/>')
  };
  let root, signature='', live=[];
  function make(tag,cls,text){const e=document.createElement(tag);e.className=cls||'';if(text!==undefined)e.textContent=text;return e;}
  function button(label,fn,cls='mi-quiet'){const b=make('button',cls,label);b.type='button';b.onclick=fn;return b;}
  function section(title,icon){const sec=make('section','mi-section');const h=make('h3','mi-heading');h.innerHTML=`<span>${icons[icon]}</span>`;h.append(document.createTextNode(title));sec.append(h);root.querySelector('.mi-scroll').append(sec);const body=make('div','mi-body');sec.append(body);return body;}
  function nativeFields(){return [...document.querySelectorAll('.glm-insp .glm-field')].map(row=>({row,label:row.querySelector('.glm-l')?.textContent.trim()||'',input:row.querySelector('textarea,input:not([type=range]),select'),choose:row.querySelector('button[data-choose],button[data-anim]')}));}
  function commit(field,value){
    const id=field.input.id.replace('glm-field-','');const selected=api().selected();
    if(id.startsWith('layer-')&&selected&&!id.startsWith('layer-trans-'))api().setLayerValue(selected,id.slice(6),value);
    else if(!id.startsWith('layer-'))api().setValue(id,value);
    else {const input=field.input;const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));}
  }
  // a colour's current value: a template field's value when one owns it, else the layer's edit, else the film's own
  function colorNow(inputId){
    const id=inputId.replace('glm-field-',''),vals=api().values(),sel=api().selected(),fields=window.GL_LAB_PROJECT.template?.fields||[];
    if(!id.startsWith('layer-'))return vals[id];
    const path=id.slice(6),owner=fields.find(f=>(f.targets||[]).some(t=>t.itemId===sel&&t.path===path));
    if(owner&&vals[owner.key]!=null)return vals[owner.key];
    return window.LabXform?.valueOf(sel,path,undefined);
  }
  // the film's own colours: the round swatches above the stock palette (the app shows the project's tokens there)
  function filmColours(){
    const p=window.GL_LAB_PROJECT,out=[p.background?.solidColor];
    const now=(it,k)=>window.LabXform?window.LabXform.valueOf(it.id,k,it[k]):it[k];
    for(const ch of p.channels)for(const it of ch.items)out.push(now(it,'textColor'),now(it,'shapeFillColor'));
    Object.values(api().values()).forEach(v=>out.push(v));
    return out.filter(c=>typeof c==='string'&&/^(#|rgba?\()/i.test(c));
  }
  function fieldRow(parent,field){
    const {input,choose,label}=field;const native=()=>document.getElementById(input?.id)||input;   // React may replace the field (a source switch): read the live one
    const row=make('div','mi-row');parent.append(row);const lab=make('label','mi-label',label);row.append(lab);
    if(choose){const controls=make('div','mi-choice');const current=make('span');const b=button('Change',()=>choose.click());controls.append(current,b);row.append(controls);live.push(()=>{current.textContent=field.row.querySelector('.glm-anim > span,.glm-c > span')?.textContent||'None';});return;}
    if(!input)return;
    const id='mi-'+input.id;lab.htmlFor=id;
    if(input.type==='color'){
      // the app's colour field with opacity (color.js); the engine's own input is hex-only, so read the value it holds
      lab.removeAttribute('for');const cp=window.LabColor.field({label,get:()=>colorNow(input.id)??native().value,set:v=>commit(field,v),tokens:filmColours});
      cp.el.classList.add('mi-cp');cp.el.querySelector('.cp-swatch-label').id=id;lab.htmlFor=id;row.append(cp.el);live.push(cp.sync);
    }else if(input.type==='number'){
      const wrap=make('div','mi-nudge');const value=make('input','mi-number');value.id=id;value.type='number';value.min=input.min;value.max=input.max;value.step=input.step||'1';value.setAttribute('aria-label',label);
      function update(n){const min=input.min===''?-Infinity:Number(input.min),max=input.max===''?Infinity:Number(input.max);if(Number.isFinite(n))commit(field,Math.max(min,Math.min(max,n)));}
      for(const delta of [-10,-1]){const b=button(delta===-10?'−10':'−1',()=>update(Number(input.value)+delta*Number(input.step||1)));b.setAttribute('aria-label',`Decrease ${label} by ${Math.abs(delta)} steps`);wrap.append(b);}
      value.onchange=()=>update(value.valueAsNumber);wrap.append(value);
      value.addEventListener('pointerdown',e=>{if(e.button!==0||document.activeElement===value)return;e.preventDefault();const x0=e.clientX,v0=Number(native().value)||0,st=Number(input.step||1)||1;let moved=false;value.setPointerCapture(e.pointerId);
        const move=ev=>{const dx=ev.clientX-x0;if(!moved&&Math.abs(dx)<3)return;moved=true;document.body.classList.add('mi-scrubbing');const k=ev.shiftKey?10:ev.altKey?0.1:1;update(+(v0+Math.round(dx/2)*st*k).toFixed(4));};
        const up=()=>{value.removeEventListener('pointermove',move);value.removeEventListener('pointerup',up);value.removeEventListener('pointercancel',up);document.body.classList.remove('mi-scrubbing');if(!moved){value.focus();value.select();}};
        value.addEventListener('pointermove',move);value.addEventListener('pointerup',up);value.addEventListener('pointercancel',up);});
      for(const delta of [1,10]){const b=button('+'+delta,()=>update(Number(input.value)+delta*Number(input.step||1)));b.setAttribute('aria-label',`Increase ${label} by ${delta} steps`);wrap.append(b);}
      row.append(wrap);live.push(()=>{if(document.activeElement!==value)value.value=native().value;});
    }else{
      row.classList.add('mi-row-text');const value=make('textarea','mi-text');value.id=id;value.rows=label==='Subtitle'?2:3;value.setAttribute('aria-label',label);value.spellcheck=false;value.oninput=()=>commit(field,value.value);row.append(value);live.push(()=>{if(document.activeElement!==value)value.value=native().value;});
    }
  }
  /* Position: the app's Transform section (EditorPanel ▸ TRANSFORM), the same rows and the same fields. Position is
     stored as % of the frame from its centre; px shows the same value times the frame size. Every number drags sideways
     (Shift ×10, Alt ×0.1), takes a typed value, and ↑ / ↓ step it. The dot in the heading puts the layer back where the
     agent placed it. The preview's gizmo writes the same fields, so both move together. */
  const XFORM=['panX','panY','panZ','rotateX','rotateY','rotateZ','scaleX','scaleY','zoom','mirrorH','mirrorV'];
  const XDEF={panX:0,panY:0,panZ:0,rotateX:0,rotateY:0,rotateZ:0,scaleX:1,scaleY:1,zoom:1,mirrorH:false,mirrorV:false};
  const store={get:k=>{try{return localStorage.getItem(k);}catch{return null;}},set:(k,v)=>{try{localStorage.setItem(k,v);}catch{}}};
  function positionSection(layer){
    const id=layer.id,body=section('Position','position'),head=body.parentNode.querySelector('.mi-heading');
    const val=k=>window.LabXform?window.LabXform.valueOf(id,k,XDEF[k]):XDEF[k];
    const authored=k=>{for(const ch of window.GL_LAB_PROJECT.channels)for(const it of ch.items)if(it.id===id)return it[k]??XDEF[k];return XDEF[k];};
    const dot=make('button','mi-dot');dot.type='button';dot.title='Reset position (back to where the agent placed it)';dot.setAttribute('aria-label','Reset position');
    dot.onclick=()=>XFORM.forEach(k=>{if(val(k)!==authored(k))api().setLayerValue(id,k,authored(k));});head.append(dot);
    live.push(()=>dot.classList.toggle('on',XFORM.some(k=>val(k)!==authored(k))));
    const size=()=>window.GL_LAB_PROJECT.videoSize||{w:1920,h:1080};
    let unitPx=store.get('rv-pos-unit')==='px';
    function row(label,extra){const r=make('div','mi-xrow');const h=make('div','mi-xhead');h.append(make('span','mi-label',label));if(extra)h.append(extra);const g=make('div','mi-xgrid');r.append(h,g);body.append(r);return g;}
    function num(grid,axis,title,get,set,{suffix='',min=-Infinity,max=Infinity}={}){
      const f=make('div','mi-ax');f.title=title;const chip=make('span','mi-ax-chip',axis);const input=make('input','mi-ax-in');input.type='text';input.inputMode='decimal';input.setAttribute('aria-label',title);const suf=make('span','mi-ax-suf');f.append(chip,input,suf);grid.append(f);
      const put=v=>{if(Number.isFinite(v))set(Math.max(min,Math.min(max,+v.toFixed(2))));};
      input.onchange=()=>{put(parseFloat(input.value));input.blur();};
      input.onkeydown=e=>{if(e.key==='Enter'){input.blur();}else if(e.key==='ArrowUp'||e.key==='ArrowDown'){e.preventDefault();put(get()+(e.key==='ArrowUp'?1:-1)*(e.shiftKey?10:e.altKey?0.1:1));input.value=fmt(get());}else if(e.key==='Escape'){input.value=fmt(get());input.blur();}};
      const scrub=e=>{if(e.button!==0||document.activeElement===input)return;e.preventDefault();const x0=e.clientX,v0=get();let moved=false;const tgt=e.currentTarget;tgt.setPointerCapture(e.pointerId);
        const mv=ev=>{const dx=ev.clientX-x0;if(!moved&&Math.abs(dx)<3)return;moved=true;document.body.classList.add('mi-scrubbing');put(v0+Math.round(dx/2)*(ev.shiftKey?10:ev.altKey?0.1:1));};
        const up=()=>{tgt.removeEventListener('pointermove',mv);tgt.removeEventListener('pointerup',up);tgt.removeEventListener('pointercancel',up);document.body.classList.remove('mi-scrubbing');if(!moved){input.focus();input.select();}};
        tgt.addEventListener('pointermove',mv);tgt.addEventListener('pointerup',up);tgt.addEventListener('pointercancel',up);};
      chip.addEventListener('pointerdown',scrub);input.addEventListener('pointerdown',scrub);
      const fmt=v=>String(+(+v).toFixed(2));
      live.push(()=>{suf.textContent=typeof suffix==='function'?suffix():suffix;if(document.activeElement!==input)input.value=fmt(get());});
    }
    const seg=make('div','mi-seg');seg.setAttribute('role','group');seg.setAttribute('aria-label','Position unit');
    for(const [k,label,tip] of [['pct','%','% of the frame from the centre — stays put when the resolution changes'],['px','px','Pixels from the centre. Still saved as %, so a resolution change keeps the layout']]){const b=button(label,()=>{unitPx=k==='px';store.set('rv-pos-unit',k);},'mi-seg-btn');b.dataset.unit=k;b.title=tip;seg.append(b);}
    live.push(()=>seg.querySelectorAll('button').forEach(b=>b.classList.toggle('on',(b.dataset.unit==='px')===unitPx)));
    const posK=k=>()=>unitPx?size()[k]/100:1, posSuf=()=>unitPx?'px':'%';
    let g=row('Position',seg);
    num(g,'X','Pan X',()=>val('panX')*posK('w')(),v=>api().setLayerValue(id,'panX',+(v/posK('w')()).toFixed(4)),{suffix:posSuf});
    num(g,'Y','Pan Y',()=>val('panY')*posK('h')(),v=>api().setLayerValue(id,'panY',+(v/posK('h')()).toFixed(4)),{suffix:posSuf});
    num(g,'Z','Pan Z — negative moves away from the camera, positive toward it',()=>val('panZ'),v=>api().setLayerValue(id,'panZ',v),{suffix:'px',min:-3000,max:3000});
    g=row('Rotation');
    for(const a of ['X','Y','Z'])num(g,a,'Rotate '+a,()=>val('rotate'+a),v=>api().setLayerValue(id,'rotate'+a,v),{suffix:'°',min:-180,max:180});
    g=row('Scale');
    num(g,'X','Scale X — stretches the width only',()=>val('scaleX')*100,v=>api().setLayerValue(id,'scaleX',v/100),{suffix:'%',min:10,max:2000});
    num(g,'Y','Scale Y — stretches the height only',()=>val('scaleY')*100,v=>api().setLayerValue(id,'scaleY',v/100),{suffix:'%',min:10,max:2000});
    num(g,'XY','Scale — uniform, multiplies both axes',()=>val('zoom')*100,v=>api().setLayerValue(id,'zoom',v/100),{suffix:'%',min:10,max:2000});
    const mir=make('div','mi-mirror');
    for(const [k,label] of [['mirrorH','Mirror H'],['mirrorV','Mirror V']]){const b=button('',()=>api().setLayerValue(id,k,!val(k)),'mi-mirror-btn');b.innerHTML=icons[k];b.append(document.createTextNode(label));b.title=k==='mirrorH'?'Mirror Horizontal':'Mirror Vertical';mir.append(b);live.push(()=>{const on=!!val(k);b.classList.toggle('on',on);b.setAttribute('aria-pressed',String(on));});}
    body.append(mir);
  }
  function rebuild(fields,layer){
    live=[];root.replaceChildren();
    const head=make('div','mi-selected');const icon=make('span','mi-selected-icon');icon.innerHTML=icons[layer?.type]||icons.project;const text=make('div','mi-selected-text');const title=make('strong','',layer?`${layer.type} · ${layer.name}`:'Project · Background');text.append(title);head.append(icon,text);const info=make('span','mi-info','ⓘ');info.title=layer?'Properties of the selected layer':'Project appearance and shared options';head.append(info);
    if(layer){const close=button('',()=>api().select(null),'mi-icon-button');close.innerHTML=icons.close;close.title='Project options';close.setAttribute('aria-label','Project options');head.append(close);}root.append(head,make('div','mi-scroll'));
    // a layer the engine keeps as data and doesn't draw (a MotionFast template, an After Effects clip): say so, as the page does
    if(layer?.appOnly)root.querySelector('.mi-scroll').append(make('p','lab-copy mi-apponly',`This layer is a ${layer.appOnly}: it plays in GreenLight Dash only, so this page leaves it out.`));
    const textFields=fields.filter(f=>f.input&&['textarea','text'].includes(f.input.type));
    if(textFields.length){const body=section('Content','content');textFields.forEach(f=>fieldRow(body,f));}
    const styleFields=fields.filter(f=>f.input&&!textFields.includes(f)&&!f.input.id.includes('layer-trans-'));
    if(styleFields.length){const body=section('Appearance','appearance');styleFields.forEach(f=>fieldRow(body,f));}
    const animations=fields.filter(f=>f.choose||f.input?.id.includes('layer-trans-'));
    if(animations.length){const body=section('Motion','motion');animations.forEach(f=>fieldRow(body,f));}
    if(layer){
      const body=section('Timing','clock');
      for(const [name,key] of [['In','start'],['Out','end'],['Length',null]]){const row=make('div','mi-row');const lab=make('span','mi-label',name);const val=make('span','mi-time');row.append(lab,val);body.append(row);live.push(()=>{const l=api().layers().find(l=>l.id===layer.id);if(l)val.textContent=(key?l[key]:l.end-l.start).toFixed(2)+' s';});}
      const actions=make('div','mi-actions');actions.append(button('Go to in',()=>{api().pause();api().seek(api().layers().find(l=>l.id===layer.id).start);}),button('Go to out',()=>{api().pause();api().seek(Math.max(0,api().layers().find(l=>l.id===layer.id).end-1/30));}));body.append(actions);
      const reset=[...document.querySelectorAll('.glm-insp button')].find(b=>b.textContent==='Undo the changes to this layer');if(reset)body.append(button('Reset layer changes',()=>reset.click(),'mi-reset'));
      positionSection(layer);
    }else{
      const body=section('Project file','project');const actions=make('div','mi-actions');actions.append(button('Save project',()=>$('#save-project').click(),'mi-primary'));const copy=[...document.querySelectorAll('.glm-insp button')].find(b=>b.textContent==='Copy settings');if(copy)actions.append(button('Copy settings',()=>copy.click()));body.append(actions);
    }
    const foot=make('div','mi-footer');const open=button('Full edit available in GreenLight Dash app',()=>document.querySelector('.glm-top .glm-tbtn:not(.glm-notes-btn)')?.click(),'mi-quiet mi-fulledit');open.insertAdjacentHTML('beforeend',icons.arrow);foot.append(open);root.append(foot);live.forEach(fn=>fn());
  }
  function sync(){
    if(!api()?.ready||!$('.glm-side')){setTimeout(sync,100);return;}
    const side=$('.glm-side');if(!root){root=make('div','lab-inspector');root.setAttribute('aria-label','Layer and project properties');side.append(root);}
    else if(!root.isConnected){side.append(root);signature='';}   // the page was rebuilt
    const useCustom=!$('.glm-app').classList.contains('is-render')&&!api().review.on&&!$('#glm-h-trans');side.classList.toggle('has-lab-inspector',useCustom);root.hidden=!useCustom||document.body.classList.contains('original');
    if(useCustom){
      const fields=nativeFields(),layer=api().layers().find(l=>l.id===api().selected());
      const key=JSON.stringify([layer?.id,fields.map(f=>[f.label,f.input?.id,f.choose?.dataset]),!![...document.querySelectorAll('.glm-insp button')].find(b=>b.textContent==='Undo the changes to this layer')]);
      // Rebuild only when controls change; keep text focus and caret during editing.
      if(key!==signature && !(root.contains(document.activeElement) && document.activeElement.matches('input,textarea'))){signature=key;rebuild(fields,layer);}else live.forEach(fn=>fn());
    }
    setTimeout(sync,120);
  }
  sync();
}
