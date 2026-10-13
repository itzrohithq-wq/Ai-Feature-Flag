const $ = id => document.getElementById(id);
let token = '', flags = [], selected = null, busy = false;
const environment = () => $('environment').value;
const notice = message => { $('notice').textContent = message; };
function buttons() { $('save').disabled = !token || busy; $('refresh').disabled = !token || busy; $('kill').disabled = !selected || busy || !selected.enabled; $('evaluate-button').disabled = !selected || busy; }
async function api(path, method = 'GET', body) {
  const response = await fetch(`/api/${path}?environment=${environment()}`, { method, headers: { ...(token&&token!=='@session'?{Authorization:`Bearer ${token}`}:{}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error.message); return data;
}
async function task(action) { if(busy) return; busy = true; buttons(); notice('Working…'); try { await action(); } catch(error) { notice(error.message); } finally { busy = false; buttons(); } }
function table(target, rows, columns) {
  $(target).replaceChildren(); if (!rows.length) { $(target).textContent = 'No activity yet.'; return; }
  const wrap = document.createElement('div'); wrap.className = 'table-wrap'; wrap.tabIndex=0; wrap.setAttribute('role','region'); wrap.setAttribute('aria-label','Scrollable data table'); const el = document.createElement('table'); const head = document.createElement('tr');
  for(const column of columns) { const th = document.createElement('th'); th.scope = 'col'; th.textContent = column; head.append(th); }
  const thead = document.createElement('thead'); thead.append(head); el.append(thead); const tbody = document.createElement('tbody');
  for(const row of rows) { const tr = document.createElement('tr'); for(const column of columns) { const td = document.createElement('td'); td.textContent = row[column]; tr.append(td); } tbody.append(tr); } el.append(tbody); wrap.append(el); $(target).append(wrap);
}
function renderFlags() {
  $('flags').replaceChildren(); const matches = flags.filter(f => f.key.includes($('search').value.toLowerCase()));
  if (!matches.length) $('flags').textContent = flags.length ? 'No matching flags.' : 'No flags in this environment. Create your first flag.';
  for (const flag of matches) { const button = document.createElement('button'); button.className = 'flag' + (selected?.key === flag.key ? ' selected' : ''); button.setAttribute('aria-pressed', String(selected?.key === flag.key)); const name = document.createElement('strong'); name.textContent = flag.key; const status = document.createElement('span'); status.textContent = `${flag.enabled ? 'Enabled' : 'Stopped'} · ${flag.rollout}% rollout · v${flag.version}`; button.append(name, status); button.onclick = () => task(async () => { select(flag); await history(); notice('Flag selected.'); }); $('flags').append(button); }
}
function fields() { const variants = $('type').value === 'multivariate'; $('variant-fields').hidden = !variants; $('boolean-fields').hidden = variants; }
function select(flag) {
  selected = flag; $('key').value = flag?.key ?? ''; $('key').readOnly = !!flag; $('type').value = flag?.type ?? 'boolean'; $('rollout').value = flag?.rollout ?? 0; $('enabled').checked = flag?.enabled ?? false; $('targets').value = flag?.targets.join(', ') ?? ''; $('value').value = String(flag?.value ?? true); $('default').value = String(flag?.defaultValue ?? false); $('variant-default').value = typeof flag?.defaultValue === 'string' ? flag.defaultValue : 'baseline'; $('variants').value = JSON.stringify(flag?.variants ?? [{ value: 'baseline', weight: 50 }, { value: 'candidate', weight: 50 }], null, 2); $('version').textContent = flag ? `Version ${flag.version}` : 'New flag'; $('editor-title').textContent = flag ? 'Edit configuration' : 'Create a flag'; $('history').textContent = 'Select a flag to see its history.'; $('decision').textContent = 'Evaluate a saved flag to inspect a decision.'; fields(); buttons(); renderFlags();
}
async function history() { if(selected) $('history').textContent = JSON.stringify(await api(`flags/${selected.key}/history`), null, 2); }
async function refresh() { const data = await Promise.all([api('flags'), api('audit'), api('stats')]); flags = data[0]; if(selected) select(flags.find(f => f.key === selected.key) ?? null); else renderFlags(); table('audit', data[1], ['action', 'key', 'environment', 'version', 'actor', 'timestamp']); table('stats', data[2], ['key', 'version', 'reason', 'value', 'count']); await history(); }
$('connect').onsubmit = event => { event.preventDefault(); task(async () => { token = $('token').value.trim(); try { const identity = await api('session'); $('identity').textContent = `${identity.tenant} · ${identity.role}`; $('token').value = ''; await refresh(); notice('Workspace connected.'); } catch(error) { token = ''; $('identity').textContent = 'Disconnected'; throw error; } }); };
$('editor').onsubmit = event => { event.preventDefault(); task(async () => { const type = $('type').value; const flag = { key: $('key').value, type, enabled: $('enabled').checked, rollout: Number($('rollout').value), targets: $('targets').value.split(',').map(s => s.trim()).filter(Boolean), defaultValue: type === 'boolean' ? $('default').value === 'true' : $('variant-default').value, ...(type === 'boolean' ? { value: $('value').value === 'true' } : { variants: JSON.parse($('variants').value) }), expectedVersion: selected?.version ?? 0 }; const saved = await api(`flags/${flag.key}`, 'PUT', flag); selected = saved; await refresh(); notice(`Saved ${saved.key}, version ${saved.version}.`); }); };
$('kill').onclick = () => { if(!selected || !confirm(`Stop ${selected.key} in ${environment()}? All evaluations will return its default value.`)) return; task(async () => { selected = await api(`flags/${selected.key}/kill`, 'POST', { expectedVersion: selected.version }); await refresh(); notice('Rollout stopped. Evaluations now return the default value.'); }); };
$('evaluate').onsubmit = event => { event.preventDefault(); task(async () => { const result = await api(`flags/${selected.key}/evaluate`, 'POST', { userId: $('user').value, cohort: $('cohort').value }); await refresh(); $('decision').textContent = JSON.stringify(result, null, 2); notice('Decision evaluated and exposure recorded.'); }); };
$('environment').onchange = () => task(async () => { select(null); if(token) await refresh(); notice(`Switched to ${environment()}.`); });
$('refresh').onclick = () => task(async () => { await refresh(); notice('Workspace refreshed.'); }); $('new').onclick = () => select(null); $('type').onchange = fields; $('search').oninput = renderFlags; buttons();

(async()=>{const r=await fetch('/api/session');if(!r.ok)return;const identity=await r.json();token='@session';$('identity').textContent=`${identity.tenant} · ${identity.role}`;task(async()=>{await refresh();notice('Account session restored.');});})();
