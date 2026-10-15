// Gets the data, then starts the app. On the website nothing is shown without an access token:
// the words and sentences live in a private repository and are fetched with it.
(function () {
  'use strict';
  const DATA_REPO = 'alyoshalatyntsev/hanyu-data', DATA_PATH = 'data.json';
  const TOKEN_KEY = 'hanyu-token';
  const DATA_VERSION = 2;      // the shape of data.json this release understands
  const LOCAL = (location.protocol === 'file:' || ['localhost', '127.0.0.1'].includes(location.hostname)) &&
    !new URLSearchParams(location.search).has('gate');
  const main = document.getElementById('main');

  function script(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = rej;
      document.body.append(s);
    });
  }

  // one small key-value store for the downloaded data
  function store(mode, fn) {
    return new Promise((res, rej) => {
      const open = indexedDB.open('hanyu', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('kv');
      open.onerror = () => rej(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction('kv', mode), req = fn(tx.objectStore('kv'));
        tx.oncomplete = () => res(req && req.result);
        tx.onerror = () => rej(tx.error);
      };
    });
  }
  const cacheGet = () => store('readonly', s => s.get('data')).catch(() => null);
  const cacheSet = v => store('readwrite', s => s.put(v, 'data')).catch(() => null);
  const cacheClear = () => store('readwrite', s => s.clear()).catch(() => null);

  async function fetchData(token, etag) {
    const headers = { Accept: 'application/vnd.github.raw+json', Authorization: 'Bearer ' + token };
    if (etag) headers['If-None-Match'] = etag;
    const r = await fetch('https://api.github.com/repos/' + DATA_REPO + '/contents/' + DATA_PATH, { headers, cache: 'no-store' });
    if (r.status === 304) return null;
    if (!r.ok) { const e = new Error('GitHub answered ' + r.status); e.status = r.status; throw e; }
    return { etag: r.headers.get('ETag'), data: await r.json() };
  }

  function start(data) {
    window.DATA = data;
    window.HANYU = { local: LOCAL, repo: DATA_REPO, token: () => localStorage.getItem(TOKEN_KEY),
      forget: async () => { localStorage.removeItem(TOKEN_KEY); await cacheClear(); location.reload(); } };
    return script('app.js');
  }

  function gate(message) {
    const input = document.createElement('input');
    input.type = 'password'; input.placeholder = 'access token'; input.autocomplete = 'off';
    const button = document.createElement('button');
    button.className = 'primary'; button.textContent = 'Open';
    const note = document.createElement('p');
    note.className = 'muted small'; note.textContent = message || '';
    const form = document.createElement('form');
    form.className = 'gate';
    form.append(input, button, note);
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const token = input.value.trim();
      if (!token) return;
      button.disabled = true; note.textContent = 'Checking…';
      try {
        const got = await fetchData(token);
        localStorage.setItem(TOKEN_KEY, token);
        await cacheSet(got);
        main.replaceChildren();
        await start(got.data);
      } catch (err) {
        button.disabled = false;
        note.textContent = err.status === 401 ? 'That token was not accepted.'
          : err.status ? 'That token cannot read the data (' + err.status + '). It needs Contents access to ' + DATA_REPO + '.'
          : 'Could not reach GitHub. Check the connection and try again.';
      }
    });
    main.replaceChildren(form);
    input.focus();
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function boot() {
    if (LOCAL) { await script('private/data.js'); return start(window.DATA); }
    let reg = null;
    if ('serviceWorker' in navigator) {
      const had = !!navigator.serviceWorker.controller;
      // a new release took over: before the first question, reload at once; once a question is on screen, wait for the next "Next"
      navigator.serviceWorker.addEventListener('controllerchange', () => { if (!had) return; if (window.__app && window.__app.started) window.__reloadWanted = true; else location.reload(); });
      reg = navigator.serviceWorker.register('sw.js').catch(() => null);
    }
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) return gate();
    const cached = await cacheGet();
    if (cached && cached.data && cached.data.v === DATA_VERSION) {
      // Before the first question: "Connecting…" while the app looks for a newer version of itself and newer words, for
      // up to four seconds, so that nothing swaps the question once it is on screen. A newer version reloads the page
      // here (controllerchange above), before any question. No network, or too slow: practice starts from what is on the
      // device, and anything that arrives later is used at the next "Next".
      const p = document.createElement('p');
      p.className = 'muted connecting'; p.textContent = 'Connecting…';
      main.replaceChildren(p);
      const dataP = fetchData(token, cached.etag).then(got => (got && got.data.v === DATA_VERSION ? got : null)).catch(() => null);
      const appP = (async () => {
        const r = await reg;
        if (!r) return;
        try { await r.update(); } catch (e) { return; }
        const w = r.installing || r.waiting;
        if (w) await new Promise(res => { w.addEventListener('statechange', () => { if (['activated', 'redundant'].includes(w.state)) res(); }); });
        await sleep(300);         // let controllerchange reload the page if this was a new version
      })();
      const got = await Promise.race([Promise.all([dataP, appP]).then(([g]) => g || null), sleep(4000).then(() => undefined)]);
      if (got) { await cacheSet(got); return start(got.data); }
      if (got === undefined) dataP.then(async g => { if (g) { await cacheSet(g); window.dispatchEvent(new Event('hanyu-newdata')); } });
      return start(cached.data);
    }
    try {
      const got = await fetchData(token);
      if (got.data.v !== DATA_VERSION) throw new Error('data version');
      await cacheSet(got);
      await start(got.data);
    } catch (err) {
      gate(err.status ? 'The saved token no longer works. Paste a new one.'
        : err.message === 'data version' ? 'The word data on GitHub does not match this version of the app.'
        : 'Could not reach GitHub. Check the connection and try again.');
    }
  }
  boot();
})();
