const $=id=>document.getElementById(id);
let token='',selected=null,resources=[],busy=false,overview={};
const environment=()=>$('environment').value,kind=()=>$('kind').value;
const notice=message=>{$('notice').textContent=message;};
const pretty=value=>JSON.stringify(value,null,2);
const basic=()=>({mode:'completion',enabled:true,defaultVariation:'baseline',rules:[],variations:[{id:'baseline',provider:'custom',model:'your-fast-model',weight:50,messages:[{role:'system',content:'Help with {{topic}}. Be concise.'}],parameters:{temperature:.2}},{id:'candidate',provider:'custom',model:'your-strong-model',weight:50,messages:[{role:'system',content:'Help with {{topic}}. Explain your answer clearly.'}],parameters:{temperature:.2}}]});
function starter(){
  if(kind()==='snippets')return {content:'Help with {{topic}}. Be accurate and concise.',description:'Shared instructions for support configurations.'};
  if(kind()==='segments')return {includedUsers:[],excludedUsers:[],rules:[{attribute:'cohort',operator:'eq',value:'beta'}]};
  if(kind()==='datasets')return{rows:[{id:'case-one',input:'Give a correct answer.',expected:'correct',variables:{topic:'customer support'}}]};
  if(kind()==='judges')return{type:'contains',description:'Check whether the answer includes the expected text.'};
  if(kind()==='graphs')return{root:'helper',maxSteps:5,nodes:[{id:'helper',config:'support-agent'}],edges:[]};
  if(kind()==='models')return{provider:'custom',model:'your-model',parameters:{temperature:.2}};
  if(kind()==='tools')return{description:'Read approved support information.',inputSchema:{type:'object',properties:{query:{type:'string'}},required:['query']},requiresApproval:false};
  const result=basic(),preset=$('preset').value;
  if(preset==='agent'){result.mode='agent';result.variations=result.variations.map(v=>({...v,messages:undefined,instructions:'Help with {{topic}}. Use approved tools only.',tools:[]}));}
  if(preset==='ab'||preset==='bandit')result.experiment={mode:preset,epsilon:.1};
  if(preset==='guard')result.guard={minSamples:10,windowSeconds:300,minQuality:.8,maxLatencyMs:3000,maxCostUsd:.05,maxErrorRate:.1,action:'pause'};
  if(preset==='trigger')result.trigger={metric:'errorRate',threshold:.2,minSamples:10,windowSeconds:300,variation:'candidate'};
  if(preset==='progressive'){result.variations[0].weight=100;result.variations[1].weight=0;result.progressive={variation:'candidate',steps:[10,25,50,100],intervalSeconds:300,minSamples:10};}
  return result;
}
function buttons(){for(const id of ['save','refresh','outcome-button','insights-button'])$(id).disabled=!token||busy;$('resolve-button').disabled=!selected||!['configs','graphs'].includes(kind())||busy;for(const id of ['benchmark-button','run-benchmark','generate-button'])$(id).disabled=!selected||kind()!=='configs'||busy;$('restore-button').disabled=!selected||busy;$('stop').disabled=!selected||kind()!=='configs'||!selected.enabled||busy;}
async function task(action){if(busy)return;busy=true;buttons();notice('Working…');try{await action();}catch(error){notice(error.message);}finally{busy=false;buttons();}}
async function api(path,method='GET',body){const response=await fetch(`/api/${path}?environment=${environment()}`,{method,headers:{...(token&&token!=='@session'?{Authorization:`Bearer ${token}`}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});const result=await response.json();if(!response.ok)throw new Error(result.error.message);return result;}
function table(id,rows,columns){$(id).replaceChildren();if(!rows.length){$(id).textContent='No activity yet.';return;}const wrap=document.createElement('div');wrap.className='table-wrap';wrap.tabIndex=0;wrap.setAttribute('role','region');wrap.setAttribute('aria-label','Scrollable data table');const table=document.createElement('table'),head=document.createElement('thead'),tr=document.createElement('tr');for(const column of columns){const th=document.createElement('th');th.scope='col';th.textContent=column;tr.append(th);}head.append(tr);table.append(head);const body=document.createElement('tbody');for(const row of rows){const tr=document.createElement('tr');for(const column of columns){const td=document.createElement('td');td.textContent=row[column]===null||row[column]===undefined?'—':typeof row[column]==='object'?JSON.stringify(row[column]):String(row[column]);tr.append(td);}body.append(tr);}table.append(body);wrap.append(table);$(id).append(wrap);}
function render(){ $('resources').replaceChildren();if(!resources.length)$('resources').textContent='No resources in this environment. Create one to begin.';for(const resource of resources){const button=document.createElement('button');button.className='flag'+(selected?.key===resource.key?' selected':'');button.setAttribute('aria-pressed',String(selected?.key===resource.key));const title=document.createElement('strong');title.textContent=resource.key;const subtitle=document.createElement('span');subtitle.textContent=`v${resource.version} · ${resource.mode??resource.type??kind()}${resource.enabled!==undefined?(resource.enabled?' · Enabled':' · Stopped'):''}`;button.append(title,subtitle);button.onclick=()=>task(async()=>{select(resource);await history();notice('Resource selected.');});$('resources').append(button);}}
function select(resource){selected=resource;$('key').value=resource?.key??'';$('key').readOnly=!!resource;const doc=resource?structuredClone(resource):starter();delete doc.key;delete doc.version;delete doc.updatedAt;$('document').value=pretty(doc);$('editor-title').textContent=resource?'Edit resource':`Create ${kind()==='configs'?'a configuration':kind()==='datasets'?'a dataset':kind()==='judges'?'a judge':kind()==='graphs'?'a graph':kind()==='snippets'?'a prompt snippet':kind()==='models'?'a model profile':kind()==='tools'?'a tool definition':'an audience segment'}`;$('version').textContent=resource?`Version ${resource.version}`:'New resource';$('history').textContent='No resource selected.';$('preset').disabled=kind()!=='configs';$('apply-preset').disabled=!!resource;render();buttons();renderStructured();}
async function history(){if(selected)$('history').textContent=pretty(await api(`runtime/${kind()}/${selected.key}/history`));}
async function refresh(){const [items,data,audit]=await Promise.all([api(`runtime/${kind()}`),api('runtime/overview'),api('audit')]);resources=items;overview=data;if(selected)select(items.find(r=>r.key===selected.key)??null);else render();await history();$('config-count').textContent=data.configurations.length;$('execution-count').textContent=data.configurations.reduce((s,c)=>s+c.metrics.reduce((sum,m)=>sum+m.samples,0),0);$('eval-count').textContent=data.evaluations.length;$('alert-count').textContent=data.alerts.length;table('performance',data.configurations.flatMap(c=>c.metrics.map(m=>({config:c.key,...m}))),['config','version','variation','samples','quality','latencyMs','errorRate','totalCostUsd','inputTokens','outputTokens','reward']);table('alerts',data.alerts,['key','fromVersion','toVersion','action','reason','timestamp']);table('executions',data.executions.map(e=>({...e,status:e.outcome?(e.outcome.metrics.success?'Succeeded':'Failed'):'Awaiting outcome',quality:e.outcome?.metrics.quality})),['id','key','version','variation','status','quality','createdAt']);table('evaluations',data.evaluations,['config','configVersion','dataset','judge','summaries','timestamp']);table('audit',audit,['action','key','version','actor','timestamp']);}
$('connect').onsubmit=event=>{event.preventDefault();task(async()=>{token=$('token').value.trim();try{const session=await api('session');$('identity').textContent=`${session.tenant} · ${session.role}`;$('token').value='';await refresh();notice('Workspace connected.');}catch(error){token='';$('identity').textContent='Disconnected';throw error;}});};
$('editor').onsubmit=event=>{event.preventDefault();task(async()=>{const body=JSON.parse($('document').value);const saved=await api(`runtime/${kind()}/${$('key').value}`,'PUT',{...body,expectedVersion:selected?.version??0});if(saved.status!=='pending')selected=saved;await refresh();notice(saved.status==='pending'?'Change requested. A different reviewer must approve it.':`Saved ${saved.key}, version ${saved.version}.`);});};
$('resolve').onsubmit=event=>{event.preventDefault();task(async()=>{const result=await api(`runtime/${kind()}/${selected.key}/resolve`,'POST',{context:{userId:$('user').value,attributes:JSON.parse($('attributes').value)},variables:JSON.parse($('variables').value)});$('resolved').textContent=pretty(result);$('trace').value=kind()==='configs'?result.traceId:result.nodes[0].resolved.traceId;await refresh();notice('Runtime configuration resolved.');});};
$('outcome').onsubmit=event=>{event.preventDefault();task(async()=>{const metrics=JSON.parse($('metrics').value);const body={traceId:$('trace').value,metrics};if($('output').value){body.output=$('output').value;body.expected=$('expected').value;}const result=await api('runtime/outcomes','POST',body);$('outcome-result').textContent=pretty(result);await refresh();notice(result.automation?`Safety action: ${result.automation.action}.`:'Outcome recorded.');});};
$('benchmark').onsubmit=event=>{event.preventDefault();task(async()=>{const result=await api('runtime/benchmarks','POST',{config:selected.key,configVersion:selected.version,dataset:$('dataset').value,judge:$('judge').value,outputs:JSON.parse($('outputs').value)});$('benchmark-result').textContent=pretty(result);await refresh();notice('Offline comparison saved.');});};
$('restore').onsubmit=event=>{event.preventDefault();if(!confirm(`Restore ${selected.key} in ${environment()} as a new version? Rollout policies are cleared when restoring a config.`))return;task(async()=>{const saved=await api(`runtime/${kind()}/${selected.key}/restore`,'POST',{version:Number($('restore-version').value),expectedVersion:selected.version});if(saved.status!=='pending')selected=saved;await refresh();notice(saved.status==='pending'?'Restore requested for review.':'Previous resource restored as a new version.');});};
$('stop').onclick=()=>{if(!confirm(`Stop ${selected.key}? Resolution will serve its default variation.`))return;task(async()=>{selected=await api(`runtime/configs/${selected.key}/stop`,'POST',{expectedVersion:selected.version});await refresh();notice('Configuration stopped; default variation will be served.');});};
$('kind').onchange=()=>task(async()=>{resources=[];select(null);if(token)await refresh();notice('Library updated.');});$('environment').onchange=()=>task(async()=>{resources=[];select(null);if(token)await refresh();notice(`Switched to ${environment()}.`);});$('refresh').onclick=()=>task(async()=>{await refresh();notice('Workspace refreshed.');});$('new').onclick=()=>select(null);$('apply-preset').onclick=()=>{$('document').value=pretty(starter());};select(null);

const refreshCore=refresh;
refresh=async()=>{
  await refreshCore();
  const [providers,approvals,playgrounds]=await Promise.all([api('runtime/providers'),api('runtime/approvals'),api('runtime/playground')]);
  await insights();
  $('providers').textContent=providers.filter(p=>p.configured).length?`Configured: ${providers.filter(p=>p.configured).map(p=>p.name).join(', ')}.`:'No model providers configured on the server. Add provider credentials to the server environment to enable generation.';
  table('playgrounds',playgrounds,['config','variation','model','metrics','evaluation','timestamp']);
  $('approvals').replaceChildren();if(!approvals.length)$('approvals').textContent='No requests.';
  for(const request of approvals){const details=document.createElement('details'),summary=document.createElement('summary');summary.textContent=`${request.kind}/${request.key} · ${request.status} · ${request.actor}`;details.append(summary);const pre=document.createElement('pre');pre.textContent=pretty(request.document);details.append(pre);if(request.status==='pending')for(const decision of ['approve','reject']){const button=document.createElement('button');button.className='secondary';button.textContent=decision==='approve'?'Approve change':'Reject change';button.onclick=()=>task(async()=>{await api(`runtime/approvals/${request.id}`,'POST',{decision});await refresh();notice('Review decision recorded.');});details.append(button);}$('approvals').append(details);}
};
$('generate').onsubmit=event=>{event.preventDefault();if(!confirm('Generate with the configured model provider? This sends your input to that provider and may incur usage charges.'))return;task(async()=>{const result=await api('runtime/playground','POST',{config:selected.key,configVersion:selected.version,variation:$('generate-variation').value,input:$('generate-input').value,variables:JSON.parse($('variables').value),expected:$('generate-expected').value,...($('generate-judge').value?{judge:$('generate-judge').value}:{}),allowProviderCalls:true});$('generation').textContent=pretty(result);await refresh();notice('Playground completion saved.');});};
$('run-benchmark').onclick=()=>{if(!confirm('Generate and judge this dataset with configured providers? This can make multiple billable provider calls.'))return;task(async()=>{const result=await api('runtime/benchmarks/run','POST',{config:selected.key,configVersion:selected.version,dataset:$('dataset').value,judge:$('judge').value,allowProviderCalls:true});$('benchmark-result').textContent=pretty(result);await refresh();notice('Provider-backed evaluation completed.');});};
async function insights(){const query=new URLSearchParams({environment:environment()});if($('insights-from').value)query.set('from',new Date($('insights-from').value).toISOString());if($('insights-to').value)query.set('to',new Date($('insights-to').value).toISOString());const response=await fetch(`/api/runtime/insights?${query}`,{headers:{...(token&&token!=='@session'?{Authorization:`Bearer ${token}`}:{})}});const result=await response.json();if(!response.ok)throw new Error(result.error.message);renderTrend(result.timeline);table('insight-versions',result.variations,['key','version','variation','samples','quality','latencyMs','totalCostUsd','errorRate','reward']);table('insight-timeline',result.timeline,['hour','samples','quality','latencyMs','totalCostUsd','errorRate']);}
$('insights-filter').onsubmit=event=>{event.preventDefault();task(async()=>{await insights();notice('Insights updated.');});};
// Presentation-only navigation. Existing resource and runtime handlers stay in agents.js.
const tabs = [...document.querySelectorAll('[role="tab"]')];
function activate(tab, focus = false) {
  for (const item of tabs) {
    const selected = item === tab;
    item.setAttribute('aria-selected', String(selected));
    item.tabIndex = selected ? 0 : -1;
    document.getElementById(item.getAttribute('aria-controls')).hidden = !selected;
  }
  const headings={configure:"Configuration studio",test:"Test your next release",monitor:"Runtime insights",activity:"Workspace activity"};
  $("workspace-heading").textContent=headings[tab.dataset.view];
  if (focus) tab.focus();
}
for (const tab of tabs) {
  tab.addEventListener('click', () => activate(tab));
  tab.addEventListener('keydown', event => {
    const index = tabs.indexOf(tab);
    const next = ['ArrowRight','ArrowDown'].includes(event.key) ? (index + 1) % tabs.length
      : ['ArrowLeft','ArrowUp'].includes(event.key) ? (index + tabs.length - 1) % tabs.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
    if (next !== null) { event.preventDefault(); activate(tabs[next], true); }
  });
}
function selection() {
  const key = document.getElementById('key');
  document.getElementById('selected-context').textContent = key.readOnly && key.value ? key.value : 'New resource';
  document.getElementById('selected-version').textContent = key.readOnly ? document.getElementById('version').textContent : '';
}
new MutationObserver(selection).observe(document.getElementById('version'), { childList: true, subtree: true, characterData: true });
selection();


// Structured configuration controls preserve the full underlying JSON document.
function configField(label, value, update, {type='text', options, area=false, id,min=0,max=100,step='any'}={}) {
  const wrapper=document.createElement('label');wrapper.textContent=label;
  const input=document.createElement(area?'textarea':options?'select':'input');
  if(id)input.id=id;
  if(options)for(const value of options){const option=document.createElement('option');option.value=value;option.textContent=value;input.append(option);}
  if(!area&&!options)input.type=type;
  if(type==='number'){input.min=String(min);input.max=String(max);input.step=String(step);}
  if(area)input.rows=4;
  input.value=value??'';
  input.addEventListener('input',()=>{
    try{const doc=JSON.parse($('document').value);update(doc,type==='number'?Number(input.value):input.value);$('document').value=pretty(doc);}
    catch{notice('Fix the advanced JSON document before editing these fields.');}
  });
  wrapper.append(input);return wrapper;
}
function renderStructured(){
  const target=$('visual-editor');if(!target)return;target.replaceChildren();
  if(kind()==='graphs'){target.hidden=false;renderGraph(target);return;}
  if(kind()==='snippets'){target.hidden=false;let doc;try{doc=JSON.parse($('document').value);}catch{return;}target.append(configField('Prompt content',doc.content,(d,v)=>d.content=v,{area:true,id:'snippet-content'}),configField('Description',doc.description,(d,v)=>d.description=v,{id:'snippet-description'}));const help=document.createElement('p');help.className='hint';help.textContent='Configurations pin a specific snippet version. Save a new configuration version when you want to adopt an updated prompt.';target.append(help);return;}
  if(kind()!=='configs'){target.hidden=true;$('advanced-editor').open=true;return;}
  if(target.hidden)$('advanced-editor').open=false;
  target.hidden=false;let doc;try{doc=JSON.parse($('document').value);}catch{return;}
    if(!doc||!Array.isArray(doc.variations)||doc.variations.some(v=>!v||typeof v!=='object'||(v.messages!=null&&(!Array.isArray(v.messages)||v.messages.some(m=>!m||typeof m.role!=='string')))))return;
  if(doc.rules!==undefined&&(!Array.isArray(doc.rules)||doc.rules.some(r=>!r||typeof r!=='object')))return;
  const overview=document.createElement('div');overview.className='editor-overview';
  overview.append(configField('Default variation',doc.defaultVariation,(d,v)=>d.defaultVariation=v,{options:doc.variations.map(v=>v.id)}));
  overview.append(configField('Serving status',doc.enabled?'Enabled':'Stopped',(d,v)=>d.enabled=v==='Enabled',{options:['Enabled','Stopped']}));
  target.append(overview);
  if(doc.experiment){const fields=document.createElement('div');fields.className='variation-fields';const metrics={Quality:'quality',Reward:'reward',Satisfaction:'satisfaction','Error rate':'errorRate'};fields.append(configField('Experiment metric',Object.keys(metrics).find(label=>metrics[label]===(doc.experiment.metric??'reward')),(d,v)=>d.experiment.metric=metrics[v],{options:Object.keys(metrics),id:'experiment-metric'}),configField('Control variation',doc.experiment.baseline??doc.defaultVariation,(d,v)=>d.experiment.baseline=v,{options:doc.variations.map(v=>v.id),id:'experiment-baseline'}),configField('Minimum subjects per variation',doc.experiment.minSamples??30,(d,v)=>d.experiment.minSamples=v,{type:'number',min:2,max:10000,step:1,id:'experiment-minimum'}),configField('Confidence level (%)',(1-(doc.experiment.alpha??.05))*100,(d,v)=>d.experiment.alpha=1-v/100,{type:'number',min:80,max:99.9,step:.1,id:'experiment-confidence'}));target.append(fields);}
  if(doc.experiment?.mode==='ab'){target.append(configField('Winner promotion',doc.experiment.autoPromote?'Promote conclusive winner':'Require manual promotion',(d,v)=>d.experiment.autoPromote=v==='Promote conclusive winner',{options:['Require manual promotion','Promote conclusive winner'],id:'experiment-promotion'}));const help=document.createElement('p');help.className='hint';help.textContent='Automatic promotion waits for a winner that beats every active variation. Production review still applies when enabled.';target.append(help);}
  renderTargeting(target,doc);
  doc.variations.forEach((variation,index)=>{
    const card=document.createElement('details');card.className='variation-card';card.open=index===0;
    const header=document.createElement('summary');header.className='variation-header';const title=document.createElement('h3');title.textContent=variation.id;
    const badge=document.createElement('span');badge.className='variation-badge';badge.textContent=variation.id===doc.defaultVariation?'Default variation':'Candidate variation';header.append(title,badge);card.append(header);
    const fields=document.createElement('div');fields.className='variation-fields';
    fields.append(configField('Provider',variation.provider,(d,v)=>d.variations[index].provider=v,{options:['custom','openai','anthropic','gemini','bedrock'],id:`provider-${index}`}));
    fields.append(configField('Model',variation.model,(d,v)=>d.variations[index].model=v,{id:`model-${index}`}));
    fields.append(configField('Traffic weight (%)',variation.weight,(d,v)=>d.variations[index].weight=v,{type:'number',id:`weight-${index}`}));
    const mode=document.createElement('p');mode.className='editor-note';mode.textContent=doc.mode==='agent'?'Agent instructions and tools':'Prompt-based completion';fields.append(mode);
    if(doc.mode==='agent'){
      const prompt=configField('Instructions',variation.instructions,(d,v)=>{d.variations[index].instructions=v;delete d.variations[index].instructionsRef;},{area:true,id:`prompt-${index}`});prompt.className='prompt-field';fields.append(prompt);
      fields.append(snippetReference(variation.instructionsRef,ref=>{const current=JSON.parse($('document').value);if(ref)current.variations[index].instructionsRef=ref;else delete current.variations[index].instructionsRef;$('document').value=pretty(current);},`instructions-${index}`));
    }else (variation.messages??[]).forEach((message,messageIndex)=>{
      const prompt=configField(`${message.role.charAt(0).toUpperCase()+message.role.slice(1)} prompt`,message.content,(d,v)=>{d.variations[index].messages[messageIndex].content=v;delete d.variations[index].messages[messageIndex].snippetRef;},{area:true,id:`prompt-${index}-${messageIndex}`});prompt.className='prompt-field';fields.append(prompt);
      fields.append(snippetReference(message.snippetRef,ref=>{const current=JSON.parse($('document').value);if(ref)current.variations[index].messages[messageIndex].snippetRef=ref;else delete current.variations[index].messages[messageIndex].snippetRef;$('document').value=pretty(current);},`message-${index}-${messageIndex}`));
    });
    card.append(fields);target.append(card);
  });
}
function snippetReference(ref,write,id){
  const group=document.createElement('div');group.className='row';
  const label=document.createElement('label');label.textContent='Shared snippet key (optional)';const key=document.createElement('input');key.id=`snippet-key-${id}`;key.value=ref?.key??'';key.placeholder='support-policy';label.append(key);
  const versionLabel=document.createElement('label');versionLabel.textContent='Snippet version';const version=document.createElement('input');version.id=`snippet-version-${id}`;version.type='number';version.min='1';version.step='1';version.value=ref?.version??'';version.placeholder='Latest on save';versionLabel.append(version);
  const update=()=>{try{write(key.value?{key:key.value,...(version.value?{version:Number(version.value)}:{})}:null);}catch{notice('Fix the configuration document before linking a snippet.');}};key.addEventListener('input',update);version.addEventListener('input',update);group.append(label,versionLabel);return group;
}
function renderTargeting(target,doc){
  const section=document.createElement('details');section.className='variation-card';const title=document.createElement('summary');title.textContent=`Audience targeting · ${(doc.rules??[]).length} rules`;section.append(title);
  for(const [index,rule]of (doc.rules??[]).entries()){const row=document.createElement('div');row.className='row';const description=document.createElement('p');description.textContent=rule.segment?`Segment ${rule.segment} → ${rule.variation}`:`${rule.attribute} ${rule.operator} ${JSON.stringify(rule.value)} → ${rule.variation}`;const remove=document.createElement('button');remove.type='button';remove.className='secondary';remove.textContent=`Remove rule ${index+1}`;remove.onclick=()=>{const current=JSON.parse($('document').value);current.rules.splice(index,1);$('document').value=pretty(current);renderStructured();};row.append(description,remove);section.append(row);}
  const fields=document.createElement('div');fields.className='variation-fields';const controls={};for(const [name,label,options]of [['attribute','Context attribute',null],['operator','Operator',['eq','in','gte','lte','contains']],['value','Value (JSON)',null],['variation','Target variation',doc.variations.map(v=>v.id)],['segment','Segment key (optional)',null]]){const wrapper=document.createElement('label'),input=document.createElement(options?'select':'input');wrapper.append(document.createTextNode(label));if(options)for(const value of options){const option=document.createElement('option');option.value=option.textContent=value;input.append(option);}input.setAttribute('aria-label',label);controls[name]=input;wrapper.append(input);fields.append(wrapper);}controls.value.value='"beta"';controls.attribute.value='cohort';section.append(fields);const add=document.createElement('button');add.type='button';add.className='secondary';add.textContent='Add targeting rule';add.onclick=()=>{try{const current=JSON.parse($('document').value),rule=controls.segment.value?{segment:controls.segment.value,variation:controls.variation.value}:{attribute:controls.attribute.value,operator:controls.operator.value,value:JSON.parse(controls.value.value),variation:controls.variation.value};current.rules??=[];current.rules.push(rule);$('document').value=pretty(current);renderStructured();notice('Targeting rule added. Save a version to apply it.');}catch{notice('Use a valid JSON value: a quoted string, number, Boolean or array.');}};section.append(add);target.append(section);
}
function renderGraph(target){
  let doc;try{doc=JSON.parse($('document').value);}catch{return;}
  if(!Array.isArray(doc?.nodes)||!Array.isArray(doc.edges))return;
  if(doc.nodes.some(n=>!n||typeof n.id!=='string'||typeof n.config!=='string')||doc.edges.some(e=>!e||typeof e.from!=='string'||typeof e.to!=='string'))return;
  const write=()=>{$('document').value=pretty(doc);draw();};
  const intro=document.createElement('p');intro.textContent='Connect agent configurations into a bounded workflow. Every node must be reachable from the root.';target.append(intro);
  const canvas=document.createElementNS('http://www.w3.org/2000/svg','svg');canvas.classList.add('graph-canvas');canvas.setAttribute('viewBox','0 0 660 300');canvas.setAttribute('role','img');target.append(canvas);
  function draw(){canvas.replaceChildren();canvas.setAttribute('aria-label',`Agent graph. Root ${doc.root}. ${doc.nodes.map(n=>`${n.id}: ${n.config}`).join('. ')}. Connections: ${doc.edges.map(e=>`${e.from} to ${e.to}`).join(', ')}`);const points=new Map(doc.nodes.map((n,i)=>[n.id,{x:110+(i%3)*220,y:45+Math.floor(i/3)*90}]));canvas.setAttribute('viewBox',`0 0 660 ${Math.max(200,Math.ceil(doc.nodes.length/3)*90+30)}`);for(const edge of doc.edges){const a=points.get(edge.from),b=points.get(edge.to);if(!a||!b)continue;const line=document.createElementNS(canvas.namespaceURI,'path');line.setAttribute('d',a===b?`M ${a.x+60} ${a.y} C ${a.x+110} ${a.y-50}, ${a.x+110} ${a.y+50}, ${a.x+60} ${a.y+10}`:`M ${a.x} ${a.y} L ${b.x} ${b.y}`);line.setAttribute('fill','none');line.setAttribute('stroke','#747a6f');line.setAttribute('stroke-width','2');canvas.append(line);}for(const node of doc.nodes){const p=points.get(node.id);const rect=document.createElementNS(canvas.namespaceURI,'rect');for(const [key,value]of Object.entries({x:p.x-85,y:p.y-24,width:170,height:48,rx:12,fill:node.id===doc.root?'#a7ff35':'#fafaf8',stroke:'#c8cec1'}))rect.setAttribute(key,value);const text=document.createElementNS(canvas.namespaceURI,'text');text.setAttribute('x',p.x);text.setAttribute('y',p.y+5);text.setAttribute('text-anchor','middle');text.setAttribute('fill','#171717');text.textContent=node.id;canvas.append(rect,text);}}
  const controls=document.createElement('div');controls.className='row';controls.append(configField('Root node',doc.root,(d,v)=>{doc=d;doc.root=v;write();},{options:doc.nodes.map(n=>n.id)}));controls.append(configField('Maximum steps',doc.maxSteps,(d,v)=>{doc=d;doc.maxSteps=v;write();},{type:'number'}));target.append(controls);
  for(const node of doc.nodes){const item=document.createElement('div');item.className='variation-card';const title=document.createElement('h3');title.textContent=node.id;item.append(title,configField('Agent configuration key',node.config,(d,v)=>{doc=d;doc.nodes.find(n=>n.id===node.id).config=v;write();}));const remove=document.createElement('button');remove.type='button';remove.className='secondary';remove.textContent=`Remove ${node.id}`;remove.onclick=()=>{doc.nodes=doc.nodes.filter(n=>n.id!==node.id);doc.edges=doc.edges.filter(e=>e.from!==node.id&&e.to!==node.id);if(doc.root===node.id)doc.root=doc.nodes[0]?.id??'';write();renderStructured();};item.append(remove);target.append(item);}
  const add=document.createElement('div');add.className='row';const nodeId=document.createElement('input'),config=document.createElement('input');nodeId.maxLength=config.maxLength=64;nodeId.setAttribute('aria-label','New node ID');nodeId.placeholder='Node ID';config.setAttribute('aria-label','New agent configuration key');config.placeholder='Agent config key';const button=document.createElement('button');button.type='button';button.textContent='Add node';add.append(nodeId,config,button);button.onclick=e=>{e.preventDefault();e.stopPropagation();if(!/^[a-z][a-z0-9-]{1,63}$/.test(nodeId.value)||!/^[a-z][a-z0-9-]{1,63}$/.test(config.value)){notice('Use lowercase node and config keys of 2–64 characters.');nodeId.focus();return;}if(doc.nodes.some(n=>n.id===nodeId.value)){notice('Node IDs must be unique.');return;}doc.nodes.push({id:nodeId.value,config:config.value});write();renderStructured();};target.append(add);
  const heading=document.createElement('h3');heading.textContent='Connections';target.append(heading);
  for(const [index,edge]of doc.edges.entries()){const row=document.createElement('div');row.className='row';const label=document.createElement('p');label.textContent=`${edge.from} → ${edge.to}`;const remove=document.createElement('button');remove.type='button';remove.className='secondary';remove.textContent=`Remove connection ${edge.from} to ${edge.to}`;remove.onclick=()=>{doc.edges.splice(index,1);write();renderStructured();};row.append(label,remove);target.append(row);}
  const edgeForm=document.createElement('div');edgeForm.className='row';const values={};for(const field of ['from','to']){const label=document.createElement('label');label.textContent=field==='from'?'From node':'To node';const select=document.createElement('select');for(const n of doc.nodes){const option=document.createElement('option');option.value=option.textContent=n.id;select.append(option);}values[field]=select;label.append(select);edgeForm.append(label);}const connect=document.createElement('button');connect.type='button';connect.textContent='Connect nodes';edgeForm.append(connect);connect.onclick=e=>{e.preventDefault();e.stopPropagation();const edge={from:values.from.value,to:values.to.value};if(!doc.edges.some(e=>e.from===edge.from&&e.to===edge.to))doc.edges.push(edge);write();renderStructured();};target.append(edgeForm);draw();
}
$('document').addEventListener('input',renderStructured);
$('apply-preset').addEventListener('click',renderStructured);
$('resource-search').addEventListener('input',filterResources);
function filterResources(){const query=$('resource-search').value.toLowerCase();for(const item of $('resources').querySelectorAll('button'))item.hidden=!item.textContent.toLowerCase().includes(query);}
new MutationObserver(filterResources).observe($('resources'),{childList:true});
new MutationObserver(()=>{
  document.body.dataset.working=String($('notice').textContent==='Working…');
  if($('identity').textContent!=='Disconnected'){$('connection-status').textContent=$('identity').textContent;document.querySelector('.workspace-connection').open=false;}
}).observe($('notice'),{childList:true,subtree:true});
renderStructured();
function renderTrend(rows){
  const chart=$('execution-chart');chart.replaceChildren();
  if(!rows.length){const empty=document.createElement('p');empty.className='chart-empty';empty.textContent='Execution volume appears here as your application reports outcomes.';chart.append(empty);return;}
  const entries=rows.slice(-24),max=Math.max(...entries.map(row=>row.samples),1);
  for(const row of entries){const column=document.createElement('div');column.className='chart-column';const bar=document.createElement('div');bar.className='chart-bar';bar.style.height=`${Math.max(row.samples/max*120,3)}px`;bar.title=`${row.hour}: ${row.samples} executions`;const label=document.createElement('span');label.textContent=String(row.samples);column.append(label,bar);chart.append(column);}
  chart.setAttribute('role','img');chart.setAttribute('aria-label',`Hourly execution volume: ${entries.map(row=>`${row.hour}: ${row.samples}`).join('; ')}`);
}



(async()=>{const r=await fetch('/api/session');if(!r.ok)return;const identity=await r.json();token='@session';$('identity').textContent=`${identity.tenant} · ${identity.role}`;task(async()=>{await refresh();notice('Account session restored.');});})();

'use strict';
// Integrates with the existing editor and keeps provider execution explicitly opted in.
async function imageAttachments(files) {
  if(files.length>3)throw new Error('Choose up to three images.');
  return Promise.all([...files].map(file=>{if(file.size>500000||!['image/png','image/jpeg','image/webp'].includes(file.type))throw new Error('Use PNG, JPEG or WebP images no larger than 500 KB.');return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve({data:reader.result});reader.onerror=()=>reject(new Error('Image could not be read.'));reader.readAsDataURL(file);});}));
}
async function streamingPlayground(body){
  const response=await fetch(`/api/runtime/playground/stream?environment=${encodeURIComponent(environment())}`,{method:'POST',headers:{'Content-Type':'application/json',...(token&&token!=='@session'?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)});
  if(!response.ok){const result=await response.json();throw new Error(result.error.message);}
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',result=null,text='';$('generation').textContent='Waiting for the first response…';
  try{while(true){const {value,done}=await reader.read();buffer+=decoder.decode(value,{stream:!done});let end;while((end=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);const line=frame.split('\n').find(l=>l.startsWith('data: '));if(!line)continue;const event=JSON.parse(line.slice(6));if(event.type==='error')throw new Error(event.error.message);if(event.type==='delta'){text+=event.text;$('generation').textContent=text;}if(event.type==='tool')notice(`Running approved tool: ${event.name}…`);if(event.type==='completed')result=event.result;}if(done)break;}}finally{await reader.cancel();}
  if(!result)throw new Error('The response stream was interrupted. Retry when the connection is stable.');return result;
}
$('generate').onsubmit=event=>{event.preventDefault();if(!selected)return;if(!confirm('Run this configuration with your provider account? Input and attached images will be sent to the provider and usage charges may apply.'))return;task(async()=>{const body={config:selected.key,configVersion:selected.version,variation:$('generate-variation').value,input:$('generate-input').value,variables:JSON.parse($('variables').value),expected:$('generate-expected').value,...($('generate-judge').value?{judge:$('generate-judge').value}:{}),attachments:await imageAttachments($('generate-images').files),allowProviderCalls:true,allowToolCalls:$('generate-tools').checked,approvedTools:$('generate-approved').value.split(',').map(v=>v.trim()).filter(Boolean)};const result=$('generate-stream').checked?await streamingPlayground(body):await api('runtime/playground','POST',body);$('generation').textContent=pretty(result);await refresh();notice('Playground completion saved.');});};
