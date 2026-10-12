(function () {
  'use strict';
  const D = window.DATA, F = window.FSRS;
  const TARGET_R = 0.85;      // aim to remember about 85% at the moment of review
  const DUE_THRESHOLD = 15;   // nothing new while this many parts are below target
  const YOUNG_CAP = 12;       // at most this many words being learned and not yet consolidated
  const SORT_BATCH = 40;
  const KEY = 'hanyu-v2';
  const fsrs = F.fsrs(F.generatorParameters({ request_retention: TARGET_R, enable_fuzz: false, enable_short_term: false }));
  const PARTS = { m: 'meaning', s: 'syllables', t: 'tones', r: 'recall', u: 'use' };

  const words = D.words, S = D.sentences, byWord = {};
  words.forEach((w, i) => { byWord[w.w] = w; w.i = i; });
  const targets = words.filter(w => w.lv === D.level);
  // order for finding out and teaching: level-4 words that have sentences first, each group in the list's frequency order
  const order = targets.filter(w => w.s.length).concat(targets.filter(w => !w.s.length));
  order.forEach((w, i) => { w.rank = i; });
  const rankOf = w => (byWord[w] && byWord[w].rank != null) ? byWord[w].rank : 100000 + (byWord[w] ? byWord[w].i : 0);

  // ---------- what is saved ----------
  // `st` is where this device is in the stream. `events` is the record of everything done, on any device.
  // Events live in the browser's database; a small tail in localStorage covers the moment between an answer
  // and its write, so closing the page loses nothing.
  let st = load();
  function load() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(KEY)); } catch (e) { /* start fresh */ }
    s = Object.assign({ counter: 0, retry: [], recent: [], turn: 0, glosses: false, seq: 0 }, s || {});
    s.sync = Object.assign({ seen: {}, pushed: {} }, s.sync || {});
    if (!s.dev) s.dev = Math.random().toString(36).slice(2, 8);       // this device's name in the shared record
    return s;
  }
  function save() { localStorage.setItem(KEY, JSON.stringify(st)); }
  let events = [];
  const TAIL = 'hanyu-tail';
  let tail = [];
  try { tail = JSON.parse(localStorage.getItem(TAIL)) || []; } catch (e) { tail = []; }
  const saveTail = () => localStorage.setItem(TAIL, JSON.stringify(tail));
  const byTime = (a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  let dbp = null;
  function db() {
    return dbp || (dbp = new Promise((res, rej) => {
      const o = indexedDB.open('hanyu-log', 1);
      o.onupgradeneeded = () => o.result.createObjectStore('ev', { keyPath: 'id' });
      o.onerror = () => rej(o.error);
      o.onsuccess = () => res(o.result);
    }));
  }
  function dbPut(list) {
    return db().then(d => new Promise((res, rej) => {
      const tx = d.transaction('ev', 'readwrite'), os = tx.objectStore('ev');
      list.forEach(e => os.put(e));
      tx.oncomplete = () => res(); tx.onerror = tx.onabort = () => rej(tx.error);
    }));
  }
  function dbAll() {
    return db().then(d => new Promise((res, rej) => {
      const q = d.transaction('ev', 'readonly').objectStore('ev').getAll();
      q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
    }));
  }
  function persist(list) {     // whatever the database has not confirmed stays in the tail
    const ids = new Set(list.map(e => e.id));
    list.forEach(e => { if (!tail.some(x => x.id === e.id)) tail.push(e); });
    saveTail();
    return dbPut(list).then(() => { tail = tail.filter(e => !ids.has(e.id)); saveTail(); }).catch(() => {});
  }
  async function loadEvents() {
    let stored = [];
    try { stored = await dbAll(); } catch (e) { stored = []; }
    const have = new Set(stored.map(e => e.id)), extra = [];
    (st.events || []).forEach((e, i) => { if (!e.id) e.id = st.dev + '-m' + i; });       // from the release that kept events in localStorage
    (st.events || []).concat(tail).forEach(e => { if (!have.has(e.id)) { have.add(e.id); extra.push(e); } });
    events = stored.concat(extra).sort(byTime);
    if (extra.length) await persist(extra);
    if (st.events) { delete st.events; save(); }
  }

  // ---------- the picture of what you know: always rebuilt from the events ----------
  let K;
  function rec(w) {
    return K.w[w] || (K.w[w] = { mark: null, want: 0, drop: false, parts: {}, intro: 0, stage: 'none', knows: false, diag: null,
      act: 0, lastSent: null, senses: {}, cyc: {} });
  }
  function prior(days, time) {   // a part you said you know: held firmly, no test behind it
    const c = F.createEmptyCard(time);
    Object.assign(c, { state: 2, stability: days, difficulty: 4, reps: 1, last_review: time, scheduled_days: Math.round(days / 2),
      due: new Date(+time + days * 43200000) });
    return { card: c, right: 0, wrong: 0, src: 'said' };
  }
  // Each kind of question: the part of the word it tests, the chance of a lucky right answer, and a starting difficulty
  // (which then adjusts to your own results).
  const TASK = {
    gap: { part: 'm', g: 0.25, d: -1.0 }, read: { part: 'm', g: 0.25, d: -1.0 },
    retype: { part: 'u', g: 0, d: -1.0 }, tiles: { part: 'u', g: 0, d: -0.3 },
    tilesType: { part: 'r', g: 0, d: 0.0 }, typedGap: { part: 'r', g: 0, d: 0.4 }, meaningToWord: { part: 'r', g: 0, d: 0.6 }, typeBack: { part: 'r', g: 0, d: 1.0 },
  };
  const blank = () => ({ w: {}, sent: {}, retired: {}, sorted: {}, imported: {}, nAns: 0, ms: {},
    d: Object.fromEntries(Object.keys(TASK).map(t => [t, TASK[t].d])) });
  // The scheduler counts days by the UTC calendar. Times are shifted so that its day turns over at 4 am local time
  // (tz = minutes behind UTC where the event happened; older events have none and are taken as China time).
  const schedTime = (iso, tz) => new Date(+new Date(iso) - ((tz == null ? -480 : tz) + 240) * 60000);
  function apply(ev) {
    const time = schedTime(ev.t, ev.tz);
    if (ev.k === 'reset') { K = blank(); return; }       // start again from nothing; what came before stays in the record
    if (ev.k === 'device') { devices[ev.dev || ev.id.split('-')[0]] = ev.info; return; }
    if (ev.k === 'sorted') { ev.ws.forEach(w => { K.sorted[w] = true; }); return; }
    if (ev.k === 'flag') { if (ev.flag === 'bad sentence' && ev.sid) { if (ev.on) K.retired[ev.sid] = true; else delete K.retired[ev.sid]; } return; }
    if (!ev.w) return;
    const r = rec(ev.w);
    if (ev.k === 'mark') {
      if (ev.id && ev.src === 'import') K.imported[ev.id] = true;
      if (ev.v === 'easy' || ev.v === 'unknown') r.markEv = ev.id;
      if (ev.v === 'easy') {
        if (r.mark === 'easy') return;       // already so (the same mark can arrive twice, from two devices)
        r.mark = 'easy'; r.stage = 'none'; r.diag = null; r.left = true; r.before = true;
        ['m', 's', 'r', 'u'].forEach(p => { r.parts[p] = prior(365, time); });
        r.parts.t = prior(15, time);       // tones are the part people are least aware of not knowing: checked after about a month
      } else if (ev.v === 'unknown') {
        if (r.mark === 'unknown' && r.stage === 'wait') return;
        r.mark = 'unknown'; r.parts = {}; r.stage = 'wait'; r.knows = false; r.intro = 0; r.diag = null; r.left = false; r.before = false; r.rr = []; r.started = false;
      } else if (ev.v === 'clear') {
        if (r.mark === 'easy') Object.keys(r.parts).forEach(p => { if (r.parts[p].src === 'said') delete r.parts[p]; });
        if (r.mark === 'unknown' && r.stage === 'wait') r.stage = 'none';
        r.mark = null;
      } else if (ev.v === 'want') r.want = 1;
      else if (ev.v === 'unwant') r.want = 0;
      else if (ev.v === 'drop') r.drop = true;
      else if (ev.v === 'undrop') r.drop = false;
      return;
    }
    if (ev.k === 'look') {          // you clicked the word to see what it is: counted as not knowing its meaning
      if (!ev.noted || !byWord[ev.w]) return;
      if (r.mark === 'easy') r.mark = null;
      if (r.stage === 'none') { r.started = true; r.left = false; return; }       // not being learned: it joins the words in play
      const part = r.parts.m || (r.parts.m = { card: F.createEmptyCard(time), right: 0, wrong: 0, src: null });
      part.card = fsrs.next(part.card, time, F.Rating.Again).card; part.wrong++; part.last = false; part.src = 'tested';
      return;
    }
    if (ev.k === 'intro' || ev.k === 'start') {
      r.stage = 'active'; r.act = +time; r.started = true;
      if (ev.k === 'intro') r.intro = +time;
      return;
    }
    if (ev.k !== 'ans') return;
    const res = ev.res || {};
    K.nAns++;
    // slow for you: more than three times your usual time for this kind of question (and not a long pause away from it)
    const times = K.ms[ev.type] || (K.ms[ev.type] = []);
    const usual = times.length >= 15 ? times.slice().sort((a, b) => a - b)[times.length >> 1] : 0;
    const slow = usual > 0 && ev.ms > 3 * usual && ev.ms < 180000;
    if (ev.verdict === 'right' && ev.ms < 180000) { times.push(ev.ms); if (times.length > 50) times.shift(); }
    const day = Math.floor(+time / 86400000);
    Object.keys(res).forEach(p => {
      const o = res[p];
      let part = r.parts[p];
      if (o.how === 'implied' && part && part.src === 'said') return;       // typing a word right renews its meaning too
      if (!part) part = r.parts[p] = { card: F.createEmptyCard(time), right: 0, wrong: 0, src: null };
      const first = part.right + part.wrong === 0 && part.src !== 'said';
      // right = Good, wrong = Again. Easy only for typing a word never taught here (you knew it already), and for the meaning
      // that implies. Hard for a right answer that was slow for you.
      const rating = !o.ok ? F.Rating.Again : (first && ev.prior && (p === 'r' || o.how === 'implied')) ? F.Rating.Easy
        : (slow && o.how === 'typed') ? F.Rating.Hard : F.Rating.Good;
      // What does not change the memory state: a second answer on the same day (unless a right has turned wrong), and
      // a right pick from four on a part that was not slipping (it may be a guess, and proves little).
      const sameDay = part.day === day && !(part.last === true && !o.ok);
      const idlePick = o.ok && o.how === 'choice' && !first && part.card.state !== 0 && fsrs.get_retrievability(part.card, time, false) >= TARGET_R;
      if (!sameDay && !idlePick) { part.card = fsrs.next(part.card, time, rating).card; part.day = day; }
      if (o.ok) part.right++; else part.wrong++;
      part.last = o.ok;
      part.src = o.how === 'implied' ? 'implied' : 'tested';
    });
    // In play, and out of it. A word leaves play when you have typed it right twice in a sitting, at least eight
    // questions apart (once, if you typed it right before it was ever taught). It is "known" when typed right on a
    // second day. Missing its recall puts it back in play.
    r.started = true; r.lastAns = +time;
    if (res.r && res.r.how === 'typed') {
      if (res.r.ok) {
        r.rr = (r.rr || []).concat([{ n: K.nAns, d: day }]);
        if (ev.prior) r.before = true;
        if (r.before || r.rr.some(x => K.nAns - x.n >= 8)) r.left = true;
      } else { r.rr = []; r.left = false; r.before = false; }
    }
    // how hard each kind of question is for you: nudged by how answers turn out against what was expected
    if (ev.p != null && K.d[ev.type] != null && (ev.verdict === 'right' || ev.verdict === 'wrong') && !ev.idk)
      K.d[ev.type] += 0.15 * (ev.p - (ev.verdict === 'right' ? 1 : 0));
    const bad = p => res[p] && !res[p].ok;
    if (r.mark === 'easy' && (bad('m') || bad('r'))) r.mark = null;
    if (r.mark === 'unknown' && res.m && res.m.ok) r.mark = null;
    if (ev.reason === 'follow') { r.knows = !!(res.m && res.m.ok); r.stage = 'wait'; r.diag = 'done'; r.intro = 0; r.waitT = +time; }
    else if (ev.reason === 'findout' && res.r) r.diag = bad('r') ? 'recallFailed' : 'known';      // older events found out by typing first
    else if (ev.reason === 'findout' && (res.m || ev.idk)) {          // first met in a sentence and not known: show its card before asking again
      if (bad('m') || ev.idk) { r.stage = 'wait'; r.knows = false; r.intro = 0; r.diag = 'done'; r.waitT = +time; }
      else r.diag = 'recognised';
    } else if (ev.reason === 'probe' && res.r) {          // recognised; can it also be typed? If not, learn that, skipping the card
      if (bad('r')) { r.stage = 'wait'; r.knows = true; r.diag = 'done'; r.waitT = +time; }
      else r.diag = 'known';
    }
    else if (r.stage === 'none' && bad('r')) r.diag = 'recallFailed';
    else if (ev.idk && bad('m')) { r.stage = 'wait'; r.knows = false; r.intro = 0; r.waitT = +time; }   // "I don't know" what it means: teach it again
    if (ev.sid) {
      const sr = K.sent[ev.sid] || (K.sent[ev.sid] = { card: F.createEmptyCard(time), right: 0, wrong: 0, seen: 0 });
      sr.seen++; sr.at = K.nAns;
      if (ev.sres) {
        sr.card = fsrs.next(sr.card, time, { good: F.Rating.Good, hard: F.Rating.Hard, again: F.Rating.Again }[ev.sres]).card;
        if (ev.sres === 'again') sr.wrong++; else sr.right++;
      }
      r.lastSent = ev.sid;
    }
    if (ev.sense >= 0) {       // each meaning of a word keeps its own count
      const u = r.senses[ev.sense] || (r.senses[ev.sense] = { right: 0, wrong: 0 });
      if (ev.verdict === 'right') u.right++; else if (ev.verdict === 'wrong') u.wrong++;
    }
    if (ev.part) r.cyc[ev.part] = (r.cyc[ev.part] || 0) + 1;     // how many times each kind of step has been done, to rotate tasks
  }
  let devices = {};      // device name -> what kind of device it said it was
  function rebuild() {
    K = blank(); devices = {};
    const undone = new Set(events.filter(e => e.k === 'undo').map(e => e.ref));
    events.forEach(e => { if (!undone.has(e.id)) apply(e); });
  }
  function log(ev) {
    ev.t = new Date().toISOString(); ev.id = st.dev + '-' + (++st.seq); ev.dev = st.dev; ev.tz = new Date().getTimezoneOffset();
    events.push(ev); apply(ev); save();
    persist([ev]); syncSoon();
    return ev;
  }
  // lists you gave me, built into the data file: applied once, as marks
  function applyImports() {
    (D.marks || []).forEach(m => { const id = m.v + ':' + m.w; if (!K.imported[id]) log({ k: 'mark', w: m.w, v: m.v, src: 'import', id }); });
  }

  // ---------- sync: each device writes only its own files in the private repository and reads the others' ----------
  const H = window.HANYU || {};
  const canSync = () => !!(!H.local && H.token && H.token());
  let syncing = null, syncTimer = null;
  async function gh(method, path, opt) {
    opt = opt || {};
    const headers = { Authorization: 'Bearer ' + H.token(), Accept: opt.raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json' };
    if (opt.body) headers['Content-Type'] = 'application/json';
    const r = await fetch('https://api.github.com/repos/' + H.repo + '/' + path,
      { method, headers, cache: 'no-store', body: opt.body ? JSON.stringify(opt.body) : undefined });
    if (!r.ok) { const e = new Error('GitHub ' + r.status); e.status = r.status; throw e; }
    return opt.raw ? r.text() : r.json();
  }
  function b64(text) {
    const bytes = new TextEncoder().encode(text);
    let out = '';
    for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(out);
  }
  const encPath = p => p.split('/').map(encodeURIComponent).join('/');
  let onMerged = () => {};
  function sync() {
    if (!canSync()) return Promise.resolve(false);
    if (syncing) return syncing;
    syncing = (async () => {
      try {
        const tree = await gh('GET', 'git/trees/main?recursive=1');
        const remote = {};
        tree.tree.forEach(f => { if (f.type === 'blob' && /^log\/[^/]+\/[\d-]+\.jsonl$/.test(f.path)) remote[f.path] = f.sha; });
        // read files that changed since last time
        const have = new Set(events.map(e => e.id)), fresh = [];
        for (const path of Object.keys(remote)) {
          if (st.sync.seen[path] === remote[path]) continue;
          const text = await gh('GET', 'contents/' + encPath(path), { raw: true });
          text.split('\n').forEach(line => {
            if (!line.trim()) return;
            try { const e = JSON.parse(line); if (e.id && e.t && !have.has(e.id)) { have.add(e.id); fresh.push(e); } } catch (x) { /* skip a damaged line */ }
          });
          st.sync.seen[path] = remote[path];
        }
        if (fresh.length) {
          events = events.concat(fresh).sort(byTime);
          await persist(fresh);
          rebuild();
          onMerged();
        }
        // write this device's own events, one file per month
        const mine = {};
        events.forEach(e => { if (e.id.startsWith(st.dev + '-')) (mine[e.t.slice(0, 7)] = mine[e.t.slice(0, 7)] || []).push(e); });
        for (const month of Object.keys(mine)) {
          if (st.sync.pushed[month] === mine[month].length) continue;
          const path = 'log/' + st.dev + '/' + month + '.jsonl';
          const body = { message: 'sync ' + st.dev, branch: 'main', content: b64(mine[month].map(e => JSON.stringify(e)).join('\n') + '\n') };
          if (remote[path]) body.sha = remote[path];
          const out = await gh('PUT', 'contents/' + encPath(path), { body });
          st.sync.seen[path] = out.content.sha;
          st.sync.pushed[month] = mine[month].length;
        }
        st.sync.devices = new Set(Object.keys(remote).map(p => p.split('/')[1]).concat(Object.keys(mine).length ? [st.dev] : [])).size;
        st.sync.last = new Date().toISOString(); st.sync.err = null;
        return true;
      } catch (e) {
        st.sync.err = e.status === 401 ? 'the token was refused' : e.status === 403 || e.status === 404 ? 'the token cannot write to the data repository'
          : e.status ? 'GitHub answered ' + e.status : 'no connection';
        return false;
      } finally { syncing = null; save(); }
    })();
    return syncing;
  }
  function syncSoon() { if (!canSync()) return; clearTimeout(syncTimer); syncTimer = setTimeout(sync, 20000); }
  if (canSync()) {
    setInterval(() => { if (document.visibilityState === 'visible') sync(); }, 300000);
    document.addEventListener('visibilitychange', () => { sync(); });
    window.addEventListener('online', () => { sync(); });
  }

  // ---------- reading the picture ----------
  function retr(part, now) {
    if (!part) return null;
    if (part.card.state === 0) return 0;
    const v = fsrs.get_retrievability(part.card, schedTime(now.toISOString(), now.getTimezoneOffset()), false);
    return typeof v === 'number' ? v : 0;
  }
  const tested = part => !!part && part.right + part.wrong > 0;
  const sentsOf = w => (byWord[w] ? byWord[w].s : []).filter(x => !K.retired[x[0]]);
  function consolidated(r) { return ['m', 'r'].every(p => r.parts[p] && r.parts[p].right > 0 && r.parts[p].card.stability >= 4); }
  function status(w) {
    const r = K.w[w], word = byWord[w];
    if (r && r.drop) return 'drop';
    if (r && r.mark === 'easy') return 'easy';
    if (r && r.stage === 'wait') return 'wait';
    if (r && (r.started || r.stage === 'active')) {
      if (!r.left) return 'learning';
      return (r.before || new Set((r.rr || []).map(x => x.d)).size >= 2) ? 'known' : 'resting';      // resting: out of play, to be typed again another day
    }
    return word && word.lv === D.level ? 'untouched' : 'assumed';
  }
  // the chance that a part of a word is there right now
  function partR(w, p, now) {
    const r = K.w[w] || { parts: {} }, part = r.parts[p];
    if (!part) return p === 'm' ? (r.intro ? 0.5 : 0.3) : 0.7 * partR(w, 'm', now);       // no evidence yet
    if (part.last === false) return 0.3;                                                    // missed and not yet repaired
    return retr(part, now);
  }
  // the chance of a right answer to a kind of question about a word
  function pRight(w, t, now) {
    const R = Math.min(0.95, Math.max(0.05, partR(w, TASK[t].part, now)));
    return TASK[t].g + (1 - TASK[t].g) / (1 + Math.exp(K.d[t] - Math.log(R / (1 - R))));
  }
  const weakPart = (w, p, now) => partR(w, p, now) < TARGET_R && !(p === 'm' && partR(w, 'r', now) >= TARGET_R);      // meaning is not slipping while recall holds

  // ---------- small helpers ----------
  const $ = id => document.getElementById(id);
  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    for (const k in (props || {})) {
      if (k === 'class') n.className = props[k];
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), props[k]);
      else if (k === 'text') n.textContent = props[k];
      else n.setAttribute(k, props[k]);
    }
    kids.flat().forEach(c => { if (c != null) n.append(c); });
    return n;
  }
  const rand = n => Math.floor(Math.random() * n);
  function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = rand(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
  const normZh = s => s.replace(/[\s，。！？、；：“”‘’（）《》〈〉…—·,.!?;:"'()\[\]~～\-]/g, '');
  const normPin = s => s.toLowerCase().replace(/u:|ü/g, 'v').replace(/[\s'’·\-]/g, '').replace(/[05]/g, '');
  const letters = s => s.toLowerCase().replace(/u:|[üǖǘǚǜ]/g, 'v').normalize('NFD').replace(/[^a-z]/g, '');
  const toneDigits = s => s.replace(/[^0-5]/g, '').replace(/0/g, '5');
  const wordToks = s => s.t.filter(t => t.k !== 'p');
  const readings = w => byWord[w].p.join(' / ');
  function today() { const d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }

  // sentence for a word: one that shows a meaning you have succeeded with least, seen least, not the last one used
  function pickSent(w, opt) {
    opt = opt || {};
    let c = sentsOf(w);
    if (opt.seenOnly) c = c.filter(x => K.sent[x[0]] && K.sent[x[0]].seen && K.nAns - K.sent[x[0]].at >= 10);      // met, and not just now
    if (opt.needHit) c = c.filter(x => x[1] >= 0);
    const r = K.w[w];
    if (c.length > 1 && r) c = c.filter(x => x[0] !== r.lastSent);
    if (!c.length) return null;
    // first: as few other words you don't know as possible (ideally the word asked about is the only new thing)
    const shaky = x => wordToks(S[x[0]]).filter(t => t.w !== w && byWord[t.w] && ['wait', 'learning', 'checking', 'untouched'].includes(status(t.w))).length;
    const score = x => shaky(x) * 1000 + ((r && r.senses[x[1]] ? r.senses[x[1]].right : 0) * 10) + (K.sent[x[0]] ? K.sent[x[0]].seen : 0);
    const best = Math.min(...c.map(score));
    c = c.filter(x => score(x) === best);
    return c[rand(c.length)];
  }
  // the content words of a word's listed meanings, to tell when two words mean nearly the same
  const SMALL = new Set('the and for not with from into that this very some one any all are was has have had its our out off too can will would may also'.split(' '));
  function glossWords(word) {
    if (!word._g) {
      word._g = new Set();
      word.items.forEach(it => it.toLowerCase().replace(/\(.*?\)/g, ' ').split(/[^a-z]+/).forEach(t => {
        if (t.length > 2 && !SMALL.has(t)) word._g.add(t.replace(/(ing|ed|ly|s)$/, ''));
      }));
    }
    return word._g;
  }
  function overlaps(a, b) { const A = glossWords(a); for (const t of glossWords(b)) if (A.has(t)) return true; return false; }
  // wrong options: other level-4 words, never one that shares a meaning with the right answer (而 "but; yet" against 可是 "but")
  // The meanings of a word that real sentences use, commonest first (counted by reading the sentences). Words that were
  // not counted keep the list's own order.
  function usedMeanings(word) {
    const idx = word.items.map((_, i) => i);
    if (!word.freq) return idx;
    const used = idx.filter(i => word.freq[i] > 0).sort((a, b) => word.freq[b] - word.freq[a]);
    return used.length ? used : idx.slice(0, 3);
  }
  // which meaning to ask about next: the one you have got right least, commonest first
  function nextMeaning(w) {
    const word = byWord[w], r = K.w[w], used = usedMeanings(word);
    const rights = i => (r && r.senses[i] ? r.senses[i].right : 0);
    return used.slice().sort((a, b) => rights(a) - rights(b) || used.indexOf(a) - used.indexOf(b))[0];
  }
  function defView(word, cls) {
    if (!word.freq) return el('div', { class: cls, text: word.def });
    const used = usedMeanings(word), rest = word.items.map((_, i) => i).filter(i => !used.includes(i));
    return el('div', { class: cls }, used.map(i => word.items[i]).join('; '),
      rest.length ? el('div', { class: 'muted small', text: 'also listed, but not found in real sentences: ' + rest.map(i => word.items[i]).join('; ') }) : null);
  }
  function distractorWords(w, n, avoid) {
    const me = byWord[w];
    const ok = x => x.w !== w && !avoid.has(x.w) && !overlaps(me, x);
    let pool = targets.filter(x => ok(x) && x.pos === me.pos);
    if (pool.length < n * 3) pool = targets.filter(ok);
    const same = pool.filter(x => x.w.length === w.length);
    if (same.length >= n * 3) pool = same;
    return shuffle(pool).slice(0, n);
  }
  function diff(a, b) {
    const m = a.length, n = b.length, L = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const ya = el('div', { class: 'yours' }), yb = el('div', { class: 'yours missing' });
    let i = 0, j = 0;
    while (i < m || j < n) {
      if (i < m && j < n && a[i] === b[j]) { ya.append(a[i]); yb.append(b[j]); i++; j++; }
      else if (j < n && (i === m || L[i][j + 1] >= L[i + 1][j])) { yb.append(el('ins', { text: b[j] })); j++; }
      else { ya.append(el('del', { text: a[i] })); i++; }
    }
    return [ya, yb];
  }

  // ---------- pace: "slower" and "faster" nudge how much is new and how soon things come back. The nudge wears off. ----------
  // It wears off mainly with real time (so it is gone by the next day you open the app), and also with use.
  const PACE_HOURS = 6;       // hours of real time after which one step has worn off
  const PACE_ANSWERS = 60;    // ...or this many answers
  function pace() {
    const steps = Math.floor((Date.now() - (st.paceTime || 0)) / (PACE_HOURS * 3600000)) + Math.floor((st.counter - (st.paceAt || 0)) / PACE_ANSWERS);
    if (steps > 0) {
      if (st.pace) st.pace -= Math.sign(st.pace) * Math.min(Math.abs(st.pace), steps);
      st.paceAt = st.counter; st.paceTime = Date.now();
    }
    return st.pace || 0;
  }
  function nudge(d) {
    pace();
    st.pace = Math.max(-3, Math.min(3, (st.pace || 0) + d)); st.paceAt = st.counter; st.paceTime = Date.now();
    log({ k: 'pace', d, now: st.pace });
    if (current && !current.done) { if (d > 0) current.fast = true; else current.slow = true; }
    // say what the press did, then where that leaves things (a "slower" press can still leave you faster than normal)
    const n = Math.abs(st.pace), where = st.pace === 0 ? 'back to the normal pace' : n + (n === 1 ? ' step ' : ' steps ') + (st.pace > 0 ? 'faster' : 'slower') + ' than normal';
    toast((d > 0 ? 'Faster' : 'Slower') + ': now ' + where);
  }

  // ---------- what comes next ----------
  const SITTING = 30 * 60000;
  function nextItem() {
    const now = new Date(), recentW = st.recent.slice(0, 3).map(x => x.w), last = recentW[0];
    const pc = pace();     // -3..3
    const dueLimit = DUE_THRESHOLD + 4 * pc, inPlayCap = YOUNG_CAP + 3 * pc;
    const cool = st.cool || {};
    const asks = st.asks || {};
    const parked = w => (!!cool[w] && cool[w].fails >= 2 && Date.now() - cool[w].t < SITTING) ||      // missed twice: put aside for this sitting
      (!!asks[w] && asks[w].n >= 5 && Date.now() - asks[w].t < SITTING);                              // or asked five times already: enough for now
    const cooling = w => !!cool[w] && st.counter < cool[w].until;                                  // missed once: not again for a while
    const base = w => byWord[w] && !(K.w[w] && (K.w[w].drop || K.w[w].stage === 'wait'));
    const live = w => base(w) && !parked(w) && !cooling(w);
    st.retry = st.retry.filter(x => base(x.w) && !parked(x.w));
    // 1. something missed a while ago. Never two of these in a row.
    const wasRetry = st.lastRetry; st.lastRetry = false;
    const ready = st.retry.filter(x => st.counter >= x.at);
    const r1 = wasRetry ? null : ready.find(x => x.w !== last);
    if (r1) { st.lastRetry = true; return { w: r1.w }; }
    const pending = new Set(st.retry.map(x => x.w));
    const free = w => live(w) && !pending.has(w);
    // 2. a word out of play whose recall, use or meaning is slipping; the one most likely still remembered first
    const due = [];
    Object.keys(K.w).forEach(w => {
      const st2 = status(w);
      if (!free(w) || !['known', 'resting', 'easy'].includes(st2)) return;
      const weak = ['r', 'u', 'm'].filter(p => K.w[w].parts[p] && weakPart(w, p, now));
      if (weak.length) due.push({ w, v: Math.min(...weak.map(p => partR(w, p, now))) });
    });
    due.sort((a, b) => b.v - a.v);
    const d = due.find(x => !recentW.includes(x.w)) || due[0];
    if (d) return { w: d.w };
    // a pinyin check now and then: about one question in twelve, on a word you typed right today. It holds nothing up.
    if ((st.sinceRead || 0) >= 11) {
      const today = Math.floor(+schedTime(now.toISOString(), now.getTimezoneOffset()) / 86400000);
      const c = Object.keys(K.w).filter(w => free(w) && !recentW.includes(w) && (K.w[w].rr || []).some(x => x.d === today) &&
        (!K.w[w].parts.t || retr(K.w[w].parts.t, now) < TARGET_R))
        .sort((a, b) => (K.w[a].parts.t ? 1 : 0) - (K.w[b].parts.t ? 1 : 0) || (K.w[a].lastAns || 0) - (K.w[b].lastAns || 0))[0];
      if (c) return { w: c, type: 'read', check: true };
    }
    // 3. words in play, the one that has waited longest first
    const playing = Object.keys(K.w).filter(w => base(w) && status(w) === 'learning');
    const canPlay = playing.filter(w => free(w) && !recentW.includes(w)).sort((a, b) => (K.w[a].lastAns || 0) - (K.w[b].lastAns || 0));
    // 4. new words: met for the first time, or taught from the don't-know list. Only while fewer than the cap are in play.
    const want = w => (K.w[w] ? K.w[w].want : 0);
    const waitQ = Object.keys(K.w).filter(w => K.w[w].stage === 'wait' && !K.w[w].drop && byWord[w] && !parked(w) && !cooling(w))
      .sort((a, b) => (want(b) - want(a)) || ((K.w[a].waitT || 0) - (K.w[b].waitT || 0)) || (rankOf(a) - rankOf(b)));
    const findQ = order.filter(x => status(x.w) === 'untouched' && !pending.has(x.w)).map(x => x.w)
      .sort((a, b) => (want(b) - want(a)) || (rankOf(a) - rankOf(b)));
    const room = playing.length < inPlayCap && new Set(due.map(x => x.w)).size < dueLimit;
    const newOne = force => {
      if (!room && !force) return null;
      if (findQ.length && waitQ.length < 20 && !K.sorted[findQ[0]]) return { sort: findQ.filter(w => !K.sorted[w]).slice(0, SORT_BATCH) };
      st.turn++;
      if (waitQ.length && (st.turn % 3 === 0 || !findQ.length || waitQ.length >= 20)) return { intro: waitQ[0] };
      if (findQ.length) return { w: findQ[0], reason: 'findout' };
      return waitQ.length ? { intro: waitQ[0] } : null;
    };
    st.mix = (st.mix || 0) + 1;
    if (canPlay.length && (st.mix % 3 !== 0 || !room)) return { w: canPlay[0] };      // two turns for words in play, one for a new word
    const fresh = newOne();
    if (fresh) return fresh;
    if (canPlay.length) return { w: canPlay[0] };
    if (ready.length) return { w: ready[0].w };
    if (st.retry.length) return { w: (st.retry.find(y => y.w !== last) || st.retry[0]).w };
    // 5. nothing waiting: extra practice on words out of play
    const known = Object.keys(K.w).filter(w => free(w) && !recentW.includes(w) && ['known', 'resting'].includes(status(w)))
      .sort((a, b) => (K.w[a].lastAns || 0) - (K.w[b].lastAns || 0)).slice(0, 4);
    if (known.length) return { w: known[rand(known.length)], extra: true };
    const more = newOne(true);       // everything in play is resting for now: bring in something new rather than repeat
    if (more) return more;
    const stuck = playing.filter(w => base(w))[0];
    if (stuck) return { w: stuck };
    if (waitQ.length) return { intro: waitQ[0] };
    return { done: true };
  }

  // Which kind of question a word gets. There is no fixed order. Among the questions that test a part still in doubt,
  // it takes the hardest one you are likely to get right (the chance must be at least the floor); if none is likely,
  // the easiest. "faster" lowers the floor (harder questions sooner), "slower" raises it.
  function available(w) {
    const has = sentsOf(w).length > 0;
    if (!has) return ['read', 'meaningToWord'];
    const hit = !!pickSent(w, { needHit: true });
    const tilesLately = st.recent.slice(0, 4).some(x => x.type === 'tiles');       // tile order cannot be fully marked: at most one in five
    return [hit && 'gap', !tilesLately && 'tiles', 'tilesType', hit && 'typedGap', 'retype', pickSent(w, { seenOnly: true }) && 'typeBack'].filter(Boolean);
  }
  function chooseTask(w) {
    const now = new Date(), floor = Math.min(0.8, Math.max(0.5, 0.6 - 0.05 * pace()));
    const twice = t => st.recent.length > 1 && st.recent[0].type === t && st.recent[1].type === t;
    let can = available(w).filter(t => !twice(t));
    if (!can.length) can = available(w);
    let c = can.filter(t => weakPart(w, TASK[t].part, now));                // questions for parts still in doubt
    if (!c.length) c = can.filter(t => TASK[t].part === 'r');               // nothing in doubt: practise recall
    if (!c.length) c = can;
    const ok = c.filter(t => pRight(w, t, now) >= floor);
    const by = (list, sign) => list.slice().sort((a, b) => sign * (pRight(w, a, now) - pRight(w, b, now)))[0];
    return ok.length ? by(ok, 1) : by(c, -1);
  }
  function typeFor(it) { return it.type || chooseTask(it.w); }
  function makeTask(it) {
    const type = typeFor(it), w = it.w;
    const needsSent = !['read', 'tones', 'meaningToWord'].includes(type);
    const pick = needsSent ? pickSent(w, { seenOnly: type === 'typeBack', needHit: type === 'gap' || type === 'typedGap' }) : null;
    return { word: w, type, part: TASK[type] ? TASK[type].part : null, reason: it.reason || null, extra: !!it.extra, check: !!it.check,
      sent: pick ? S[pick[0]] : null, sense: pick ? pick[1] : (type === 'meaningToWord' ? nextMeaning(w) : -1), started: Date.now(), done: false };
  }

  // ---------- marks on words ----------
  let current = null;       // the question on screen
  let idkNow = () => {};
  function toast(content, undo) {
    const t = $('toast');
    t.replaceChildren(content, undo ? el('button', { text: 'undo', onclick: () => { undo(); t.hidden = true; } }) : '');
    t.hidden = false;
    clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, 4000);
  }
  function mark(w, v, src) {
    const r = K.w[w], was = r ? r.mark : null;
    const during = current && !current.done && current.word === w;
    if (during && v === 'unknown') { idkNow(); log({ k: 'mark', w, v, src: src || 'click' }); return; }   // show the answer, then put it on the list
    const made = log({ k: 'mark', w, v, src: src || 'click' });
    const label = { easy: 'trivially easy', unknown: "don't know", want: 'want to learn', unwant: 'no longer marked want to learn',
      drop: 'will not be shown', undrop: 'will be shown again', clear: 'mark removed' }[v];
    toast(w + ': ' + label + (byWord[w] ? '' : ' (not in the word lists, so it is only noted)'),
      ['easy', 'unknown'].includes(v) ? () => { log({ k: 'undo', ref: made.id }); rebuild(); } : null);
    if (during && (v === 'easy' || v === 'drop')) advance();
  }
  function unmark(w) {       // take back the last "trivially easy" / "don't know" on a word; what was known before returns
    const r = K.w[w];
    if (!r || !r.markEv) return;
    log({ k: 'undo', ref: r.markEv }); rebuild();
    toast(w + ': mark removed');
  }
  function infoOf(w, tok) {
    if (tok && tok.p) return { p: tok.p, g: tok.g };
    return byWord[w] ? { p: readings(w), g: byWord[w].short } : { p: '', g: '' };
  }
  // clicking a word shows what it is, and is remembered as not having known it (unless it is the word just asked about)
  function showInfo(w, tok, node) {
    const i = infoOf(w, tok);
    const noted = !!byWord[w] && !(current && current.word === w);
    const ev = log({ k: 'look', w, noted, during: !!(current && !current.done), sid: current && current.sent ? current.sent.id : null });
    if (noted && node) node.classList.add('noted');
    toast(el('span', null, el('b', { class: 'zh', text: w }), '  ' + i.p + (i.g ? ' — ' + i.g : ''), noted ? el('i', { text: '  · noted as not known' }) : ''),
      noted ? () => { log({ k: 'undo', ref: ev.id }); rebuild(); if (node) node.classList.remove('noted'); } : null);
  }
  function wordMenu(w, tok, x, y, hideInfo) {
    const m = $('wordmenu'), r = K.w[w] || {}, i = infoOf(w, tok);
    const item = (text, v) => el('button', { text, onclick: () => { m.hidden = true; mark(w, v); } });
    m.replaceChildren(
      el('div', { class: 'head' }, el('b', { class: 'zh', text: w }), hideInfo ? '' : '  ' + i.p + (i.g ? ' — ' + i.g : '')),
      item("Don't know this word", 'unknown'), item('Trivially easy', 'easy'),
      r.want ? item('Remove “want to learn”', 'unwant') : item('Want to learn', 'want'),
      r.drop ? item('Show this word again', 'undrop') : item("Don't show this word", 'drop'),
      (r.mark ? el('button', { text: 'Remove my mark (' + (r.mark === 'easy' ? 'trivially easy' : "don't know") + ')', onclick: () => { m.hidden = true; unmark(w); } }) : ''));
    m.hidden = false;
    m.style.left = Math.max(8, Math.min(x, window.innerWidth - m.offsetWidth - 8)) + 'px';
    m.style.top = Math.max(8, Math.min(y, window.innerHeight - m.offsetHeight - 8)) + 'px';
  }
  document.addEventListener('click', e => { if (!$('wordmenu').hidden && !$('wordmenu').contains(e.target)) $('wordmenu').hidden = true; }, true);
  // every Chinese word on screen goes through here: click = plain action, shift = don't know, ctrl = trivially easy, right-click or long-press = menu
  function wordEl(tag, w, tok, props, plain, hideInfo) {
    const n = el(tag, props);
    let held = false, timer = null;
    n.addEventListener('click', e => {
      if (held) { held = false; e.preventDefault(); e.stopPropagation(); return; }
      if (e.shiftKey) { e.preventDefault(); mark(w, 'unknown'); }
      else if (e.ctrlKey || e.metaKey) { e.preventDefault(); mark(w, 'easy'); }
      else if (plain) plain(e);
      else if (!hideInfo) showInfo(w, tok, n);
    });
    n.addEventListener('contextmenu', e => { e.preventDefault(); wordMenu(w, tok, e.clientX, e.clientY, hideInfo); });
    n.addEventListener('touchstart', e => {
      const p = e.touches[0];
      timer = setTimeout(() => { held = true; wordMenu(w, tok, p.clientX, p.clientY, hideInfo); }, 550);
    }, { passive: true });
    ['touchend', 'touchmove', 'touchcancel'].forEach(t => n.addEventListener(t, () => clearTimeout(timer), { passive: true }));
    return n;
  }

  // ---------- views ----------
  const main = $('main');
  let onEnter = null, onDigit = null;
  document.addEventListener('keydown', e => {
    if (e.isComposing || e.keyCode === 229 || !$('menu').hidden) return;
    if (e.key === 'Enter' && onEnter) { e.preventDefault(); onEnter(); }
    else if (onDigit && /^[1-4]$/.test(e.key) && document.activeElement.tagName !== 'INPUT') onDigit(+e.key - 1);
  });
  function screen(statusText, ...kids) {
    onEnter = onDigit = null;
    $('status').textContent = statusText || '';
    $('backBtn').hidden = (viewing < 0 ? backTop() : viewing - 1) < 0;
    main.replaceChildren(...kids.flat().filter(Boolean));
    window.scrollTo(0, 0);
  }
  function textInput(placeholder, latin) {
    const i = el('input', { type: 'text', placeholder: placeholder || '', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
    if (latin) i.style.fontFamily = 'inherit'; else i.setAttribute('lang', 'zh-CN');
    return i;
  }
  // The names in a sentence, to tap into the box: typing a name is not what is being practised.
  function nameTags(s, inp, task) {
    const names = [...new Set(s.t.filter(t => t.k === 'n').map(t => t.w))];
    if (!names.length) return '';
    return el('div', { class: 'names' }, names.map(n => el('button', { class: 'chip name', text: n, title: 'Put this name in', onclick: () => {
      const a = inp.selectionStart == null ? inp.value.length : inp.selectionStart, b = inp.selectionEnd == null ? a : inp.selectionEnd;
      inp.value = inp.value.slice(0, a) + n + inp.value.slice(b);
      inp.focus(); inp.setSelectionRange(a + n.length, a + n.length);
      (task.tapped = task.tapped || []).push(n);
    } })));
  }
  function sentView(s, opt) {
    opt = opt || {};
    const line = el('div', { class: 'sent' });
    let gapDone = false;
    s.t.forEach(t => {
      if (t.k === 'p') { line.append(t.w); return; }
      if (opt.gap && t.w === opt.gap && !gapDone) { gapDone = true; line.append(el('span', { class: 'gap', text: '　' })); return; }
      line.append(wordEl('span', t.w, t, { class: 'tok' + (t.w === opt.highlight ? ' target' : '') + (t.k === 'n' ? ' name' : ''), text: t.w }));
    });
    return line;
  }
  // set phrases in a sentence (出问题), from the dictionary: shown under it, since the tiles are the separate words
  const phraseLines = s => (s.ph || []).map(ph => el('div', { class: 'muted small phrase' }, el('b', { class: 'zh', text: ph.w }), '  ' + ph.p + ' — ' + ph.g));
  const pinyinLine = s => el('div', { class: 'pinyin small', text: s.t.map(t => t.k === 'p' ? '' : t.p.replace(/ \/ /g, '/')).filter(Boolean).join('  ') });
  const bigWord = (w, hide) => wordEl('div', w, null, { class: 'big', text: w }, null, hide);
  // one click shows the first pinyin letter of the word; it is noted on the answer
  function hintButton(task) {
    const b = el('button', { class: 'hint', text: 'Hint', onclick: () => {
      task.hint = true;
      b.replaceWith(el('div', { class: 'muted small hintline', text: 'Starts with ' + byWord[task.word].n[0][0] }));
    } });
    return b;
  }
  // under every question: slower · I don't know · faster
  const idkButton = () => el('div', { class: 'under' },
    el('button', { class: 'pace slower', title: 'More repetition and fewer new words for a while', text: '‹ slower', onclick: () => nudge(-1) }),
    el('button', { class: 'idk', title: "I don't know", onclick: () => idkNow() }, el('span', { class: 'x', text: '✗' }), el('span', { class: 'lbl', text: "I don't know" })),
    el('button', { class: 'pace faster', title: 'More new words and fewer easy steps for a while', text: 'faster ›', onclick: () => nudge(1) }));

  let sortTouched = false;
  function showSort(batch) {
    current = null; idle = 'sort'; sortTouched = false;
    const state = {};   // word -> 'easy' | 'unknown'
    const chips = batch.map(w => {
      const c = el('button', { class: 'chip zh', text: w });
      const set = v => { sortTouched = true; if (v) state[w] = v; else delete state[w]; c.className = 'chip zh' + (v ? ' ' + v : ''); };
      c.addEventListener('click', e => {
        if (e.shiftKey) set(state[w] === 'unknown' ? null : 'unknown');
        else if (e.ctrlKey || e.metaKey) set(state[w] === 'easy' ? null : 'easy');
        else set(!state[w] ? 'easy' : state[w] === 'easy' ? 'unknown' : null);
      });
      c.addEventListener('contextmenu', e => { e.preventDefault(); set(state[w] === 'unknown' ? null : 'unknown'); });
      return c;
    });
    const go = () => {
      batch.forEach(w => { if (state[w]) log({ k: 'mark', w, v: state[w], src: 'sort' }); });
      log({ k: 'sorted', ws: batch });
      advance();
    };
    screen('sorting',
      el('div', { class: 'prompt' }, 'Mark only the extremes and leave the rest. ',
        el('b', { class: 'easytxt', text: 'One tap: trivially easy.' }), ' ', el('b', { class: 'unktxt', text: "Two taps: don't know at all." }),
        ' (Also ctrl-click and shift-click.) Unmarked words will be tested.'),
      el('div', { class: 'chips' }, chips),
      el('button', { class: 'primary', text: 'Done', onclick: go }));
    onEnter = go;
  }

  // the words currently being learned, checked, or waiting to be taught: a list to mark
  function showWords() {
    current = null; idle = null;
    const all = Object.keys(K.w).filter(w => byWord[w] && !K.w[w].drop);
    const row = w => {
      const line = el('div', { class: 'wrow' });
      const set = (v, label) => { mark(w, v); line.classList.add('marked'); state.textContent = label; };
      const state = el('span', { class: 'muted small state' });
      line.append(wordEl('span', w, null, { class: 'h zh', text: w }, null, true),
        el('span', { class: 'mid' }, el('span', { class: 'pinyin small', text: readings(w) }), el('span', { class: 'muted small', text: byWord[w].short })),
        state,
        el('button', { class: 'know', title: 'I know this well', text: '✓', onclick: () => set('easy', 'known') }),
        el('button', { class: 'dont', title: "I don't know this at all", text: '✗', onclick: () => set('unknown', "don't know") }));
      return line;
    };
    const group = (title, list) => (list.length ? [el('h3', { text: title + ' (' + list.length + ')' }), list.map(row)] : null);
    const waiting = all.filter(w => status(w) === 'wait').sort((a, b) => (K.w[b].want - K.w[a].want) || ((K.w[a].waitT || 0) - (K.w[b].waitT || 0)) || (rankOf(a) - rankOf(b)));
    const parts = [
      el('div', { class: 'prompt', text: 'The words in play. ✓ if you know a word well, ✗ if you don\'t know it at all; leave the rest.' }),
      group('In play', all.filter(w => status(w) === 'learning').sort((a, b) => (K.w[b].lastAns || 0) - (K.w[a].lastAns || 0))),
      group('Waiting to be taught', waiting.slice(0, 60)),
      waiting.length > 60 ? el('div', { class: 'muted small', text: 'and ' + (waiting.length - 60) + ' more waiting' }) : null,
      el('button', { class: 'primary', text: 'Back to practice', onclick: advance })];
    screen('words in play', ...parts.flat(Infinity).filter(Boolean));
    onEnter = advance;
  }

  // ctx: 'missed' offers "I didn't know this at all"; 'right' offers "Trivially easy"; nothing else to press
  function wordCard(w, ctx) {
    const word = byWord[w], r = K.w[w] || { parts: {} }, now = new Date();
    const one = p => {
      const part = r.parts[p], v = retr(part, now);
      const cls = !part ? 'none' : part.src === 'said' ? 'said' : part.last === false ? 'bad' : v >= TARGET_R ? 'good' : 'slip';     // red = wrong last time
      const how = !part ? 'not tested' : part.src === 'said' ? 'you said' : part.src === 'implied' ? 'implied' : part.right + ' right, ' + part.wrong + ' wrong';
      return el('span', { class: 'part ' + cls, title: how, text: PARTS[p] });
    };
    const offer = (text, v, cls) => {
      const b = el('button', { class: cls, text, onclick: () => { mark(w, v); b.disabled = true; b.textContent = 'Noted'; } });
      return el('div', { class: 'under one' }, b);
    };
    return [el('div', { class: 'wordcard' },
      wordEl('span', w, null, { class: 'h', text: w }), el('span', { class: 'pinyin', text: readings(w) }),
      defView(word, 'def'),
      el('div', { class: 'parts' }, Object.keys(PARTS).map(one))),
      ctx === 'missed' && r.mark !== 'unknown' ? offer("✗ I didn't know this at all", 'unknown', 'dont') : null,
      ctx === 'right' && r.mark !== 'easy' ? offer('✓ Trivially easy', 'easy', 'know') : null];
  }

  function showIntro(w) {
    current = null;
    const word = byWord[w], sents = sentsOf(w).slice(0, 2).map(x => S[x[0]]);
    const go = knew => {
      log({ k: 'intro', w, knew: knew === false ? false : null }); st.counter++;
      st.retry.push({ w, at: st.counter + 2 });
      st.recent.unshift({ w, type: 'intro' }); st.recent.length = Math.min(st.recent.length, 5);
      save(); advance();
    };
    screen('new word',
      el('div', { class: 'prompt', text: 'A new word. Read it; you will be asked about it in a moment.' }),
      bigWord(w), el('div', { class: 'center pinyin', text: readings(w) }), defView(word, 'center def'),
      sents.map(s => el('div', null, sentView(s, { highlight: w }), el('div', { class: 'muted', text: s.en }), phraseLines(s))),
      el('button', { class: 'primary', text: 'Next', onclick: () => go() }),
      el('div', { class: 'under two' },
        el('button', { class: 'know', text: '✓ Trivially easy', onclick: () => { mark(w, 'easy'); advance(); } }),
        el('button', { class: 'dont', text: "✗ I didn't know this", onclick: () => go(false) })));
    onEnter = () => go();
  }

  function showTask(task) {
    current = task;
    VIEWS[task.type](task, (...kids) => screen(task.extra ? 'caught up · extra practice' : '', ...kids, idkButton()));
  }
  const T = (ok, how) => ({ ok, how: how || 'typed' });

  const VIEWS = {
    read(task, put) {
      const w = byWord[task.word];
      const inp = textInput('pinyin with tone numbers, e.g. ni3hao3', true);
      if (task.check) {        // the side check: how it is said, nothing to pick
        const go = () => {
          const typed = inp.value.trim(); if (!typed) return;
          const syl = w.n.some(n => letters(n) === letters(typed));
          const tone = w.n.some(n => normPin(n) === normPin(typed)) || w.p.some(p => normPin(p) === normPin(typed));
          const res = { s: T(syl) }; if (syl) res.t = T(tone);
          finish(task, { verdict: syl && tone ? 'right' : 'wrong', res, answer: typed, typed,
            lines: [{ label: 'Pinyin', ok: syl && tone, note: syl && tone ? typed : (syl ? 'the tones: ' : '') + 'you typed “' + typed + '”, it is ' + w.n.join(' or ') }] });
        };
        idkNow = () => finish(task, { verdict: 'wrong', idk: true, res: { s: T(false), t: T(false) }, answer: '' });
        put(el('div', { class: 'prompt', text: 'How is it said? (A side check: it changes nothing else.)' }), bigWord(w.w, true), inp,
          el('button', { class: 'primary', text: 'Check', onclick: go }));
        onEnter = go; inp.focus();
        return;
      }
      const opts = shuffle([w].concat(distractorWords(w.w, 3, new Set())));
      const answer = i => {
        const typed = inp.value.trim();
        if (!typed) { inp.focus(); inp.placeholder = 'type the pinyin first (or press ✗)'; return; }
        const syl = w.n.some(n => letters(n) === letters(typed));
        const tone = w.n.some(n => normPin(n) === normPin(typed)) || w.p.some(p => normPin(p) === normPin(typed));
        const mean = opts[i].w === w.w;
        const res = { s: T(syl), m: T(mean, 'choice') };
        if (syl) res.t = T(tone);
        finish(task, { verdict: syl && tone && mean ? 'right' : 'wrong', res, answer: typed + ' | ' + opts[i].short,
          shown: opts.map(o => o.w), picked: opts[i].w, typed,
          lines: [
            { label: 'Pinyin', ok: syl && tone, note: syl && tone ? typed : (syl ? 'the tones: ' : '') + 'you typed “' + typed + '”, it is ' + w.n.join(' or ') },
            { label: 'Meaning', ok: mean, note: mean ? opts[i].short : 'you chose “' + opts[i].short + '”' }] });
      };
      idkNow = () => finish(task, { verdict: 'wrong', idk: true, res: { m: T(false, 'choice'), s: T(false), t: T(false) }, answer: '' });
      put(el('div', { class: 'prompt', text: 'How is it said, and what does it mean?' }), bigWord(w.w, true), inp,
        el('div', { class: 'choices' }, opts.map((o, i) => el('button', { class: 'choice', text: o.short, onclick: () => answer(i) }))));
      inp.focus();
    },

    gap(task, put) {
      const s = task.sent, inSent = new Set(wordToks(s).map(t => t.w));
      const opts = shuffle([byWord[task.word]].concat(distractorWords(task.word, 3, inSent)));
      const answer = i => finish(task, { verdict: opts[i].w === task.word ? 'right' : 'wrong', res: { m: T(opts[i].w === task.word, 'choice') }, answer: opts[i].w,
        shown: opts.map(o => o.w), picked: opts[i].w });
      idkNow = () => finish(task, { verdict: 'wrong', idk: true, res: { m: T(false, 'choice') }, answer: '' });
      put(el('div', { class: 'prompt', text: 'Which word goes in the gap?' }), el('div', { class: 'en', text: s.en }), sentView(s, { gap: task.word }),
        el('div', { class: 'choices two' }, opts.map((o, i) => wordEl('button', o.w, null, { class: 'choice zh', text: o.w }, () => answer(i), true))));
      onDigit = answer;
    },

    tiles(task, put) { tilesView(task, put, false); },
    tilesType(task, put) { tilesView(task, put, true); },

    typedGap(task, put) {
      const s = task.sent, inp = textInput('the missing word, in characters');
      const go = () => {
        const v = normZh(inp.value); if (!v) return;
        const ok = v === task.word;
        if (!ok && byWord[v] && overlaps(byWord[v], byWord[task.word])) {       // another real word with a shared meaning: the app cannot call it wrong
          return finish(task, { verdict: 'unchecked', res: {}, answer: v,
            lines: [{ label: v, ok: null, note: 'has a meaning in common with this one, so it is not counted as wrong. The word wanted here was ' + task.word }] });
        }
        finish(task, { verdict: ok ? 'right' : 'wrong', res: ok ? { r: T(true), s: T(true) } : { r: T(false) }, answer: v });
      };
      idkNow = () => finish(task, { verdict: 'wrong', idk: true, res: { r: T(false) }, answer: '' });
      put(el('div', { class: 'prompt', text: 'Type the missing word.' }), el('div', { class: 'en', text: s.en }), sentView(s, { gap: task.word }),
        el('div', { class: 'muted small', text: 'Missing word: ' + (task.sense >= 0 ? byWord[task.word].items[task.sense] : byWord[task.word].short) }), inp, hintButton(task), el('button', { class: 'primary', text: 'Check', onclick: go }));
      onEnter = go; inp.focus();
    },

    meaningToWord(task, put) {
      const w = byWord[task.word], inp = textInput('the word, in characters');
      const go = () => {
        const v = normZh(inp.value); if (!v) return;
        const ok = v === w.w;
        if (!ok && byWord[v] && overlaps(byWord[v], byWord[w.w])) {       // another real word with a shared meaning: the app cannot call it wrong
          return finish(task, { verdict: 'unchecked', res: {}, answer: v,
            lines: [{ label: v, ok: null, note: 'has a meaning in common with this one, so it is not counted as wrong. The word wanted here was ' + w.w }] });
        }
        finish(task, { verdict: ok ? 'right' : 'wrong', res: ok ? { r: T(true), s: T(true) } : { r: T(false) }, answer: v });
      };
      idkNow = () => finish(task, { verdict: 'wrong', idk: true, res: { r: T(false) }, answer: '' });
      put(el('div', { class: 'prompt', text: 'Type the word.' }), el('div', { class: 'en', text: task.sense >= 0 ? w.items[task.sense] : w.def }),
        inp, hintButton(task), el('button', { class: 'primary', text: 'Check', onclick: go }));
      onEnter = go; inp.focus();
    },

    retype(task, put) {
      const s = task.sent;
      idkNow = () => finish(task, { verdict: 'wrong', idk: true, res: {}, sres: 'again', answer: '' });
      const phase2 = () => {
        const inp = textInput('type the sentence from memory');
        const go = () => {
          const v = normZh(inp.value); if (!v) return;
          const ok = v === normZh(s.zh);
          finish(task, { verdict: ok ? 'right' : 'wrong', res: ok ? { u: T(true) } : {}, sres: ok ? 'good' : 'again',      // a retyped sentence counts for the sentence, and for use when right
            answer: v, diff: !ok, why: ok ? '' : 'Not the sentence that was shown.' });
        };
        put(el('div', { class: 'prompt', text: 'Type the sentence you just read.' }), el('div', { class: 'en', text: s.en }),
          inp, nameTags(s, inp, task), el('button', { class: 'primary', text: 'Check', onclick: go }));
        onEnter = go; inp.focus();
      };
      const hide = () => {
        let n = 3; const c = el('div', { class: 'countdown', text: n });
        put(el('div', { class: 'en', text: s.en }), c);
        const tick = setInterval(() => { n--; if (n <= 0) { clearInterval(tick); if (c.isConnected) phase2(); } else c.textContent = n; }, 1000);
      };
      put(el('div', { class: 'prompt', text: 'Read this. It will be hidden, then you type it.' }),
        sentView(s, { highlight: task.word }), pinyinLine(s), el('div', { class: 'en', text: s.en }),
        el('button', { class: 'primary', text: 'Hide it', onclick: hide }));
      onEnter = hide;
    },

    typeBack(task, put) {
      const s = task.sent, inp = textInput('the Chinese sentence');
      const go = () => {
        const v = normZh(inp.value); if (!v) return;
        const ok = v === normZh(s.zh), has = usesWord(v, task);
        finish(task, { verdict: ok ? 'right' : 'unchecked', res: has ? { r: T(true), s: T(true) } : { r: T(false) }, sres: ok ? 'good' : null,
          answer: v, diff: !ok,
          lines: ok ? null : [
            { label: 'The word ' + task.word, ok: has, note: has ? 'it is in your answer, so it counts as recalled' : 'it is not in your answer, so it counts as not recalled' },
            { label: 'The sentence', ok: null, note: 'differs from the one you met. The app cannot tell whether yours is also correct, so it is saved for checking later' }] });
      };
      idkNow = () => finish(task, { verdict: 'wrong', idk: true, res: { r: T(false) }, sres: 'again', answer: '' });
      put(el('div', { class: 'prompt', text: 'You have met this sentence. Type it in Chinese.' }), el('div', { class: 'en', text: s.en }),
        inp, nameTags(s, inp, task), el('button', { class: 'primary', text: 'Check', onclick: go }));
      onEnter = go; inp.focus();
    },
  };

  function tilesView(task, put, typed) {
    const s = task.sent, toks = wordToks(s), inSent = new Set(toks.map(t => t.w));
    let id = 0, blankDone = false;
    const tiles = toks.map(t => {
      if (typed && t.w === task.word && !blankDone) { blankDone = true; return { id: id++, w: '', tok: t, blank: true }; }
      return { id: id++, w: t.w, tok: t };
    });
    const others = Object.values(S).filter(x => x.id !== s.id), pool = [];   // two tiles that do not belong
    for (let i = 0; i < 40 && pool.length < 2; i++) {
      const t = wordToks(others[rand(others.length)]), c = t[rand(t.length)];
      if (c.k === 'w' && !inSent.has(c.w) && !pool.some(p => p.w === c.w)) pool.push({ id: id++, w: c.w, tok: c });
    }
    let bank = shuffle(tiles.concat(pool)), row = [];
    const rowEl = el('div', { class: 'row' }), bankEl = el('div', { class: 'bank' });
    const inp = typed ? textInput('type the word for the ✎ tile') : null;
    const check = el('button', { class: 'primary', text: 'Check' });
    const move = (t, from) => { if (from === 'bank') { bank = bank.filter(x => x !== t); row.push(t); } else { row = row.filter(x => x !== t); bank.push(t); } draw(); };
    const tileEl = (t, from) => {
      const n = t.blank ? el('div', { class: 'tile blank', onclick: () => move(t, from) }) : wordEl('div', t.w, t.tok, { class: 'tile' + (t.tok.k === 'n' ? ' name' : '') }, () => move(t, from));
      n.append(el('span', { class: 'h', text: t.blank ? (normZh(inp.value) || '✎') : t.w }), el('span', { class: 'g', text: t.blank ? '' : t.tok.g }));
      return n;
    };
    function draw() {
      rowEl.replaceChildren(...row.map(t => tileEl(t, 'row')));
      bankEl.replaceChildren(...bank.map(t => tileEl(t, 'bank')));
      check.disabled = !row.length;
    }
    if (inp) inp.addEventListener('input', draw);
    const go = () => {
      if (!row.length) return;
      const typedWord = inp ? normZh(inp.value) : '';
      if (typed && !typedWord) { inp.focus(); return; }
      const ans = row.map(t => t.blank ? typedWord : t.w).join('');
      const ok = ans === normZh(s.zh);
      const orderOk = row.map(t => t.blank ? task.word : t.w).join('') === normZh(s.zh);
      // What can be decided: a tile that does not belong, or words left out, is wrong. The same words in another
      // order may be good Chinese, so that alone is "not checked".
      const used = row.map(t => t.id), stray = row.some(t => !tiles.includes(t)), short = tiles.some(t => !used.includes(t.id));
      const res = orderOk ? { u: T(true) } : (stray || short) ? { u: T(false) } : {};
      if (typed) { res.r = T(typedWord === task.word); if (typedWord === task.word) res.s = T(true); }
      const wordWrong = typed && typedWord !== task.word;
      finish(task, { verdict: ok ? 'right' : (wordWrong || stray || short) ? 'wrong' : 'unchecked', res, sres: ok ? (typed ? 'good' : 'hard') : 'again', answer: ans, diff: !ok, tiles: true,
        shown: bank.concat(row).map(t => t.blank ? '?' : t.w), picked: row.map(t => t.blank ? typedWord : t.w), typed: typed ? typedWord : undefined,
        lines: typed ? [
          { label: 'Missing word', ok: typedWord === task.word, note: typedWord === task.word ? typedWord : 'you typed “' + typedWord + '”, it is ' + task.word },
          { label: 'Order', ok: orderOk ? true : (stray || short) ? false : null, note: orderOk ? '' : stray ? 'a word that does not belong was used' : short ? 'not all the words were used' : 'not the order of the source sentence; yours may still be right' }] : null,
        why: ok || typed ? '' : stray ? 'A word that does not belong was used.' : short ? 'Not all the words were used.' : 'Not the order of the source sentence. The app cannot tell whether yours is also right, so nothing is counted against you.' });
    };
    idkNow = () => finish(task, { verdict: 'wrong', idk: true, res: typed ? { r: T(false) } : {}, sres: 'again', answer: '', tiles: true });
    check.addEventListener('click', go);
    const tog = el('input', { type: 'checkbox' }); tog.checked = st.glosses;
    tog.addEventListener('change', () => { st.glosses = tog.checked; document.body.classList.toggle('noglosses', !st.glosses); save(); });
    put(el('div', { class: 'prompt', text: typed ? 'Build the sentence. One word is missing: type it.' : 'Build the sentence.' }),
      el('div', { class: 'en', text: s.en }), rowEl, bankEl, inp, typed ? hintButton(task) : null, check, el('label', { class: 'toggle' }, tog, 'English on the tiles'));
    draw(); onEnter = go;
  }

  // is the word in what was typed as itself, and not only inside a longer word of the sentence (以 inside 可以)?
  function usesWord(v, task) {
    let t = v;
    if (task.sent) wordToks(task.sent).forEach(k => { if (k.w !== task.word && k.w.includes(task.word)) t = t.split(k.w).join(' '); });
    return t.includes(task.word);
  }

  // ---------- after an answer ----------
  function finish(task, out) {
    if (task.done) return;
    task.done = true;
    const w = task.word, before = rec(w), res = out.res || {};
    if (res.r && res.r.ok && !res.m) res.m = T(true, 'implied');     // producing a word implies recognising it
    st.counter++;
    st.retry = st.retry.filter(x => x.w !== w);
    const stageBefore = before.stage;
    const pred = {};          // the chance the app gave each part just before this answer
    Object.keys(res).forEach(p => { pred[p] = before.parts[p] ? +retr(before.parts[p], new Date()).toFixed(3) : null; });
    log({ k: 'ans', w, type: task.type, part: task.part, reason: task.reason, sid: task.sent ? task.sent.id : null, sense: task.sense,
      verdict: out.verdict, res, sres: out.sres || null, ans: out.answer, shown: out.shown, picked: out.picked, typed: out.typed,
      ms: Date.now() - task.started, idk: !!out.idk, hint: !!task.hint, tapped: task.tapped,
      prior: !before.intro && stageBefore === 'none' && !task.hint,       // "knew it already" only counts without the hint
      pred, p: TASK[task.type] && !task.check ? +pRight(w, task.type, new Date()).toFixed(3) : null });
    // A miss of the word itself (not pinyin, not tile order): it is left alone for a while, and comes back once.
    // Missed twice in a sitting, it is put aside until later. A pinyin check changes none of this.
    st.sinceRead = task.type === 'read' ? 0 : (st.sinceRead || 0) + 1;
    st.asks = st.asks || {};
    Object.keys(st.asks).forEach(x => { if (Date.now() - st.asks[x].t > SITTING) delete st.asks[x]; });
    st.asks[w] = { n: (st.asks[w] ? st.asks[w].n : 0) + 1, t: st.asks[w] ? st.asks[w].t : Date.now() };
    st.cool = st.cool || {};
    Object.keys(st.cool).forEach(x => { if (Date.now() - st.cool[x].t > SITTING) delete st.cool[x]; });
    const missedWord = !task.check && (out.idk || Object.keys(res).some(p => !['u', 's', 't'].includes(p) && !res[p].ok));
    if (missedWord) {
      const c = st.cool[w] || { fails: 0 };
      c.fails++; c.t = Date.now(); c.until = st.counter + 8; st.cool[w] = c;
    } else if (out.verdict === 'right') delete st.cool[w];
    if (missedWord && st.cool[w].fails < 2 && K.w[w].stage !== 'wait') st.retry.push({ w, at: st.counter + 8 + rand(4) });
    if (task.slow && !st.retry.some(x => x.w === w) && K.w[w].stage !== 'wait') st.retry.push({ w, at: st.counter + 4 });      // "slower": this word comes round again soon
    st.recent.unshift({ w, type: task.type }); st.recent.length = Math.min(st.recent.length, 5);
    save();
    hist.push({ task, out }); if (hist.length > 30) hist.shift();
    viewing = -1;
    showResult(task, out);
  }

  function showResult(task, out) {
    const w = task.word, s = task.sent;
    // a question that tests more than one part shows each part's result on its own line
    const lines = out.idk ? null : out.lines;
    const mixed = out.verdict === 'wrong' && lines && lines.some(l => l.ok) && lines.some(l => l.ok === false);
    const cls = mixed ? 'partial' : out.verdict;
    const label = out.idk ? 'Here it is' : { right: 'Right', wrong: 'Wrong', partial: 'Partly right', unchecked: 'Not checked' }[cls];
    const parts = [el('div', { class: 'verdict ' + cls }, label, out.why ? el('span', { class: 'why', text: out.why }) : null,
      lines ? lines.map(l => el('div', { class: 'vline ' + (l.ok === null ? 'unk' : l.ok ? 'ok' : 'bad') },
        el('b', { text: (l.ok === null ? '? ' : l.ok ? '✓ ' : '✗ ') + l.label }), l.note ? ' — ' + l.note : '')) : null)];
    if (out.diff && s) {
      const [ya, yb] = diff(out.answer, normZh(s.zh));
      parts.push(el('div', { class: 'muted small', text: 'You typed' }), ya, el('div', { class: 'muted small', text: 'The sentence' }), yb);
    }
    if (s) parts.push(sentView(s, { highlight: w }), pinyinLine(s), el('div', { class: 'en', text: s.en }), ...phraseLines(s));
    else {       // a question about the word alone still shows it in use
      const want = task.sense >= 0 ? sentsOf(w).filter(x => x[1] === task.sense) : [];
      want.concat(sentsOf(w).filter(x => !want.includes(x))).slice(0, 2).forEach(x => {
        parts.push(sentView(S[x[0]], { highlight: w }), pinyinLine(S[x[0]]), el('div', { class: 'en', text: S[x[0]].en }), ...phraseLines(S[x[0]]));
      });
    }
    const missed = out.idk || Object.keys(out.res || {}).some(p => p !== 'u' && !out.res[p].ok);
    parts.push(...wordCard(w, missed ? 'missed' : out.verdict === 'right' ? 'right' : null).filter(Boolean));
    if (s) parts.push(el('div', { class: 'src', text: 'Sentence: Tatoeba #' + s.id + ', by ' + s.by + ' (CC BY 2.0 FR).' }));
    // feedback is one quiet link; it opens the flags and the note
    const flagRow = el('div', { class: 'flags' });
    const names = (s ? ['bad sentence'] : []).concat(['dull', 'liked this'], out.tiles && out.verdict === 'unchecked' ? ['my order may also be right'] : []);
    names.forEach(f => {
      const b = el('button', { text: f, onclick: () => {
        const on = b.classList.toggle('on');
        log({ k: 'flag', w, flag: f, on, sid: s ? s.id : null, type: task.type, ans: out.answer });
      } });
      flagRow.append(b);
    });
    const note = el('input', { type: 'text', placeholder: 'note (optional)' });
    note.addEventListener('change', () => { if (note.value.trim()) log({ k: 'note', w, note: note.value.trim(), sid: s ? s.id : null, type: task.type }); });
    const more = el('div', { class: 'feedback', hidden: '' }, flagRow, el('div', { class: 'note' }, note));
    const link = el('button', { class: 'hint fb', text: 'Feedback', onclick: () => { more.hidden = !more.hidden; } });
    parts.push(el('button', { class: 'primary', text: 'Next', onclick: goForward }), link, more);
    screen(viewing >= 0 && viewing < hist.length - 1 ? 'looking back' : '', parts);
    onEnter = goForward;
  }

  // ---------- back: look again at earlier results of this sitting, then return to where you were ----------
  const hist = [];
  let viewing = -1;        // which earlier result is on screen; -1 = the live screen
  let resume = null;       // the unanswered question to come back to
  const backTop = () => hist.length - 1 - (current && current.done ? 1 : 0);      // on a live result, "back" means the one before it
  function goBack() {
    const i = viewing < 0 ? backTop() : viewing - 1;
    if (i < 0) return;
    if (viewing < 0) resume = current && !current.done ? current : null;
    viewing = i;
    showResult(hist[i].task, hist[i].out);
  }
  function goForward() {
    if (viewing >= 0 && viewing < hist.length - 1) { viewing++; return showResult(hist[viewing].task, hist[viewing].out); }
    const t = viewing >= 0 ? resume : null;
    viewing = -1; resume = null;
    if (t) return showTask(t);
    advance();
  }
  $('backBtn').addEventListener('click', goBack);

  function advance() {
    $('wordmenu').hidden = true;
    idkNow = () => {};
    const it = nextItem();
    save();
    idle = null;
    if (it.done) { current = null; idle = 'done'; return screen('', el('p', { text: 'Nothing left to do right now.' })); }
    if (it.sort) return showSort(it.sort);
    if (it.intro) return showIntro(it.intro);
    if (it.start) { log({ k: 'start', w: it.start }); return advance(); }
    showTask(makeTask(it));
  }

  // ---------- menu ----------
  function exportData() {
    const now = new Date(), picture = {};
    Object.keys(K.w).forEach(w => {
      const r = K.w[w], o = { status: status(w), mark: r.mark, want: r.want, parts: {}, uses: r.senses };
      Object.keys(r.parts).forEach(p => { o.parts[PARTS[p]] = { chance: +retr(r.parts[p], now).toFixed(3), how: r.parts[p].src, right: r.parts[p].right, wrong: r.parts[p].wrong }; });
      picture[w] = o;
    });
    const blob = new Blob([JSON.stringify({ exported: now.toISOString(), device: st.dev, devices, picture, events }, null, 1)], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: 'hanyu-' + today() + '.json' });
    document.body.append(a); a.click(); a.remove();
  }
  function openMenu() {
    const c = {}; targets.forEach(x => { const s = status(x.w); c[s] = (c[s] || 0) + 1; });
    const below = words.filter(x => x.lv < D.level && K.w[x.w] && ['wait', 'learning'].includes(status(x.w))).length;
    const n = k => c[k] || 0;
    const unsorted = order.filter(x => status(x.w) === 'untouched' && !K.sorted[x.w]).map(x => x.w);
    const panel = el('div', { class: 'panel' },
      el('button', { class: 'plain', text: 'Close', onclick: () => { $('menu').hidden = true; } }),
      el('h3', { text: 'What the app thinks, level ' + D.level + ' (' + targets.length + ' words)' }),
      el('div', { class: 'small counts' },
        [['marked trivially easy', n('easy')], ['known (typed right on two days)', n('known')], ['typed right today, to be asked again another day', n('resting')], ['in play', n('learning')], ['waiting to be taught', n('wait')],
          ['not looked at yet', n('untouched')], ['not shown', n('drop')]].map(x => el('div', { text: x[1] + '  ' + x[0] })),
        below ? el('div', { text: below + '  lower-level words you marked or missed' }) : null,
        el('div', { class: 'muted', text: events.filter(e => e.k === 'ans').length + ' answers recorded' })),
      canSync() ? el('div', { class: 'small muted syncline', text: st.sync.err ? 'Sync is not working: ' + st.sync.err + '. It will try again by itself.'
        : st.sync.last ? 'Synced ' + new Date(st.sync.last).toLocaleString() + ' · ' + (st.sync.devices || 1) + (st.sync.devices > 1 ? ' devices' : ' device')
        : 'Not synced yet' }) : el('div', { class: 'small muted syncline', text: 'This copy does not sync (opened from the folder).' }),
      canSync() ? el('button', { class: 'plain', text: 'Sync now', onclick: () => { sync().then(openMenu); } }) : null,
      el('h3', { text: 'Devices' }),
      el('div', { class: 'small devices' }, [...new Set(events.map(e => e.dev || e.id.split('-')[0]))].map(d => el('div', {
        text: deviceLabel(d) + (d === st.dev ? ', this one' : '') + ': ' + events.filter(e => e.k === 'ans' && (e.dev || e.id.split('-')[0]) === d).length + ' answers' }))),
      el('button', { class: 'plain', text: 'Words in play: ' + (n('learning') + n('wait') + below) + ' to look through',
        onclick: () => { $('menu').hidden = true; showWords(); } }),
      unsorted.length ? el('button', { class: 'plain', text: 'Sort another ' + Math.min(SORT_BATCH, unsorted.length) + ' words now',
        onclick: () => { $('menu').hidden = true; showSort(unsorted.slice(0, SORT_BATCH)); } }) : null,
      el('h3', { text: 'Data' }),
      el('button', { class: 'plain', text: 'Export everything recorded', onclick: exportData }),
      (window.HANYU && !window.HANYU.local) ? el('button', { class: 'plain', text: 'Forget the token on this device', onclick: () => {
        if (confirm('Remove the token and the downloaded words from this device? Your progress stays.')) window.HANYU.forget();
      } }) : null,
      el('button', { class: 'plain', text: 'Reset all progress', onclick: () => {
        if (confirm('Start again from nothing, on every device? (The record of what you did is kept, but no longer counts.)')) {
          log({ k: 'reset' });
          Object.assign(st, { counter: 0, retry: [], recent: [], turn: 0 }); save();
          applyImports(); $('menu').hidden = true; advance();
        }
      } }),
      el('h3', { text: 'Where the content comes from' }),
      el('div', { class: 'small muted', text: 'Words, pinyin and definitions: official 2012 HSK lists as published at hskhsk.com (levels 1 to ' + D.level + '). Sentences: ' +
        D.stats.sentences + ' from Tatoeba, written by self-declared native Mandarin speakers and limited to these words (CC BY 2.0 FR). ' +
        'The English on tiles and under words is picked automatically and can be the wrong sense.' }));
    $('menu').replaceChildren(panel);
    $('menu').hidden = false;
  }
  $('menuBtn').addEventListener('click', openMenu);
  $('menu').addEventListener('click', e => { if (e.target === $('menu')) $('menu').hidden = true; });

  document.body.classList.toggle('noglosses', !st.glosses);
  let idle = null;      // 'sort' | 'done' while a screen is up that newly arrived events could make stale
  onMerged = () => { if (idle === 'done' || (idle === 'sort' && !sortTouched)) advance(); };
  function describeDevice() {
    const ua = navigator.userAgent;
    const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows'
      : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'unknown system';
    const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'browser';
    const kind = /iPhone|Mobile/.test(ua) ? 'phone' : /iPad|Android/.test(ua) ? 'tablet' : 'computer';
    return { os, browser, kind, screen: screen.width + 'x' + screen.height, touch: navigator.maxTouchPoints > 0,
      installed: matchMedia('(display-mode: standalone)').matches, ua };
  }
  const deviceLabel = d => (devices[d] ? devices[d].os + ' ' + devices[d].kind + ' · ' + devices[d].browser : 'a device that has not described itself yet') + ' (' + d + ')';
  async function init() {
    await loadEvents();
    rebuild();
    const fresh = !events.length;
    const info = describeDevice(), sig = [info.os, info.browser, info.kind, info.screen, info.installed].join('|');
    if (st.devSig !== sig) { log({ k: 'device', info }); st.devSig = sig; save(); }       // said once per device, and again if it changes
    if (canSync() && fresh) {       // a new device: fetch the history before showing anything
      screen('', el('p', { class: 'muted', text: 'Getting your history…' }));
      await Promise.race([sync(), new Promise(r => setTimeout(r, 8000))]);
    } else if (canSync()) setTimeout(sync, 1500);
    applyImports();
    advance();
  }
  window.__app = { state: () => st, picture: () => K, status, rebuild, advance, sync, events: () => events,
    ping: () => log({ k: 'ping' }).id,      // for testing: an event that changes nothing
    pace, devices: () => devices,
    // for testing: put one particular question on screen
    show: o => { current = { word: o.word, type: o.type, part: TASK[o.type].part, reason: null, extra: false, check: false, sent: S[o.sid], sense: -1, started: Date.now(), done: false }; showTask(current); },
    current: () => current && { word: current.word, type: current.type, part: current.part, reason: current.reason, sid: current.sent ? current.sent.id : null, done: current.done },
    // for testing: move everything recorded n days into the past
    shiftDays: async n => { events.forEach(e => { e.t = new Date(new Date(e.t) - n * 86400000).toISOString(); }); await dbPut(events); st.retry = []; st.recent = []; save(); } };
  window.__app.ready = init().then(() => { window.__app.started = true; });
})();
