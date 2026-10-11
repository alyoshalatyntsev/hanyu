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

  // ---------- what is saved: the list of events, plus a little about where the stream is ----------
  let st = load();
  function load() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(KEY)); } catch (e) { /* start fresh */ }
    return Object.assign({ events: [], counter: 0, retry: [], recent: [], turn: 0, glosses: false }, s || {});
  }
  function save() { localStorage.setItem(KEY, JSON.stringify(st)); }

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
  function apply(ev) {
    const time = new Date(ev.t);
    if (ev.k === 'sorted') { ev.ws.forEach(w => { K.sorted[w] = true; }); return; }
    if (ev.k === 'flag') { if (ev.flag === 'bad sentence' && ev.sid) { if (ev.on) K.retired[ev.sid] = true; else delete K.retired[ev.sid]; } return; }
    if (!ev.w) return;
    const r = rec(ev.w);
    if (ev.k === 'mark') {
      if (ev.id) K.imported[ev.id] = true;
      if (ev.v === 'easy') {
        r.mark = 'easy'; r.stage = 'none'; r.diag = null;
        ['m', 's', 'r', 'u'].forEach(p => { r.parts[p] = prior(365, time); });
        r.parts.t = prior(90, time);       // tones are the part people are least aware of not knowing: checked sooner
      } else if (ev.v === 'unknown') {
        r.mark = 'unknown'; r.parts = {}; r.stage = 'wait'; r.knows = false; r.intro = 0; r.diag = null;
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
    if (ev.k === 'intro' || ev.k === 'start') { r.stage = 'active'; r.act = +time; if (ev.k === 'intro') r.intro = +time; return; }
    if (ev.k !== 'ans') return;
    const res = ev.res || {};
    Object.keys(res).forEach(p => {
      const o = res[p];
      let part = r.parts[p];
      if (o.how === 'implied' && part && (part.src === 'said' || part.right + part.wrong > 0)) return;
      if (!part) part = r.parts[p] = { card: F.createEmptyCard(time), right: 0, wrong: 0, src: null };
      const first = part.right + part.wrong === 0 && part.src !== 'said';
      const rating = !o.ok ? F.Rating.Again : (o.how === 'choice' || o.how === 'implied') ? F.Rating.Hard
        : (first && ev.prior) ? F.Rating.Easy : F.Rating.Good;
      part.card = fsrs.next(part.card, time, rating).card;
      if (o.ok) part.right++; else part.wrong++;
      part.src = o.how === 'implied' ? 'implied' : 'tested';
    });
    const bad = p => res[p] && !res[p].ok;
    if (r.mark === 'easy' && (bad('m') || bad('r'))) r.mark = null;
    if (r.mark === 'unknown' && res.m && res.m.ok) r.mark = null;
    if (ev.reason === 'follow') { r.knows = !!(res.m && res.m.ok); r.stage = 'wait'; r.diag = 'done'; r.intro = 0; }
    else if (ev.reason === 'findout') r.diag = bad('r') ? 'recallFailed' : 'known';
    else if (r.stage === 'none' && bad('r')) r.diag = 'recallFailed';
    else if (ev.idk && bad('m')) { r.stage = 'wait'; r.knows = false; r.intro = 0; }   // "I don't know" what it means: teach it again
    if (ev.sid) {
      const sr = K.sent[ev.sid] || (K.sent[ev.sid] = { card: F.createEmptyCard(time), right: 0, wrong: 0, seen: 0 });
      sr.seen++;
      if (ev.sres) {
        sr.card = fsrs.next(sr.card, time, { good: F.Rating.Good, hard: F.Rating.Hard, again: F.Rating.Again }[ev.sres]).card;
        if (ev.sres === 'again') sr.wrong++; else sr.right++;
      }
      r.lastSent = ev.sid;
      if (ev.sense >= 0) {
        const u = r.senses[ev.sense] || (r.senses[ev.sense] = { right: 0, wrong: 0 });
        if (ev.verdict === 'right') u.right++; else if (ev.verdict === 'wrong') u.wrong++;
      }
    }
    if (ev.part) r.cyc[ev.part] = (r.cyc[ev.part] || 0) + 1;     // how many times each kind of step has been done, to rotate tasks
  }
  function rebuild() {
    K = { w: {}, sent: {}, retired: {}, sorted: {}, imported: {} };
    st.events.forEach(apply);
  }
  function log(ev) { ev.t = new Date().toISOString(); st.events.push(ev); apply(ev); save(); return ev; }
  rebuild();
  (D.marks || []).forEach(m => { const id = m.v + ':' + m.w; if (!K.imported[id]) log({ k: 'mark', w: m.w, v: m.v, src: 'import', id }); });

  // ---------- reading the picture ----------
  function retr(part, now) {
    if (!part) return null;
    if (part.card.state === 0) return 0;
    const v = fsrs.get_retrievability(part.card, now, false);
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
    if (r && r.stage === 'active') return consolidated(r) ? 'known' : 'learning';
    if (r && r.diag === 'known') return 'known';
    if (r && r.diag === 'recallFailed') return 'checking';
    return word && word.lv === D.level ? 'untouched' : 'assumed';
  }
  function openPart(w) {   // the next step for a word being learned
    const r = K.w[w], p = r.parts, has = sentsOf(w).length > 0;
    if (!(p.m && p.m.right > 0)) return 'm';
    if (has && !(p.u && p.u.right > 0)) return 'u';
    if (!(p.r && p.r.right > 0)) return 'r';
    if (has && !r.cyc.x) return 'x';          // then once at the level of the whole sentence
    if (!tested(p.t)) return 't';
    return null;
  }

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
    if (opt.seenOnly) c = c.filter(x => K.sent[x[0]] && K.sent[x[0]].seen);
    if (opt.needHit) c = c.filter(x => x[1] >= 0);
    const r = K.w[w];
    if (c.length > 1 && r) c = c.filter(x => x[0] !== r.lastSent);
    if (!c.length) return null;
    const score = x => ((r && r.senses[x[1]] ? r.senses[x[1]].right : 0) * 10) + (K.sent[x[0]] ? K.sent[x[0]].seen : 0);
    const best = Math.min(...c.map(score));
    c = c.filter(x => score(x) === best);
    return c[rand(c.length)];
  }
  function distractorWords(w, n, avoid) {
    const me = byWord[w];
    let pool = targets.filter(x => x.w !== w && !avoid.has(x.w) && x.pos === me.pos);
    if (pool.length < n * 3) pool = targets.filter(x => x.w !== w && !avoid.has(x.w));
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

  // ---------- what comes next ----------
  function nextItem() {
    const now = new Date(), recentW = st.recent.slice(0, 2).map(x => x.w), last = recentW[0];
    const live = w => byWord[w] && !(K.w[w] && (K.w[w].drop || K.w[w].stage === 'wait'));
    st.retry = st.retry.filter(x => live(x.w));
    const item = x => ({ w: x.w, part: x.part, reason: x.reason, type: x.type });
    // 1. wrong a few questions ago, or a follow-up check
    const ready = st.retry.filter(x => st.counter >= x.at);
    const r1 = ready.find(x => x.w !== last);
    if (r1) return item(r1);
    const pending = new Set(st.retry.map(x => x.w));
    // 2. a part that is slipping, most likely still remembered first
    const due = [];
    Object.keys(K.w).forEach(w => {
      const r = K.w[w];
      if (!live(w) || pending.has(w)) return;
      Object.keys(r.parts).forEach(p => { const v = retr(r.parts[p], now); if (v < TARGET_R && (tested(r.parts[p]) || r.parts[p].src === 'said')) due.push({ w, part: p, v }); });
    });
    due.sort((a, b) => b.v - a.v);
    const d = due.find(x => x.w !== last) || due[0];
    if (d) return { w: d.w, part: d.part };
    // 3. the next step of a word being learned
    const active = Object.keys(K.w).filter(w => live(w) && K.w[w].stage === 'active' && !pending.has(w) && openPart(w))
      .sort((a, b) => K.w[a].act - K.w[b].act);
    const a3 = active.find(w => !recentW.includes(w));
    if (a3) return { w: a3, part: openPart(a3) };
    // 4. find out and teach, about two to one
    const want = w => (K.w[w] ? K.w[w].want : 0);
    const waitQ = Object.keys(K.w).filter(w => K.w[w].stage === 'wait' && !K.w[w].drop && byWord[w])
      .sort((a, b) => (want(b) - want(a)) || (rankOf(a) - rankOf(b)));
    const findQ = order.filter(x => status(x.w) === 'untouched' && !pending.has(x.w)).map(x => x.w)
      .sort((a, b) => (want(b) - want(a)) || (rankOf(a) - rankOf(b)));
    const young = Object.keys(K.w).filter(w => K.w[w].stage === 'active' && !K.w[w].drop && !consolidated(K.w[w])).length;
    const canTeach = waitQ.length > 0 && young < YOUNG_CAP, canFind = findQ.length > 0;
    const teach = w => (K.w[w].knows ? { start: w } : { intro: w });
    const toneOpen = Object.keys(K.w).find(w => live(w) && K.w[w].diag === 'known' && !K.w[w].parts.t && !recentW.includes(w) && !pending.has(w));
    // words whose recall has been shown: material for whole-sentence practice (retype, type back, typed tiles)
    const pool = Object.keys(K.w).filter(w => live(w) && !recentW.includes(w) && !pending.has(w) && K.w[w].mark !== 'easy' &&
      K.w[w].parts.r && K.w[w].parts.r.right > 0 && sentsOf(w).length)
      .map(w => ({ w, v: retr(K.w[w].parts.r, now) })).sort((a, b) => a.v - b.v).slice(0, 3);
    if (due.length < DUE_THRESHOLD) {
      if (canFind && !K.sorted[findQ[0]]) return { sort: findQ.filter(w => !K.sorted[w]).slice(0, SORT_BATCH) };
      st.turn++;
      if (canTeach && (!canFind || st.turn % 3 === 0)) return teach(waitQ[0]);
      if (canFind) {
        if (pool.length && st.turn % 4 === 3) return { w: pool[rand(pool.length)].w, part: 'x' };
        if (toneOpen && st.turn % 5 === 4) return { w: toneOpen, part: 't' };
        return { w: findQ[0], reason: 'findout' };
      }
    }
    if (active.length) return { w: active[0], part: openPart(active[0]) };
    if (ready.length) return item(ready[0]);
    if (st.retry.length) return item(st.retry.find(y => y.w !== last) || st.retry[0]);
    // 5. nothing waiting: extra practice
    if (toneOpen && rand(3) === 0) return { w: toneOpen, part: 't', extra: true };
    if (pool.length) return { w: pool[rand(pool.length)].w, part: 'x', extra: true };
    if (toneOpen) return { w: toneOpen, part: 't', extra: true };
    if (waitQ.length) return teach(waitQ[0]);
    const easyTone = shuffle(Object.keys(K.w).filter(w => live(w) && K.w[w].mark === 'easy' && byWord[w].lv === D.level && !recentW.includes(w)))[0];
    if (easyTone) return { w: easyTone, part: 't', extra: true };
    return { done: true };
  }

  function typeFor(it) {
    const w = it.w, r = K.w[w] || { parts: {}, cyc: {} }, has = sentsOf(w).length > 0, hit = !!pickSent(w, { needHit: true });
    if (it.type) return it.type;
    if (it.reason === 'findout') return hit ? 'typedGap' : 'meaningToWord';
    if (it.reason === 'follow') return 'read';
    if (it.part === 't') return 'tones';
    const seen = has && !!pickSent(w, { seenOnly: true });
    const recall = [has && 'tilesType', hit && 'typedGap', seen && 'typeBack', 'meaningToWord'].filter(Boolean);
    const got = p => r.parts[p] && r.parts[p].right > 0;
    let cyc;
    if (it.part === 'm') cyc = (got('m') && hit) ? ['gap', 'read'] : ['read'];
    else if (it.part === 's') cyc = got('r') ? recall : ['read'];
    else if (it.part === 'u') cyc = has ? (got('r') ? ['tilesType', 'retype', 'tiles'] : ['tiles']) : recall;
    else if (it.part === 'r') cyc = recall;
    else cyc = [has && 'retype', seen && 'typeBack', has && 'tilesType', hit && 'typedGap', 'meaningToWord'].filter(Boolean);
    const n = r.cyc[it.part || 'x'] || 0;
    let t = cyc[n % cyc.length];
    if (cyc.length > 1 && st.recent.length > 1 && st.recent[0].type === t && st.recent[1].type === t) t = cyc[(n + 1) % cyc.length];
    return t;
  }
  function makeTask(it) {
    const type = typeFor(it), w = it.w;
    const needsSent = !['read', 'tones', 'meaningToWord'].includes(type);
    const pick = needsSent ? pickSent(w, { seenOnly: type === 'typeBack', needHit: type === 'gap' || type === 'typedGap' }) : null;
    return { word: w, type, part: it.part || null, reason: it.reason || null, extra: !!it.extra,
      sent: pick ? S[pick[0]] : null, sense: pick ? pick[1] : -1, started: Date.now(), done: false };
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
    log({ k: 'mark', w, v, src: src || 'click' });
    const label = { easy: 'trivially easy', unknown: "don't know", want: 'want to learn', unwant: 'no longer marked want to learn',
      drop: 'will not be shown', undrop: 'will be shown again', clear: 'mark removed' }[v];
    toast(w + ': ' + label + (byWord[w] ? '' : ' (not in the word lists, so it is only noted)'),
      ['easy', 'unknown'].includes(v) ? () => { log({ k: 'mark', w, v: was === 'easy' || was === 'unknown' ? was : 'clear', src: 'undo' }); } : null);
    if (during && (v === 'easy' || v === 'drop')) advance();
  }
  function infoOf(w, tok) {
    if (tok && tok.p) return { p: tok.p, g: tok.g };
    return byWord[w] ? { p: readings(w), g: byWord[w].short } : { p: '', g: '' };
  }
  function showInfo(w, tok) {
    const i = infoOf(w, tok);
    log({ k: 'look', w, during: !!(current && !current.done) });
    toast(el('span', null, el('b', { class: 'zh', text: w }), '  ' + i.p + (i.g ? ' — ' + i.g : '')));
  }
  function wordMenu(w, tok, x, y, hideInfo) {
    const m = $('wordmenu'), r = K.w[w] || {}, i = infoOf(w, tok);
    const item = (text, v) => el('button', { text, onclick: () => { m.hidden = true; mark(w, v); } });
    m.replaceChildren(
      el('div', { class: 'head' }, el('b', { class: 'zh', text: w }), hideInfo ? '' : '  ' + i.p + (i.g ? ' — ' + i.g : '')),
      item("Don't know this word", 'unknown'), item('Trivially easy', 'easy'),
      r.want ? item('Remove “want to learn”', 'unwant') : item('Want to learn', 'want'),
      r.drop ? item('Show this word again', 'undrop') : item("Don't show this word", 'drop'),
      (r.mark ? item('Remove my mark (' + (r.mark === 'easy' ? 'trivially easy' : "don't know") + ')', 'clear') : ''));
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
      else if (!hideInfo) showInfo(w, tok);
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
    main.replaceChildren(...kids.flat().filter(Boolean));
    window.scrollTo(0, 0);
  }
  function textInput(placeholder, latin) {
    const i = el('input', { type: 'text', placeholder: placeholder || '', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
    if (latin) i.style.fontFamily = 'inherit'; else i.setAttribute('lang', 'zh-CN');
    return i;
  }
  function sentView(s, opt) {
    opt = opt || {};
    const line = el('div', { class: 'sent' });
    let gapDone = false;
    s.t.forEach(t => {
      if (t.k === 'p') { line.append(t.w); return; }
      if (opt.gap && t.w === opt.gap && !gapDone) { gapDone = true; line.append(el('span', { class: 'gap', text: '　' })); return; }
      line.append(wordEl('span', t.w, t, { class: 'tok' + (t.w === opt.highlight ? ' target' : ''), text: t.w }));
    });
    return line;
  }
  const pinyinLine = s => el('div', { class: 'pinyin small', text: s.t.map(t => t.k === 'p' ? '' : t.p.replace(/ \/ /g, '/')).filter(Boolean).join('  ') });
  const bigWord = (w, hide) => wordEl('div', w, null, { class: 'big', text: w }, null, hide);
  const idkButton = () => el('button', { class: 'idk', title: "I don't know", onclick: () => idkNow() }, '✗', el('span', { text: " I don't know" }));

  function showSort(batch) {
    current = null;
    const state = {};   // word -> 'easy' | 'unknown'
    const chips = batch.map(w => {
      const c = el('button', { class: 'chip zh', text: w });
      const set = v => { if (v) state[w] = v; else delete state[w]; c.className = 'chip zh' + (v ? ' ' + v : ''); };
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

  function wordCard(w, withMarks) {
    const word = byWord[w], r = K.w[w] || { parts: {} }, now = new Date();
    const chip = p => {
      const part = r.parts[p], v = retr(part, now);
      const cls = !part ? 'none' : part.src === 'said' ? 'said' : v >= TARGET_R ? 'good' : part.right === 0 ? 'bad' : 'slip';
      const how = !part ? 'not tested' : part.src === 'said' ? 'you said' : part.src === 'implied' ? 'implied' : part.right + ' right, ' + part.wrong + ' wrong';
      return el('span', { class: 'part ' + cls, title: how, text: PARTS[p] });
    };
    const mk = (text, v, on) => el('button', { class: on ? 'on' : '', text, onclick: e => {
      mark(w, on ? (v === 'want' ? 'unwant' : 'clear') : v); e.target.classList.toggle('on');
    } });
    return el('div', { class: 'wordcard' },
      wordEl('span', w, null, { class: 'h', text: w }), el('span', { class: 'pinyin', text: readings(w) }),
      el('div', { class: 'def', text: word.def }),
      el('div', { class: 'parts' }, Object.keys(PARTS).map(chip)),
      withMarks ? el('div', { class: 'flags' }, mk("don't know", 'unknown', r.mark === 'unknown'), mk('trivially easy', 'easy', r.mark === 'easy'),
        mk('want to learn', 'want', !!r.want)) : null);
  }

  function showIntro(w) {
    current = null;
    const word = byWord[w], sents = sentsOf(w).slice(0, 2).map(x => S[x[0]]);
    const go = () => {
      log({ k: 'intro', w }); st.counter++;
      st.retry.push({ w, part: 'm', at: st.counter + 2 });
      st.recent.unshift({ w, type: 'intro' }); st.recent.length = Math.min(st.recent.length, 5);
      save(); advance();
    };
    screen('new word',
      el('div', { class: 'prompt', text: 'A new word. Read it; you will be asked about it in a moment.' }),
      bigWord(w), el('div', { class: 'center pinyin', text: readings(w) }), el('div', { class: 'center def', text: word.def }),
      sents.map(s => el('div', null, sentView(s, { highlight: w }), el('div', { class: 'muted', text: s.en }))),
      el('button', { class: 'primary', text: 'Next', onclick: go }),
      el('button', { class: 'plain wide', text: 'Trivially easy: I know this', onclick: () => { mark(w, 'easy'); advance(); } }));
    onEnter = go;
  }

  function showTask(task) {
    current = task;
    VIEWS[task.type](task, (...kids) => screen(task.extra ? 'caught up · extra practice' : '', ...kids, idkButton()));
  }
  const T = (ok, how) => ({ ok, how: how || 'typed' });

  const VIEWS = {
    read(task, put) {
      const w = byWord[task.word];
      const opts = shuffle([w].concat(distractorWords(w.w, 3, new Set())));
      const inp = textInput('pinyin with tone numbers, e.g. ni3hao3', true);
      const answer = i => {
        const typed = inp.value.trim();
        if (!typed) { inp.focus(); inp.placeholder = 'type the pinyin first (or press ✗)'; return; }
        const syl = w.n.some(n => letters(n) === letters(typed));
        const tone = w.n.some(n => normPin(n) === normPin(typed)) || w.p.some(p => normPin(p) === normPin(typed));
        const mean = opts[i].w === w.w;
        const res = { s: T(syl), m: T(mean, 'choice') };
        if (syl) res.t = T(tone);
        finish(task, { verdict: syl && tone && mean ? 'right' : 'wrong', res, answer: typed + ' | ' + opts[i].short,
          why: [syl ? (tone ? '' : 'Tones: you typed “' + typed + '”, it is ' + w.n.join(' or ') + '.') : 'Pinyin: you typed “' + typed + '”, it is ' + w.n.join(' or ') + '.',
            mean ? '' : 'Meaning: you chose “' + opts[i].short + '”.'].filter(Boolean).join(' ') });
      };
      idkNow = () => finish(task, { verdict: 'wrong', idk: true, res: { m: T(false, 'choice'), s: T(false), t: T(false) }, answer: '' });
      put(el('div', { class: 'prompt', text: 'How is it said, and what does it mean?' }), bigWord(w.w, true), inp,
        el('div', { class: 'choices' }, opts.map((o, i) => el('button', { class: 'choice', text: o.short, onclick: () => answer(i) }))));
      inp.focus();
    },

    tones(task, put) {
      const w = byWord[task.word], inp = textInput('tone numbers, e.g. 34 (5 for neutral)', true);
      const bare = w.n[0].replace(/[0-5]/g, ' ').trim();
      const go = () => {
        const v = toneDigits(inp.value); if (!v) return;
        const ok = w.n.some(n => toneDigits(n) === v);
        finish(task, { verdict: ok ? 'right' : 'wrong', res: { t: T(ok) }, answer: v, why: ok ? '' : 'You typed ' + v + '. It is ' + w.n.join(' or ') + '.' });
      };
      idkNow = () => finish(task, { verdict: 'wrong', idk: true, res: { t: T(false) }, answer: '' });
      put(el('div', { class: 'prompt', text: 'Which tones? One number for each syllable.' }), bigWord(w.w, true),
        el('div', { class: 'center pinyin', text: bare }), inp, el('button', { class: 'primary', text: 'Check', onclick: go }));
      onEnter = go; inp.focus();
    },

    gap(task, put) {
      const s = task.sent, inSent = new Set(wordToks(s).map(t => t.w));
      const opts = shuffle([byWord[task.word]].concat(distractorWords(task.word, 3, inSent)));
      const answer = i => finish(task, { verdict: opts[i].w === task.word ? 'right' : 'wrong', res: { m: T(opts[i].w === task.word, 'choice') }, answer: opts[i].w });
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
        finish(task, { verdict: ok ? 'right' : 'wrong', res: ok ? { r: T(true), s: T(true) } : { r: T(false) }, answer: v });
      };
      idkNow = () => finish(task, { verdict: 'wrong', idk: true, res: { r: T(false) }, answer: '' });
      put(el('div', { class: 'prompt', text: 'Type the missing word.' }), el('div', { class: 'en', text: s.en }), sentView(s, { gap: task.word }),
        el('div', { class: 'muted small hint', text: 'Missing word: ' + byWord[task.word].short }), inp, el('button', { class: 'primary', text: 'Check', onclick: go }));
      onEnter = go; inp.focus();
    },

    meaningToWord(task, put) {
      const w = byWord[task.word], inp = textInput('the word, in characters');
      const hint = w.n[0][0] + '…, ' + w.w.length + (w.w.length === 1 ? ' character' : ' characters');
      const go = () => {
        const v = normZh(inp.value); if (!v) return;
        const ok = v === w.w;
        finish(task, { verdict: ok ? 'right' : 'wrong', res: ok ? { r: T(true), s: T(true) } : { r: T(false) }, answer: v });
      };
      idkNow = () => finish(task, { verdict: 'wrong', idk: true, res: { r: T(false) }, answer: '' });
      put(el('div', { class: 'prompt', text: 'Type the word.' }), el('div', { class: 'en', text: w.def }),
        el('div', { class: 'muted small', text: 'Starts with ' + hint }), inp, el('button', { class: 'primary', text: 'Check', onclick: go }));
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
          finish(task, { verdict: ok ? 'right' : 'wrong', res: v.includes(task.word) ? { s: T(true, 'choice') } : {}, sres: ok ? 'good' : 'again',
            answer: v, diff: !ok, why: ok ? '' : 'Not the sentence that was shown.' });
        };
        put(el('div', { class: 'prompt', text: 'Type the sentence you just read.' }), el('div', { class: 'en', text: s.en }),
          inp, el('button', { class: 'primary', text: 'Check', onclick: go }));
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
        const ok = v === normZh(s.zh), has = v.includes(task.word);
        finish(task, { verdict: ok ? 'right' : 'unchecked', res: has ? { r: T(true), s: T(true) } : { r: T(false) }, sres: ok ? 'good' : null,
          answer: v, diff: !ok,
          why: ok ? '' : 'It differs from the sentence you met. The app cannot tell whether yours is also correct, so it is saved for checking later. ' +
            (has ? 'You used ' + task.word + ', so the word counts as recalled.' : task.word + ' is not in your answer, so the word counts as not recalled.') });
      };
      idkNow = () => finish(task, { verdict: 'wrong', idk: true, res: { r: T(false) }, sres: 'again', answer: '' });
      put(el('div', { class: 'prompt', text: 'You have met this sentence. Type it in Chinese.' }), el('div', { class: 'en', text: s.en }),
        inp, el('button', { class: 'primary', text: 'Check', onclick: go }));
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
      const n = t.blank ? el('div', { class: 'tile blank', onclick: () => move(t, from) }) : wordEl('div', t.w, t.tok, { class: 'tile' }, () => move(t, from));
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
      const res = { u: T(orderOk) };
      if (typed) { res.r = T(typedWord === task.word); if (typedWord === task.word) res.s = T(true); }
      finish(task, { verdict: ok ? 'right' : 'wrong', res, sres: ok ? (typed ? 'good' : 'hard') : 'again', answer: ans, diff: !ok, tiles: true,
        why: ok ? '' : (typed && typedWord !== task.word ? 'The missing word was ' + task.word + '. ' : '') + (orderOk ? '' : 'Not the order of the source sentence.') });
    };
    idkNow = () => finish(task, { verdict: 'wrong', idk: true, res: typed ? { r: T(false), u: T(false) } : { u: T(false) }, sres: 'again', answer: '', tiles: true });
    check.addEventListener('click', go);
    const tog = el('input', { type: 'checkbox' }); tog.checked = st.glosses;
    tog.addEventListener('change', () => { st.glosses = tog.checked; document.body.classList.toggle('noglosses', !st.glosses); save(); });
    put(el('div', { class: 'prompt', text: typed ? 'Build the sentence. One word is missing: type it.' : 'Build the sentence.' }),
      el('div', { class: 'en', text: s.en }), rowEl, bankEl, inp, check, el('label', { class: 'toggle' }, tog, 'English on the tiles'));
    draw(); onEnter = go;
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
    log({ k: 'ans', w, type: task.type, part: task.part, reason: task.reason, sid: task.sent ? task.sent.id : null, sense: task.sense,
      verdict: out.verdict, res, sres: out.sres || null, ans: out.answer, ms: Date.now() - task.started, idk: !!out.idk,
      prior: !before.intro && stageBefore === 'none' });
    const failed = Object.keys(res).find(p => !res[p].ok);
    if (K.w[w].stage !== 'wait' && task.reason !== 'follow') {
      // could not produce a word that is not being taught: check later whether it is at least recognised
      if (res.r && !res.r.ok && stageBefore === 'none') st.retry.push({ w, type: 'read', reason: 'follow', at: st.counter + 8 });
      else if (failed || out.verdict === 'wrong') st.retry.push({ w, part: failed || task.part || 'u', at: st.counter + 3 + rand(3) });
    }
    st.recent.unshift({ w, type: task.type }); st.recent.length = Math.min(st.recent.length, 5);
    save();
    showResult(task, out);
  }

  function showResult(task, out) {
    const w = task.word, s = task.sent;
    const label = { right: 'Right', wrong: out.idk ? 'Here it is' : 'Wrong', unchecked: 'Not checked' }[out.verdict];
    const parts = [el('div', { class: 'verdict ' + out.verdict }, label, out.why ? el('span', { class: 'why', text: out.why }) : null)];
    if (out.diff && s) {
      const [ya, yb] = diff(out.answer, normZh(s.zh));
      parts.push(el('div', { class: 'muted small', text: 'You typed' }), ya, el('div', { class: 'muted small', text: 'The sentence' }), yb);
    }
    if (s) parts.push(sentView(s, { highlight: w }), pinyinLine(s), el('div', { class: 'en', text: s.en }));
    parts.push(wordCard(w, true));
    if (s) parts.push(el('div', { class: 'src', text: 'Sentence: Tatoeba #' + s.id + ', by ' + s.by + ' (CC BY 2.0 FR).' }));
    parts.push(el('div', { class: 'src', text: 'Any word: click for pinyin and meaning · shift-click: don\'t know · ctrl-click: trivially easy · right-click or long-press: more.' }));
    const flagRow = el('div', { class: 'flags' });
    const names = (s ? ['bad sentence'] : []).concat(['dull', 'liked this'], out.tiles && out.verdict === 'wrong' && !out.idk ? ['my order may also be right'] : []);
    names.forEach(f => {
      const b = el('button', { text: f, onclick: () => {
        const on = b.classList.toggle('on');
        log({ k: 'flag', w, flag: f, on, sid: s ? s.id : null, type: task.type, ans: out.answer });
      } });
      flagRow.append(b);
    });
    const note = el('input', { type: 'text', placeholder: 'note (optional)' });
    note.addEventListener('change', () => { if (note.value.trim()) log({ k: 'note', w, note: note.value.trim(), sid: s ? s.id : null, type: task.type }); });
    parts.push(flagRow, el('div', { class: 'note' }, note), el('button', { class: 'primary', text: 'Next', onclick: advance }));
    screen('', parts);
    onEnter = advance;
  }

  function advance() {
    $('wordmenu').hidden = true;
    idkNow = () => {};
    const it = nextItem();
    save();
    if (it.done) { current = null; return screen('', el('p', { text: 'Nothing left to do right now.' })); }
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
    const blob = new Blob([JSON.stringify({ exported: now.toISOString(), picture, events: st.events }, null, 1)], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: 'hanyu-' + today() + '.json' });
    document.body.append(a); a.click(); a.remove();
  }
  function openMenu() {
    const c = {}; targets.forEach(x => { const s = status(x.w); c[s] = (c[s] || 0) + 1; });
    const below = words.filter(x => x.lv < D.level && K.w[x.w] && ['wait', 'learning', 'checking'].includes(status(x.w))).length;
    const n = k => c[k] || 0;
    const unsorted = order.filter(x => status(x.w) === 'untouched' && !K.sorted[x.w]).map(x => x.w);
    const panel = el('div', { class: 'panel' },
      el('button', { class: 'plain', text: 'Close', onclick: () => { $('menu').hidden = true; } }),
      el('h3', { text: 'What the app thinks, level ' + D.level + ' (' + targets.length + ' words)' }),
      el('div', { class: 'small counts' },
        [['marked trivially easy', n('easy')], ['known (tested)', n('known')], ['being learned', n('learning')], ['waiting to be taught', n('wait')],
          ['being checked', n('checking')], ['not looked at yet', n('untouched')], ['not shown', n('drop')]].map(x => el('div', { text: x[1] + '  ' + x[0] })),
        below ? el('div', { text: below + '  lower-level words you marked or missed' }) : null,
        el('div', { class: 'muted', text: st.events.filter(e => e.k === 'ans').length + ' answers recorded' })),
      unsorted.length ? el('button', { class: 'plain', text: 'Sort another ' + Math.min(SORT_BATCH, unsorted.length) + ' words now',
        onclick: () => { $('menu').hidden = true; showSort(unsorted.slice(0, SORT_BATCH)); } }) : null,
      el('h3', { text: 'Data' }),
      el('button', { class: 'plain', text: 'Export everything recorded', onclick: exportData }),
      (window.HANYU && !window.HANYU.local) ? el('button', { class: 'plain', text: 'Forget the token on this device', onclick: () => {
        if (confirm('Remove the token and the downloaded words from this device? Your progress stays.')) window.HANYU.forget();
      } }) : null,
      el('button', { class: 'plain', text: 'Reset all progress', onclick: () => {
        if (confirm('Delete everything recorded on this device?')) { localStorage.removeItem(KEY); st = load(); rebuild(); $('menu').hidden = true; advance(); }
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
  window.__app = { state: () => st, picture: () => K, status, rebuild, advance,
    current: () => current && { word: current.word, type: current.type, part: current.part, reason: current.reason, sid: current.sent ? current.sent.id : null, done: current.done } };   // for testing
  advance();
})();
