// TV player: runs full screen in Fully Kiosk Browser on each Fire TV Stick.
(function () {
  'use strict';

  const KEY = location.pathname.split('/').filter(Boolean).pop();
  const API = `/api/player/${KEY}`;
  const CACHE_KEY = `signage-config-${KEY}`;
  const POLL_MS = 15000;
  const HEARTBEAT_MS = 30000;
  const fully = window.fully; // present only inside Fully Kiosk Browser (JavaScript Interface enabled)

  const $ = (id) => document.getElementById(id);
  const imgs = [$('imgA'), $('imgB')];
  const vid = $('vid');

  let config = null;       // last config applied
  let itemsSig = '';       // signature of the playlist being played
  let mode = null;         // 'signage' | 'live' | 'off'
  let idx = -1;
  let frontImg = 0;
  let timer = null;        // advances to the next item
  let stallTimer = null;
  let loadedBuild = null;
  let nowPlaying = '';
  let lastLiveLaunch = 0;
  let lastForeground = 0;

  // ------------------------------------------------------------ screens
  function showMessage(text) {
    $('msgStore').textContent = config ? config.store : '';
    $('msgTv').textContent = config ? config.tv : '';
    $('msgText').textContent = text;
    $('message').classList.remove('hidden');
  }
  const hideMessage = () => $('message').classList.add('hidden');

  function clearTimers() { clearTimeout(timer); clearTimeout(stallTimer); timer = stallTimer = null; }

  function stopPlayback() {
    clearTimers();
    vid.pause();
    vid.removeAttribute('src');
    vid.load();
    vid.classList.remove('show');
    imgs.forEach((i) => i.classList.remove('show'));
    idx = -1;
  }

  // ------------------------------------------------------------ signage playback
  function items() { return (config && config.items) || []; }

  function next() {
    clearTimers();
    const list = items();
    if (!list.length) { stopPlayback(); nowPlaying = 'Nothing assigned'; showMessage('No playlist assigned to this TV yet.'); return; }
    hideMessage();
    idx = (idx + 1) % list.length;
    const item = list[idx];
    nowPlaying = item.name;
    if (item.type === 'video') playVideo(item, list.length === 1);
    else showImage(item, list.length === 1);
  }

  function showImage(item, only) {
    const pre = new Image();
    pre.onload = () => {
      if (mode !== 'signage') return;
      const back = imgs[1 - frontImg];
      back.src = item.url;
      back.classList.add('show');
      imgs[frontImg].classList.remove('show');
      frontImg = 1 - frontImg;
      if (!vid.paused || vid.getAttribute('src')) { vid.pause(); vid.removeAttribute('src'); vid.load(); }
      vid.classList.remove('show');
      if (!only) timer = setTimeout(next, Math.max(1, item.duration) * 1000);
    };
    pre.onerror = () => { timer = setTimeout(next, 2000); };
    pre.src = item.url;
  }

  function playVideo(item, only) {
    vid.loop = only;
    vid.muted = item.muted;
    vid.src = item.url;
    vid.onended = () => next();
    vid.onerror = () => { timer = setTimeout(next, 2000); };
    vid.onplaying = () => {
      vid.classList.add('show');
      imgs.forEach((i) => i.classList.remove('show'));
    };
    // Skip the video if it gets stuck (bad file, network problem).
    let lastTime = -1;
    const watch = () => {
      if (mode !== 'signage') return;
      if (!vid.paused && vid.currentTime === lastTime) { next(); return; }
      lastTime = vid.currentTime;
      stallTimer = setTimeout(watch, 20000);
    };
    stallTimer = setTimeout(watch, 20000);
    const p = vid.play();
    if (p && p.catch) {
      p.catch(() => {
        // Autoplay with sound blocked: fall back to muted so the screen never sits blank.
        vid.muted = true;
        vid.play().catch(() => { timer = setTimeout(next, 2000); });
      });
    }
  }

  // ------------------------------------------------------------ modes
  function launchLiveApp(force) {
    if (!config || !config.liveApp) return;
    if (!fully || typeof fully.startApplication !== 'function') {
      showMessage(`LIVE TV mode. This only works inside Fully Kiosk on the Fire TV Stick (app: ${config.liveApp}).`);
      return;
    }
    if (!force && Date.now() - lastLiveLaunch < 20000) return;
    lastLiveLaunch = Date.now();
    showMessage('Opening live TV…');
    try { fully.startApplication(config.liveApp); } catch (e) { showMessage(`Could not open ${config.liveApp}`); }
  }

  function bringBack() {
    if (fully && typeof fully.bringToForeground === 'function' && Date.now() - lastForeground > 10000) {
      lastForeground = Date.now();
      try { fully.bringToForeground(); } catch (e) { /* ignore */ }
    }
  }

  function setScreen(on) {
    if (!fully) return;
    try { on ? fully.turnScreenOn() : fully.turnScreenOff(); } catch (e) { /* not supported on every device */ }
  }

  function applyConfig(c) {
    const prevMode = mode;
    config = c;
    mode = c.mode;
    const sig = JSON.stringify(c.items);

    if (mode !== prevMode) {
      if (prevMode === 'off') { $('blackout').classList.add('hidden'); setScreen(true); }
      if (prevMode === 'live') bringBack();
    }

    if (mode === 'off') {
      if (prevMode !== 'off') { stopPlayback(); hideMessage(); $('blackout').classList.remove('hidden'); nowPlaying = 'Screen off (store hours)'; setScreen(false); }
      if (document.hidden) bringBack();
      itemsSig = '';
      return;
    }
    if (mode === 'live') {
      if (prevMode !== 'live') { stopPlayback(); nowPlaying = `Live TV (${c.liveApp})`; launchLiveApp(true); }
      else if (!document.hidden) launchLiveApp(false); // live app was closed: reopen it
      itemsSig = '';
      return;
    }
    // signage
    if (document.hidden) bringBack();
    if (prevMode !== 'signage' || sig !== itemsSig) {
      itemsSig = sig;
      stopPlayback();
      next();
    }
    cacheMedia(c.items);
  }

  // ------------------------------------------------------------ server sync
  async function poll() {
    try {
      const r = await fetch(`${API}/config`, { cache: 'no-store' });
      if (r.status === 404) {
        config = null; stopPlayback(); mode = null;
        $('msgStore').textContent = ''; $('msgTv').textContent = 'Unknown TV link';
        $('msgText').textContent = 'This link was reset or is wrong. Copy this TV’s link again from the control panel.';
        $('message').classList.remove('hidden');
        return;
      }
      if (!r.ok) throw new Error(r.status);
      const c = await r.json();
      $('offline').classList.add('hidden');
      if (loadedBuild && c.build !== loadedBuild) { location.reload(); return; } // server was updated
      loadedBuild = c.build;
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch (e) { /* storage unavailable */ }
      applyConfig(c);
    } catch (e) {
      $('offline').classList.remove('hidden');
      if (!config) {
        const saved = loadSaved();
        if (saved) applyConfig(saved);
        else showMessage('Waiting for internet connection…');
      }
    }
  }

  function loadSaved() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch (e) { return null; }
  }

  function heartbeat() {
    fetch(`${API}/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nowPlaying, mode, kiosk: !!fully, visible: !document.hidden,
        screen: `${screen.width}x${screen.height}`,
      }),
    }).catch(() => {});
  }

  // ------------------------------------------------------------ offline cache (needs https)
  function cacheMedia(list) {
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'cache', urls: list.map((i) => i.url) });
    }
  }
  function cacheShell(sw) {
    if (sw) sw.postMessage({ type: 'shell', urls: [location.pathname, '/static/player.js', '/static/player.css'] });
  }
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready)
      .then((reg) => { cacheShell(reg.active); if (config) cacheMedia(items()); }).catch(() => {});
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (config) cacheMedia(items()); });
  }

  // When the player comes back to the front (e.g. someone exits the live TV app), resync right away.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { poll(); heartbeat(); } });

  // ------------------------------------------------------------ start
  const saved = loadSaved();
  if (saved) applyConfig(saved);
  else showMessage('Connecting…');
  poll();
  setInterval(poll, POLL_MS);
  setTimeout(heartbeat, 3000);
  setInterval(heartbeat, HEARTBEAT_MS);
})();
