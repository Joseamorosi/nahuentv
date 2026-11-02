// Control panel (runs in your browser at the office / on your phone).
(function () {
  'use strict';

  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const DAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const APP_PRESETS = [
    { name: 'YouTube TV', pkg: 'com.google.android.youtube.tvunplugged' },
  ];

  let S = null;              // state from the server
  let tab = 'screens';
  let selectedPl = null;     // playlist id open in the editor
  let draft = null;          // editable copy of that playlist
  let dirty = false;

  // ------------------------------------------------------------ helpers
  async function api(method, url, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const r = await fetch(url, opts);
    let data = {};
    try { data = await r.json(); } catch (e) { /* empty */ }
    if (r.status === 401 && url !== '/api/login' && url !== '/api/password') { showAuth(false); throw new Error('Please log in again'); }
    if (!r.ok) throw new Error(data.error || `Error ${r.status}`);
    return data;
  }
  let toastTimer;
  function toast(msg, isErr) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = `toast${isErr ? ' err' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), isErr ? 5000 : 2500);
  }
  const fail = (e) => toast(e.message || String(e), true);
  const mediaById = (id) => S.media.find((m) => m.id === id);
  const playlistById = (id) => S.playlists.find((p) => p.id === id);
  const allTvs = () => S.stores.flatMap((s) => s.tvs.map((t) => ({ ...t, store: s.name })));
  const tvLink = (tv) => `${location.origin}/tv/${tv.key}`;
  function ago(ts) {
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 90) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} days ago`;
  }
  function fmtSize(b) {
    if (b > 1e9) return `${(b / 1e9).toFixed(1)} GB`;
    if (b > 1e6) return `${(b / 1e6).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(b / 1e3))} KB`;
  }
  function fmt12(hhmm) {
    if (!hhmm) return '';
    let [h, m] = hhmm.split(':').map(Number);
    const ap = h >= 12 ? 'pm' : 'am';
    h = h % 12 || 12;
    return `${h}:${String(m).padStart(2, '0')}${ap}`;
  }
  function thumbHtml(m, cls) {
    if (!m) return `<div class="${cls}"></div>`;
    return m.type === 'video'
      ? `<video class="${cls}" src="${esc(m.url)}#t=1" preload="metadata" muted playsinline></video>`
      : `<img class="${cls}" src="${esc(m.url)}" loading="lazy" alt="">`;
  }
  function plOptions(selected, emptyLabel = '— Nothing (shows TV name) —') {
    return `<option value="">${emptyLabel}</option>` + S.playlists.map((p) =>
      `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); }
    catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
    }
    toast('Link copied');
  }

  // ------------------------------------------------------------ dialog
  const dlg = $('#dialog');
  function openDialog(html, wide) {
    $('#dialogBody').innerHTML = html;
    dlg.classList.toggle('dialog-wide', !!wide);
    dlg.showModal();
    return $('#dialogBody');
  }
  const closeDialog = () => dlg.close();

  // ------------------------------------------------------------ auth
  async function boot() {
    const me = await api('GET', '/api/me');
    if (me.loggedIn) { await startApp(); }
    else showAuth(me.setupNeeded);
  }
  let setupMode = false;
  function showAuth(setup) {
    setupMode = setup;
    $('#app').classList.add('hidden');
    $('#auth').classList.remove('hidden');
    $('#authHint').textContent = setup
      ? 'Welcome! Create the password you will use to log in to this control panel.'
      : 'Log in to manage your TVs.';
    $('#authPassword2').classList.toggle('hidden', !setup);
    $('#authPassword2').required = setup;
    $('#authPassword').autocomplete = setup ? 'new-password' : 'current-password';
    $('#authBtn').textContent = setup ? 'Create password' : 'Log in';
    $('#authPassword').focus();
  }
  $('#authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#authError').textContent = '';
    const pw = $('#authPassword').value;
    try {
      if (setupMode) {
        if (pw !== $('#authPassword2').value) throw new Error('The passwords do not match');
        await api('POST', '/api/setup', { password: pw });
      } else {
        await api('POST', '/api/login', { password: pw });
      }
      $('#authPassword').value = $('#authPassword2').value = '';
      await startApp();
    } catch (err) { $('#authError').textContent = err.message; }
  });
  $('#logoutBtn').addEventListener('click', async () => {
    if (dirty && !confirm('You have unsaved playlist changes. Log out anyway?')) return;
    await api('POST', '/api/logout');
    location.reload();
  });

  async function startApp() {
    $('#auth').classList.add('hidden');
    $('#app').classList.remove('hidden');
    try { tab = localStorage.getItem('signage-tab') || 'screens'; } catch (e) { /* ignore */ }
    await refresh();
    switchTab(tab);
  }
  async function refresh() {
    S = await api('GET', '/api/state');
    renderCurrent();
  }
  function renderCurrent() {
    if (tab === 'screens') renderScreens();
    else if (tab === 'playlists') renderPlaylists();
    else if (tab === 'media') renderMedia();
    else renderSettings();
  }

  // ------------------------------------------------------------ tabs
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => {
    if (tab === 'playlists' && dirty && b.dataset.tab !== 'playlists' && !confirm('You have unsaved playlist changes. Leave without saving?')) return;
    if (b.dataset.tab !== 'playlists') { dirty = false; draft = null; }
    switchTab(b.dataset.tab);
  }));
  function switchTab(name) {
    tab = name;
    try { localStorage.setItem('signage-tab', name); } catch (e) { /* ignore */ }
    $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    $$('.tab').forEach((t) => t.classList.toggle('hidden', t.id !== `tab-${name}`));
    renderCurrent();
  }
  window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

  // Keep TV status fresh on the Screens tab.
  setInterval(async () => {
    if (!S || tab !== 'screens' || dlg.open || document.hidden) return;
    if (document.activeElement && document.activeElement.closest('#tab-screens select')) return;
    try { await refresh(); } catch (e) { /* ignore */ }
  }, 20000);

  // ------------------------------------------------------------ SCREENS
  function renderScreens() {
    const tvs = allTvs();
    const online = tvs.filter((t) => t.online).length;
    let html = `
      <div class="bar">
        <h2>Screens</h2>
        <span class="muted">${online} of ${tvs.length} TVs online</span>
        <span style="flex:1"></span>
        <select id="allPl">${plOptions(null, 'Choose a playlist…')}</select>
        <button class="btn" data-act="assign-all">Show on ALL TVs</button>
      </div>`;
    if (!S.playlists.length) {
      html += `<div class="card">👋 <b>Getting started:</b> 1) Upload images and videos in <b>Media</b>.
        2) Build a slideshow in <b>Playlists</b>. 3) Come back here and pick a playlist for each TV.</div>`;
    }
    for (const s of S.stores) {
      const on = s.tvs.filter((t) => t.online).length;
      const hours = s.screen_on ? ` · Screens on ${fmt12(s.screen_on)}–${fmt12(s.screen_off)}` : '';
      html += `
      <div class="card">
        <div class="store-head">
          <div><h3>${esc(s.name)}</h3><div class="muted small">${on} of ${s.tvs.length} online${hours}</div></div>
          <div class="row">
            <select data-store-pl="${s.id}">${plOptions(null, 'Choose a playlist…')}</select>
            <button class="btn small" data-act="assign-store" data-id="${s.id}">Show on all ${esc(s.name)} TVs</button>
            <button class="btn small ghost" data-act="store-settings" data-id="${s.id}">⚙ Store settings</button>
          </div>
        </div>
        <div class="tv-grid">${s.tvs.map(tvCard).join('') || '<p class="muted">No TVs. Add one in Store settings.</p>'}</div>
      </div>`;
    }
    $('#tab-screens').innerHTML = html;
  }

  function tvCard(tv) {
    const status = tv.online ? 'Online' : tv.last_seen ? `Offline · last seen ${ago(tv.last_seen)}` : 'Not connected yet';
    const badge = tv.effective_mode === 'live' ? '<span class="badge live">LIVE TV</span>'
      : tv.effective_mode === 'off' ? '<span class="badge offmode">SCREEN OFF</span>' : '';
    const seg = tv.live_capable ? `
      <div class="seg" title="What this TV shows">
        <button data-tv-mode="signage" data-id="${tv.id}" class="${tv.mode === 'signage' ? 'active' : ''}">Slideshow</button>
        <button data-tv-mode="live" data-id="${tv.id}" class="${tv.mode === 'live' ? 'active live' : ''}">Live TV</button>
        <button data-tv-mode="auto" data-id="${tv.id}" class="${tv.mode === 'auto' ? 'active' : ''}">Schedule</button>
      </div>` : '';
    return `
      <div class="tv">
        <div class="tv-name"><span class="dot ${tv.online ? 'on' : tv.last_seen ? 'off' : ''}"></span>${esc(tv.name)} ${badge}</div>
        <div class="muted small">${status}</div>
        <select data-tv-pl="${tv.id}" aria-label="Playlist for ${esc(tv.name)}">${plOptions(tv.playlist_id)}</select>
        ${seg}
        ${tv.online && tv.now_playing ? `<div class="now" title="${esc(tv.now_playing)}">▶ ${esc(tv.now_playing)}</div>` : ''}
        <div class="row">
          <button class="btn small" data-act="tv-settings" data-id="${tv.id}">⚙ Settings</button>
          <button class="btn small ghost" data-act="copy-link" data-id="${tv.id}">🔗 Copy TV link</button>
        </div>
      </div>`;
  }

  $('#tab-screens').addEventListener('change', async (e) => {
    const sel = e.target.closest('[data-tv-pl]');
    if (!sel) return;
    try {
      await api('POST', '/api/assign', { scope: 'tv', id: Number(sel.dataset.tvPl), playlist_id: sel.value ? Number(sel.value) : null });
      toast('Saved. The TV updates within 15 seconds');
      await refresh();
    } catch (err) { fail(err); }
  });

  $('#tab-screens').addEventListener('click', async (e) => {
    const modeBtn = e.target.closest('[data-tv-mode]');
    if (modeBtn) {
      try {
        await api('PUT', `/api/tvs/${modeBtn.dataset.id}`, { mode: modeBtn.dataset.tvMode });
        toast({ signage: 'Switching to slideshow…', live: 'Switching to live TV…', auto: 'Following the live TV schedule' }[modeBtn.dataset.tvMode]);
        await refresh();
      } catch (err) { fail(err); }
      return;
    }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const id = Number(b.dataset.id);
    try {
      if (b.dataset.act === 'assign-all') {
        const pid = $('#allPl').value;
        if (!pid) return toast('Choose a playlist first', true);
        if (!confirm(`Show "${playlistById(Number(pid)).name}" on ALL ${allTvs().length} TVs in every store?`)) return;
        await api('POST', '/api/assign', { scope: 'all', playlist_id: Number(pid) });
        toast('All TVs updated'); await refresh();
      } else if (b.dataset.act === 'assign-store') {
        const pid = $(`[data-store-pl="${id}"]`).value;
        if (!pid) return toast('Choose a playlist first', true);
        await api('POST', '/api/assign', { scope: 'store', id, playlist_id: Number(pid) });
        toast('Store updated'); await refresh();
      } else if (b.dataset.act === 'copy-link') {
        copyText(tvLink(allTvs().find((t) => t.id === id)));
      } else if (b.dataset.act === 'tv-settings') {
        tvDialog(id);
      } else if (b.dataset.act === 'store-settings') {
        storeDialog(id);
      }
    } catch (err) { fail(err); }
  });

  // ---- TV settings dialog
  function schedRow(s) {
    return `<div class="sched-row">
      <div class="days">${DAYS.map((d, i) => `<label title="${DAY_NAMES[i]}"><input type="checkbox" value="${i}" ${s.days.includes(i) ? 'checked' : ''}><span>${d}</span></label>`).join('')}</div>
      <input type="time" class="s-start" value="${esc(s.start)}"> to <input type="time" class="s-end" value="${esc(s.end)}">
      <button type="button" class="btn small ghost" data-del-sched>✕</button>
    </div>`;
  }

  function tvDialog(id) {
    const tv = allTvs().find((t) => t.id === id);
    const preset = APP_PRESETS.find((p) => p.pkg === tv.live_app) || (tv.live_app ? null : APP_PRESETS[0]);
    const body = openDialog(`
      <h2>${esc(tv.store)} · ${esc(tv.name)}</h2>
      <label class="field"><span>TV name (for example "Front Counter")</span><input type="text" id="tvName" value="${esc(tv.name)}" maxlength="60"></label>

      <label class="row"><input type="checkbox" id="tvLive" ${tv.live_capable ? 'checked' : ''}> <b>This TV can show live TV</b></label>
      <div id="liveBox" class="${tv.live_capable ? '' : 'hidden'}">
        <label class="field"><span>Live TV app on the Fire TV Stick</span>
          <select id="tvAppPreset">
            ${APP_PRESETS.map((p) => `<option value="${p.pkg}" ${preset && preset.pkg === p.pkg ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
            <option value="" ${preset ? '' : 'selected'}>Other app (enter the package name)</option>
          </select>
        </label>
        <label class="field ${preset ? 'hidden' : ''}" id="tvAppCustomWrap"><span>App package name (see the setup guide for how to find it)</span>
          <input type="text" id="tvAppCustom" value="${esc(preset ? '' : tv.live_app)}" placeholder="com.example.tvapp"></label>
        <div><b>Live TV schedule</b> <span class="muted small">(used when the TV is set to "Schedule")</span></div>
        <div id="schedRows">${tv.schedule.map(schedRow).join('')}</div>
        <button type="button" class="btn small" id="addSched">+ Add time window</button>
        <p class="muted small">Example: Sat &amp; Sun, 12:00 pm to 4:00 pm for the game. Outside these times the TV shows its slideshow.</p>
      </div>

      <hr>
      <div><b>TV link</b> <span class="muted small">(enter this in Fully Kiosk on this TV's Fire Stick)</span></div>
      <div class="linkbox"><input type="text" readonly value="${esc(tvLink(tv))}" id="tvLinkInput"><button type="button" class="btn small" id="copyTvLink">Copy</button></div>
      <p class="muted small">You can open this link on your computer to preview what this TV shows.</p>

      <div class="dialog-actions">
        <div class="row">
          <button type="button" class="btn small danger" id="rekeyTv">Reset link</button>
          <button type="button" class="btn small danger" id="deleteTv">Delete TV</button>
        </div>
        <div class="row">
          <button type="button" class="btn" id="cancelTv">Cancel</button>
          <button type="button" class="btn primary" id="saveTv">Save</button>
        </div>
      </div>`);

    $('#tvLive', body).onchange = (e) => $('#liveBox', body).classList.toggle('hidden', !e.target.checked);
    $('#tvAppPreset', body).onchange = (e) => $('#tvAppCustomWrap', body).classList.toggle('hidden', !!e.target.value);
    $('#addSched', body).onclick = () => $('#schedRows', body).insertAdjacentHTML('beforeend', schedRow({ days: [0, 6], start: '12:00', end: '16:00' }));
    $('#schedRows', body).onclick = (e) => { if (e.target.closest('[data-del-sched]')) e.target.closest('.sched-row').remove(); };
    $('#copyTvLink', body).onclick = () => copyText(tvLink(tv));
    $('#cancelTv', body).onclick = closeDialog;
    $('#rekeyTv', body).onclick = async () => {
      if (!confirm('Make a new link for this TV? The old link stops working, and you must enter the new link in Fully Kiosk on this TV.')) return;
      try { await api('POST', `/api/tvs/${id}/rekey`); closeDialog(); await refresh(); toast('New link created'); tvDialog(id); } catch (err) { fail(err); }
    };
    $('#deleteTv', body).onclick = async () => {
      if (!confirm(`Delete ${tv.store} · ${tv.name}?`)) return;
      try { await api('DELETE', `/api/tvs/${id}`); closeDialog(); await refresh(); toast('TV deleted'); } catch (err) { fail(err); }
    };
    $('#saveTv', body).onclick = async () => {
      const live = $('#tvLive', body).checked;
      const app = $('#tvAppPreset', body).value || $('#tvAppCustom', body).value.trim();
      if (live && !app) return toast('Enter the live TV app package name', true);
      const schedule = $$('.sched-row', body).map((r) => ({
        days: $$('.days input:checked', r).map((i) => Number(i.value)),
        start: $('.s-start', r).value, end: $('.s-end', r).value,
      }));
      if (schedule.some((s) => !s.days.length || !s.start || !s.end)) return toast('Each time window needs at least one day, a start time and an end time', true);
      try {
        await api('PUT', `/api/tvs/${id}`, {
          name: $('#tvName', body).value, live_capable: live, live_app: live ? app : tv.live_app, schedule,
          mode: live ? tv.mode : 'signage',
        });
        closeDialog(); toast('Saved'); await refresh();
      } catch (err) { fail(err); }
    };
  }

  // ---- Store settings dialog
  function storeDialog(id) {
    const s = S.stores.find((x) => x.id === id);
    const body = openDialog(`
      <h2>${esc(s.name)}: store settings</h2>
      <label class="field"><span>Store name</span><input type="text" id="stName" value="${esc(s.name)}" maxlength="60"></label>
      <div><b>Screen hours</b> <span class="muted small">(optional; the TVs go dark outside these hours)</span></div>
      <div class="row" style="margin:8px 0">
        On <input type="time" id="stOn" value="${esc(s.screen_on || '')}">
        Off <input type="time" id="stOff" value="${esc(s.screen_off || '')}">
        <button type="button" class="btn small ghost" id="stClear">Always on</button>
      </div>
      <p class="muted small">Time zone: ${esc(S.timezone)}. Whether the TV itself powers off depends on the TV model; at minimum the screen shows black.</p>
      <hr>
      <div class="row spread"><span>${s.tvs.length} TVs in this store</span><button type="button" class="btn small" id="stAddTv">+ Add a TV</button></div>
      <div class="dialog-actions">
        <button type="button" class="btn small danger" id="stDelete">Delete store</button>
        <div class="row">
          <button type="button" class="btn" id="stCancel">Cancel</button>
          <button type="button" class="btn primary" id="stSave">Save</button>
        </div>
      </div>`);
    $('#stClear', body).onclick = () => { $('#stOn', body).value = ''; $('#stOff', body).value = ''; };
    $('#stCancel', body).onclick = closeDialog;
    $('#stAddTv', body).onclick = async () => {
      try { await api('POST', `/api/stores/${id}/tvs`, {}); closeDialog(); await refresh(); toast('TV added'); } catch (err) { fail(err); }
    };
    $('#stDelete', body).onclick = async () => {
      const typed = prompt(`This deletes ${s.name} and all ${s.tvs.length} of its TVs. Type the store name to confirm:`);
      if (typed === null) return;
      if (typed.trim().toLowerCase() !== s.name.toLowerCase()) return toast('Name did not match. Nothing was deleted', true);
      try { await api('DELETE', `/api/stores/${id}`); closeDialog(); await refresh(); toast('Store deleted'); } catch (err) { fail(err); }
    };
    $('#stSave', body).onclick = async () => {
      try {
        await api('PUT', `/api/stores/${id}`, { name: $('#stName', body).value, screen_on: $('#stOn', body).value, screen_off: $('#stOff', body).value });
        closeDialog(); toast('Saved'); await refresh();
      } catch (err) { fail(err); }
    };
  }

  // ------------------------------------------------------------ PLAYLISTS
  function usedOn(pid) { return allTvs().filter((t) => t.playlist_id === pid); }

  function renderPlaylists() {
    if (selectedPl && !playlistById(selectedPl)) { selectedPl = null; draft = null; dirty = false; }
    if (!selectedPl && S.playlists.length) selectedPl = S.playlists[0].id;
    if (selectedPl && (!draft || draft.id !== selectedPl)) {
      draft = JSON.parse(JSON.stringify(playlistById(selectedPl)));
      dirty = false;
    }
    const list = S.playlists.map((p) => `<button data-pl="${p.id}" class="${p.id === selectedPl ? 'active' : ''}">${esc(p.name)}
      <div class="muted small">${p.items.length} items · on ${usedOn(p.id).length} TVs</div></button>`).join('');
    $('#tab-playlists').innerHTML = `
      <div class="bar"><h2>Playlists</h2><span style="flex:1"></span><button class="btn primary" id="newPl">+ New playlist</button></div>
      <div class="pl-layout">
        <div class="card pl-list">${list || '<p class="muted" style="padding:8px">No playlists yet.</p>'}</div>
        <div id="plEditor">${draft ? editorHtml() : '<div class="card muted">Create a playlist to build a slideshow.</div>'}</div>
      </div>`;
  }

  function editorHtml() {
    const tvs = usedOn(draft.id);
    const total = draft.items.reduce((sum, it) => sum + (mediaById(it.media_id)?.type === 'video' ? 0 : it.duration), 0);
    const hasVideo = draft.items.some((it) => mediaById(it.media_id)?.type === 'video');
    const items = draft.items.map((it, i) => {
      const m = mediaById(it.media_id);
      if (!m) return '';
      const ctrl = m.type === 'video'
        ? `<label class="small row" title="Play this video's sound"><input type="checkbox" data-sound="${i}" ${it.muted ? '' : 'checked'}> Sound</label><span class="muted small">full video</span>`
        : `<input type="number" min="1" max="3600" value="${it.duration}" data-dur="${i}" aria-label="Seconds"> <span class="muted small">sec</span>`;
      return `<li class="item" draggable="true" data-idx="${i}">
        <span class="handle" title="Drag to reorder">⠿</span>
        ${thumbHtml(m, 'thumb')}
        <span class="name" title="${esc(m.original_name)}">${esc(m.original_name)}</span>
        <span class="ctrls">${ctrl}
          <button type="button" class="btn small ghost" data-move="${i}" data-dir="-1" title="Move up">↑</button>
          <button type="button" class="btn small ghost" data-move="${i}" data-dir="1" title="Move down">↓</button>
          <button type="button" class="btn small ghost" data-remove="${i}" title="Remove">✕</button>
        </span></li>`;
    }).join('');
    return `<div class="card">
      <div class="row spread">
        <input type="text" id="plName" value="${esc(draft.name)}" style="flex:1;font-size:17px;font-weight:600" maxlength="80" aria-label="Playlist name">
        <span class="muted small" id="dirtyFlag">${dirty ? '● Unsaved changes' : ''}</span>
      </div>
      <p class="muted small">Showing on: ${tvs.length ? tvs.map((t) => esc(`${t.store} ${t.name}`)).join(', ') : 'no TVs yet (assign it on the Screens tab)'}<br>
      Loop length: ${Math.floor(total / 60)}m ${total % 60}s${hasVideo ? ' plus videos' : ''}</p>
      ${imageItems().length ? `<div class="row">Seconds per image:
        <input type="number" min="1" max="3600" id="bulkDur" value="${defaultDuration()}" aria-label="Seconds per image for the whole playlist">
        <button type="button" class="btn small" id="applyDur">Apply to all images</button>
        <span class="muted small">You can still change single images below.</span></div>` : ''}
      <ul class="items" id="plItems">${items || '<li class="muted">Empty. Add images or videos below.</li>'}</ul>
      <div class="row spread">
        <div class="row">
          <button type="button" class="btn" id="plAdd">+ Add images / videos</button>
          <button type="button" class="btn small danger" id="plDelete">Delete playlist</button>
        </div>
        <button type="button" class="btn primary" id="plSave" ${dirty ? '' : 'disabled'}>Save &amp; send to TVs</button>
      </div></div>`;
  }

  function markDirty() {
    dirty = true;
    $('#dirtyFlag').textContent = '● Unsaved changes';
    $('#plSave').disabled = false;
  }
  function rerenderEditor() { $('#plEditor').innerHTML = editorHtml(); }

  $('#tab-playlists').addEventListener('click', async (e) => {
    const t = e.target;
    const plBtn = t.closest('[data-pl]');
    if (plBtn) {
      const id = Number(plBtn.dataset.pl);
      if (id === selectedPl) return;
      if (dirty && !confirm('You have unsaved changes. Discard them?')) return;
      selectedPl = id; draft = null; renderPlaylists(); return;
    }
    if (t.closest('#newPl')) {
      if (dirty && !confirm('You have unsaved changes. Discard them?')) return;
      const name = prompt('Name for the new playlist (for example "Weekly Specials"):');
      if (name === null) return;
      try { const r = await api('POST', '/api/playlists', { name }); selectedPl = r.id; draft = null; await refresh(); } catch (err) { fail(err); }
      return;
    }
    const mv = t.closest('[data-move]');
    if (mv) {
      const i = Number(mv.dataset.move), j = i + Number(mv.dataset.dir);
      if (j < 0 || j >= draft.items.length) return;
      [draft.items[i], draft.items[j]] = [draft.items[j], draft.items[i]];
      dirty = true; rerenderEditor(); return;
    }
    const rm = t.closest('[data-remove]');
    if (rm) { draft.items.splice(Number(rm.dataset.remove), 1); dirty = true; rerenderEditor(); return; }
    if (t.closest('#plAdd')) { mediaPicker(); return; }
    if (t.closest('#applyDur')) {
      const v = Math.min(3600, Math.max(1, Math.round(Number($('#bulkDur').value) || 10)));
      imageItems().forEach((it) => { it.duration = v; });
      dirty = true; rerenderEditor();
      toast(`All images set to ${v} seconds. Click Save to send to TVs`);
      return;
    }
    if (t.closest('#plDelete')) {
      const n = usedOn(draft.id).length;
      if (!confirm(`Delete "${draft.name}"?${n ? ` ${n} TVs are showing it and will go back to showing their name.` : ''}`)) return;
      try { await api('DELETE', `/api/playlists/${draft.id}`); selectedPl = null; draft = null; dirty = false; await refresh(); toast('Playlist deleted'); } catch (err) { fail(err); }
      return;
    }
    if (t.closest('#plSave')) {
      try {
        await api('PUT', `/api/playlists/${draft.id}`, draft);
        dirty = false; draft = null;
        await refresh();
        toast('Saved. TVs update within 15 seconds');
      } catch (err) { fail(err); }
    }
  });
  $('#tab-playlists').addEventListener('input', (e) => {
    if (!draft) return;
    const t = e.target;
    if (t.id === 'plName') { draft.name = t.value; markDirty(); }
    else if (t.dataset.dur !== undefined) { draft.items[Number(t.dataset.dur)].duration = Math.max(1, Number(t.value) || 1); markDirty(); }
    else if (t.dataset.sound !== undefined) { draft.items[Number(t.dataset.sound)].muted = !t.checked; markDirty(); }
  });

  // drag & drop reordering
  let dragIdx = null;
  $('#tab-playlists').addEventListener('dragstart', (e) => {
    const li = e.target.closest('.item'); if (!li) return;
    dragIdx = Number(li.dataset.idx); li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  $('#tab-playlists').addEventListener('dragover', (e) => { if (dragIdx !== null && e.target.closest('.item')) e.preventDefault(); });
  $('#tab-playlists').addEventListener('drop', (e) => {
    const li = e.target.closest('.item'); if (!li || dragIdx === null) return;
    e.preventDefault();
    const to = Number(li.dataset.idx);
    const [moved] = draft.items.splice(dragIdx, 1);
    draft.items.splice(to, 0, moved);
    dragIdx = null; dirty = true; rerenderEditor();
  });
  $('#tab-playlists').addEventListener('dragend', () => { dragIdx = null; $$('.item.dragging').forEach((x) => x.classList.remove('dragging')); });

  function mediaPicker() {
    if (!S.media.length) { toast('Upload images or videos on the Media tab first', true); return; }
    const picked = []; // media ids, in the order clicked
    let pf = mediaFolder; // picker opens on the folder you last looked at
    const visible = () => S.media.filter((m) => inFolder(m, pf)).map((m) => m.id);
    const body = openDialog(`
      <div class="row spread"><h2>Add to "${esc(draft.name)}"</h2>
        <div class="row">
          <button type="button" class="btn small" id="pickAll">Select all</button>
          <button type="button" class="btn" id="pickCancel">Cancel</button>
          <button type="button" class="btn primary" id="pickDone" disabled>Add selected</button>
        </div></div>
      <p class="muted small">Click to select, click again to unselect. Items are added in the order you select them.</p>
      ${S.folders.length ? `<div class="row folders" id="pickFolders">${folderChips(pf, 'pfolder')}</div>` : ''}
      <div class="media-grid picker">${S.media.map((m) => `
        <div class="media-card ${inFolder(m, pf) ? '' : 'hidden'}" data-pick="${m.id}" role="button" tabindex="0" aria-pressed="false">${thumbHtml(m, 'preview')}
          <span class="pick-badge"></span>
          <div class="info"><span class="title">${esc(m.original_name)}</span><span class="muted small">${m.type === 'video' ? '🎬 Video' : '🖼 Image'}</span></div>
        </div>`).join('')}</div>`, true);
    const show = () => {
      $$('[data-pick]', body).forEach((c) => {
        const n = picked.indexOf(Number(c.dataset.pick));
        c.classList.toggle('selected', n >= 0);
        c.setAttribute('aria-pressed', String(n >= 0));
        c.querySelector('.pick-badge').textContent = n >= 0 ? n + 1 : '';
      });
      $('#pickDone', body).disabled = !picked.length;
      $('#pickDone', body).textContent = picked.length ? `Add ${picked.length} selected` : 'Add selected';
      const vis = visible();
      $('#pickAll', body).textContent = vis.length && vis.every((id) => picked.includes(id)) ? 'Clear selection' : 'Select all';
    };
    body.onclick = (e) => {
      const card = e.target.closest('[data-pick]');
      if (card) {
        const id = Number(card.dataset.pick), i = picked.indexOf(id);
        if (i >= 0) picked.splice(i, 1); else picked.push(id);
        show();
      } else if (e.target.closest('[data-pfolder]')) {
        pf = parseFolder(e.target.closest('[data-pfolder]').dataset.pfolder);
        $('#pickFolders', body).innerHTML = folderChips(pf, 'pfolder');
        $$('[data-pick]', body).forEach((c) => c.classList.toggle('hidden', !inFolder(mediaById(Number(c.dataset.pick)), pf)));
        show();
      } else if (e.target.closest('#pickAll')) {
        const vis = visible();
        if (vis.every((id) => picked.includes(id))) vis.forEach((id) => picked.splice(picked.indexOf(id), 1));
        else vis.forEach((id) => { if (!picked.includes(id)) picked.push(id); });
        show();
      } else if (e.target.closest('#pickCancel')) {
        closeDialog();
      } else if (e.target.closest('#pickDone')) {
        const dur = defaultDuration();
        picked.forEach((id) => draft.items.push({ media_id: id, duration: dur, muted: true }));
        dirty = true; closeDialog(); rerenderEditor();
        toast(`Added ${picked.length} item(s). Click Save to send to TVs`);
      }
    };
    body.onkeydown = (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-pick]')) { e.preventDefault(); e.target.click(); }
    };
    dlg.addEventListener('close', () => { body.onclick = null; body.onkeydown = null; }, { once: true });
  }

  const imageItems = () => draft.items.filter((it) => mediaById(it.media_id)?.type !== 'video');
  // New images use the same time as the last image in the playlist.
  function defaultDuration() { const imgs = imageItems(); return imgs.length ? imgs[imgs.length - 1].duration : 10; }

  // ------------------------------------------------------------ MEDIA
  let mediaFolder = 'all'; // 'all' | 'none' | folder id
  const parseFolder = (v) => (v === 'all' || v === 'none' ? v : Number(v));
  const inFolder = (m, f) => f === 'all' || (f === 'none' ? !m.folder_id : m.folder_id === f);
  function folderChips(sel, attr) {
    return [['all', 'All'], ['none', 'No folder'], ...S.folders.map((f) => [f.id, `📁 ${f.name}`])].map(([v, label]) =>
      `<button type="button" class="chip ${v === sel ? 'active' : ''}" data-${attr}="${v}">${esc(label)} <span class="count">${S.media.filter((m) => inFolder(m, v)).length}</span></button>`).join('');
  }

  function renderMedia() {
    if (typeof mediaFolder === 'number' && !S.folders.some((f) => f.id === mediaFolder)) mediaFolder = 'all';
    const uses = (mid) => S.playlists.filter((p) => p.items.some((i) => i.media_id === mid)).length;
    const folder = S.folders.find((f) => f.id === mediaFolder);
    const shown = S.media.filter((m) => inFolder(m, mediaFolder));
    const folderOpts = (m) => `<option value="">No folder</option>` + S.folders.map((f) =>
      `<option value="${f.id}" ${m.folder_id === f.id ? 'selected' : ''}>${esc(f.name)}</option>`).join('');
    $('#tab-media').innerHTML = `
      <div class="bar"><h2>Media library</h2><span class="muted">${S.media.length} files</span></div>
      <div class="row folders">${folderChips(mediaFolder, 'folder')}<button type="button" class="btn small" id="newFolder">+ New folder</button></div>
      ${folder ? `<div class="row folders"><b>📁 ${esc(folder.name)}</b>
        <button type="button" class="btn small" id="renameFolder">Rename folder</button>
        <button type="button" class="btn small danger" id="deleteFolder">Delete folder</button></div>` : ''}
      <label class="drop" id="drop">
        <input type="file" id="fileInput" multiple accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime" hidden>
        <b>Click to upload</b> or drag files here<br>
        <span class="muted small">Images: JPG, PNG, WEBP (best size 1920×1080). Videos: MP4 (H.264, 1080p works best).</span><br>
        <span class="small">Uploads go into: <b>${folder ? `📁 ${esc(folder.name)}` : 'No folder'}</b></span>
        <div class="progress hidden" id="prog"><div></div></div>
        <div class="small muted" id="progText"></div>
      </label>
      ${shown.length ? '' : '<p class="muted">No files here yet.</p>'}
      <div class="media-grid">${shown.map((m) => `
        <div class="media-card">
          ${m.type === 'video' ? `<video class="preview" src="${esc(m.url)}#t=1" preload="metadata" muted playsinline controls></video>` : `<img class="preview" src="${esc(m.url)}" loading="lazy" alt="">`}
          <div class="info">
            <span class="title" title="${esc(m.original_name)}">${esc(m.original_name)}</span>
            <span class="muted small">${m.type === 'video' ? '🎬 Video' : '🖼 Image'} · ${fmtSize(m.size)} · in ${uses(m.id)} playlists</span>
          </div>
          <div class="actions">
            ${S.folders.length ? `<select class="small" data-mfolder="${m.id}" aria-label="Folder for ${esc(m.original_name)}">${folderOpts(m)}</select>` : ''}
            <button class="btn small" data-rename="${m.id}">Rename</button>
            <button class="btn small danger" data-delmedia="${m.id}">Delete</button>
          </div>
        </div>`).join('')}</div>`;

    const drop = $('#drop');
    $('#fileInput').onchange = (e) => uploadFiles(e.target.files);
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); uploadFiles(e.dataTransfer.files); };
  }

  function uploadFiles(files) {
    if (!files || !files.length) return;
    const fd = new FormData();
    Array.from(files).forEach((f) => fd.append('files', f));
    const xhr = new XMLHttpRequest();
    const bar = $('#prog'), txt = $('#progText');
    bar.classList.remove('hidden');
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.round((e.loaded / e.total) * 100);
      bar.firstElementChild.style.width = `${pct}%`;
      txt.textContent = `Uploading ${files.length} file(s)… ${pct}%`;
    };
    xhr.onload = async () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch (e) { /* ignore */ }
      if (xhr.status === 401) { showAuth(false); return; }
      if (xhr.status !== 200) { fail(new Error(data.error || (xhr.status === 413 ? 'File too large' : `Upload failed (${xhr.status})`))); }
      else toast(`Uploaded ${data.added.length} file(s)`);
      await refresh();
    };
    xhr.onerror = () => { fail(new Error('Upload failed. Check your connection.')); refresh(); };
    xhr.open('POST', `/api/media${typeof mediaFolder === 'number' ? `?folder=${mediaFolder}` : ''}`);
    xhr.send(fd);
  }

  $('#tab-media').addEventListener('change', async (e) => {
    const sel = e.target.closest('[data-mfolder]');
    if (!sel) return;
    try {
      await api('PATCH', `/api/media/${sel.dataset.mfolder}`, { folder_id: sel.value ? Number(sel.value) : null });
      toast(sel.value ? `Moved to ${sel.selectedOptions[0].textContent}` : 'Moved out of the folder');
      await refresh();
    } catch (err) { fail(err); }
  });

  $('#tab-media').addEventListener('click', async (e) => {
    const ren = e.target.closest('[data-rename]');
    const del = e.target.closest('[data-delmedia]');
    const chip = e.target.closest('[data-folder]');
    try {
      if (chip) {
        mediaFolder = parseFolder(chip.dataset.folder);
        renderMedia();
      } else if (e.target.closest('#newFolder')) {
        const name = prompt('Folder name (for example "Menus" or "Promotions"):');
        if (!name || !name.trim()) return;
        const r = await api('POST', '/api/folders', { name });
        mediaFolder = r.id; await refresh(); toast('Folder created. Uploads now go into it');
      } else if (e.target.closest('#renameFolder')) {
        const f = S.folders.find((x) => x.id === mediaFolder);
        const name = prompt('New folder name:', f.name);
        if (!name || !name.trim()) return;
        await api('PATCH', `/api/folders/${f.id}`, { name }); await refresh();
      } else if (e.target.closest('#deleteFolder')) {
        const f = S.folders.find((x) => x.id === mediaFolder);
        if (!confirm(`Delete the folder "${f.name}"? Its files are NOT deleted; they move to "No folder".`)) return;
        await api('DELETE', `/api/folders/${f.id}`); mediaFolder = 'all'; await refresh(); toast('Folder deleted');
      } else if (ren) {
        const m = mediaById(Number(ren.dataset.rename));
        const name = prompt('New name:', m.original_name);
        if (name && name.trim()) { await api('PATCH', `/api/media/${m.id}`, { name }); await refresh(); }
      } else if (del) {
        const m = mediaById(Number(del.dataset.delmedia));
        const n = S.playlists.filter((p) => p.items.some((i) => i.media_id === m.id)).length;
        if (!confirm(`Delete "${m.original_name}"?${n ? ` It will be removed from ${n} playlist(s).` : ''}`)) return;
        await api('DELETE', `/api/media/${m.id}`); await refresh(); toast('Deleted');
      }
    } catch (err) { fail(err); }
  });

  // ------------------------------------------------------------ SETTINGS
  function showUpdateLog(text) { const el = $('#updLog'); if (el) { el.textContent = text; el.classList.remove('hidden'); } }
  async function loadUpdateInfo() {
    let u;
    try { u = await api('GET', '/api/update?check=1'); } catch (e) { if ($('#updInfo')) $('#updInfo').textContent = 'Could not check for updates.'; return; }
    const info = $('#updInfo'), btn = $('#updBtn');
    if (!info) return; // left the Settings tab
    if (!u.supported) { info.textContent = 'The Update button is not set up yet. Run the update command in the Droplet Console one more time to turn it on.'; return; }
    const upToDate = u.latest && u.latest.commit === u.installed.commit;
    info.innerHTML = `Installed version: <b>${esc(u.installed.commit.slice(0, 7))}</b> (${esc(new Date(u.installed.date).toLocaleDateString())})<br>`
      + (!u.latest ? 'Could not reach GitHub to check for a newer version.'
        : upToDate ? '✅ You have the latest version.'
          : `🆕 <b>Update available:</b> ${esc(u.latest.message)} (${esc(new Date(u.latest.date).toLocaleDateString())})`);
    btn.disabled = false;
    btn.textContent = upToDate ? 'Reinstall latest version' : 'Update now';
    if (u.state === 'failed') { info.innerHTML += '<br><span class="error">The last update failed. Details below.</span>'; showUpdateLog(u.logTail); }
  }
  async function runUpdate() {
    if (!confirm('Install the latest version now? It takes 1–3 minutes. The TVs keep playing and reload by themselves when it finishes.')) return;
    const btn = $('#updBtn'), info = $('#updInfo');
    let t0;
    try { t0 = (await api('POST', '/api/update')).serverTime; } catch (err) { fail(err); return; }
    btn.disabled = true; btn.textContent = 'Updating…';
    info.textContent = 'Updating… this takes 1–3 minutes. Keep this page open; it reloads by itself when done.';
    const began = Date.now();
    const poll = async () => {
      let u = null;
      try { u = await api('GET', '/api/update'); } catch (e) { /* server restarting during the update */ }
      if (u && u.startedAt && Date.parse(u.startedAt) >= t0 - 2000) {
        if (u.state === 'done') { toast('Update installed. Reloading…'); setTimeout(() => location.reload(), 1500); return; }
        if (u.state === 'failed') {
          info.innerHTML = '<span class="error">The update failed. Your TVs keep working on the old version. Send me a screenshot of the details below.</span>';
          showUpdateLog(u.logTail); btn.disabled = false; btn.textContent = 'Try again'; return;
        }
      }
      if (Date.now() - began > 15 * 60 * 1000) { info.textContent = 'The update has not finished after 15 minutes. Reload this page to check again.'; btn.disabled = false; return; }
      setTimeout(poll, 4000);
    };
    setTimeout(poll, 4000);
  }

  function renderSettings() {
    const zones = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'America/Puerto_Rico'];
    if (!zones.includes(S.timezone)) zones.unshift(S.timezone);
    $('#tab-settings').innerHTML = `
      <div class="bar"><h2>Settings</h2></div>
      <div class="card">
        <h3>Time zone</h3>
        <p class="muted small">Used for screen hours and live TV schedules. All three stores are in Florida (Eastern).</p>
        <div class="row"><select id="tz">${zones.map((z) => `<option ${z === S.timezone ? 'selected' : ''}>${esc(z)}</option>`).join('')}</select>
        <button class="btn" id="saveTz">Save</button></div>
      </div>
      <div class="card">
        <h3>Stores</h3>
        <p class="muted small">${S.stores.map((s) => `${esc(s.name)} (${s.tvs.length} TVs)`).join(' · ')}</p>
        <button class="btn" id="addStore">+ Add a store</button>
      </div>
      <div class="card">
        <h3>Software update</h3>
        <p class="small" id="updInfo">Checking for updates…</p>
        <button class="btn primary" id="updBtn" disabled>Update now</button>
        <pre class="log hidden" id="updLog"></pre>
      </div>
      <div class="card">
        <h3>Change password</h3>
        <div class="row" style="margin-top:8px">
          <input type="password" id="pwCur" placeholder="Current password" autocomplete="current-password">
          <input type="password" id="pwNew" placeholder="New password (8+ characters)" autocomplete="new-password">
          <button class="btn" id="savePw">Change</button>
        </div>
      </div>
      <div class="card">
        <h3>Setting up a TV (quick reminder)</h3>
        <ol class="small">
          <li>Plug the Fire TV Stick into the TV and into a wall outlet, and connect it to the store's Wi-Fi.</li>
          <li>Install <b>Fully Kiosk Browser</b> on the stick (see SETUP.md, part 3).</li>
          <li>On the <b>Screens</b> tab, click <b>Copy TV link</b> on the right TV and enter it as Fully Kiosk's <b>Start URL</b>.</li>
          <li>Within a few seconds the TV shows its name (or its playlist) and turns green here.</li>
        </ol>
      </div>`;
    loadUpdateInfo();
    $('#updBtn').onclick = runUpdate;
    $('#saveTz').onclick = async () => { try { await api('PUT', '/api/settings', { timezone: $('#tz').value }); toast('Saved'); await refresh(); } catch (err) { fail(err); } };
    $('#addStore').onclick = async () => {
      const name = prompt('Store name:');
      if (!name || !name.trim()) return;
      try {
        const r = await api('POST', '/api/stores', { name });
        const n = Number(prompt('How many TVs in this store?', '5')) || 0;
        for (let i = 0; i < Math.min(n, 50); i++) await api('POST', `/api/stores/${r.id}/tvs`, {});
        toast('Store added'); await refresh();
      } catch (err) { fail(err); }
    };
    $('#savePw').onclick = async () => {
      try {
        await api('POST', '/api/password', { current: $('#pwCur').value, password: $('#pwNew').value });
        $('#pwCur').value = $('#pwNew').value = '';
        toast('Password changed');
      } catch (err) { fail(err); }
    };
  }

  boot().catch(fail);
})();
