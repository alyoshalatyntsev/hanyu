(function () {
  'use strict';
  const D = window.DATA, F = window.FSRS;
  const TARGET_R = 0.85;      // aim to remember about 85% at the moment of review
  const DUE_THRESHOLD = 15;   // new words only while fewer than this many items are below target
  const YOUNG_CAP = 12;       // ...and fewer than this many words are still waiting to unlock Produce
  const KEY = 'zh-practice-v1';
  const fsrs = F.fsrs(F.generatorParameters({ request_retention: TARGET_R, enable_fuzz: false, enable_short_term: false }));

  const words = D.words, S = D.sentences, byWord = {};
  words.forEach(w => { byWord[w.w] = w; });
  // words that have sentences come first; within each group the list's own (frequency) order is kept
  const order = words.filter(w => w.s.length).concat(words.filter(w => !w.s.length));

  const TYPES = {
    read: 'Read the word', gap: 'Gap with choices', tiles: 'Tiles', tilesType: 'Tiles, one word typed',
    typedGap: 'Typed gap', meaningToWord: 'Meaning to word', retype: 'Read, hide, retype', typeBack: 'Type back a sentence you have met',
  };
  const FLAGS = ['bad sentence', 'too easy', 'too hard', 'dull', "don't want this word", 'liked this'];

  // ---------- state ----------
  let st = load();
  function load() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(KEY)); } catch (e) { /* start fresh */ }
    s = Object.assign({ cards: {}, intro: {}, suspended: {}, retired: {}, seen: {}, lastSent: {}, log: [], unchecked: [],
      counter: 0, retry: [], recent: [], glosses: true }, s || {});
    Object.values(s.cards).forEach(r => {
      r.card.due = new Date(r.card.due);
      if (r.card.last_review) r.card.last_review = new Date(r.card.last_review);
    });
    return s;
  }
  function save() { localStorage.setItem(KEY, JSON.stringify(st)); }

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
  function today() { const d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
  const wordOf = key => key.slice(0, -2);
  const dirOf = key => key.slice(-1);
  const normZh = s => s.replace(/[\s，。！？、；：“”‘’（）《》〈〉…—·,.!?;:"'()\[\]~～\-]/g, '');
  const normPin = s => s.toLowerCase().replace(/u:|ü/g, 'v').replace(/[\s'’·\-]/g, '').replace(/[05]/g, '');
  const wordToks = s => s.t.filter(t => t.k !== 'p');
  const sentsFor = w => byWord[w].s.filter(id => !st.retired[id]).map(id => S[id]);

  // needHit: only sentences whose English visibly contains the word's meaning, so a gap can be answered from it
  function pickSent(w, seenOnly, needHit) {
    let c = sentsFor(w);
    if (seenOnly) c = c.filter(s => st.seen[s.id]);
    if (needHit) c = c.filter(s => byWord[w].h.includes(s.id));
    if (c.length > 1) c = c.filter(s => s.id !== st.lastSent[w]);
    if (!c.length) return null;
    const least = Math.min(...c.map(s => st.seen[s.id] || 0));
    c = c.filter(s => (st.seen[s.id] || 0) === least);
    return c[rand(c.length)];
  }

  function distractorWords(w, n, avoid) {
    const me = byWord[w];
    let pool = words.filter(x => x.w !== w && !avoid.has(x.w) && x.pos === me.pos);
    if (pool.length < n * 3) pool = words.filter(x => x.w !== w && !avoid.has(x.w));
    const same = pool.filter(x => x.w.length === w.length);
    if (same.length >= n * 3) pool = same;
    return shuffle(pool).slice(0, n);
  }

  // character-level difference between what was typed and the listed sentence
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

  // ---------- scheduling ----------
  function retrievability(key, now) {
    const c = st.cards[key].card;
    if (c.state === 0) return 0;
    const r = fsrs.get_retrievability(c, now, false);
    return typeof r === 'number' ? r : 0;
  }
  function newCard(key) { st.cards[key] = { card: F.createEmptyCard(new Date()), right: 0, wrong: 0, days: [], cyc: 0 }; }

  function nextItem() {
    const now = new Date(), last = st.recent[0] && st.recent[0].word;
    const live = k => !st.suspended[wordOf(k)];
    st.retry = st.retry.filter(r => st.cards[r.key] && live(r.key));
    // 1. something answered wrong a few questions ago
    const ready = st.retry.filter(r => st.counter >= r.at);
    const r1 = ready.find(r => wordOf(r.key) !== last);
    if (r1) return { key: r1.key };
    const pending = new Set(st.retry.map(r => r.key));
    const scored = Object.keys(st.cards).filter(k => live(k) && !pending.has(k)).map(k => ({ k, r: retrievability(k, now) }));
    // 2. below target, most likely still remembered first
    const due = scored.filter(x => x.r < TARGET_R).sort((a, b) => b.r - a.r);
    const d = due.find(x => wordOf(x.k) !== last) || due[0];
    if (d) return { key: d.k };
    // 3. a new word, while little is slipping and few words are still young
    const young = Object.keys(st.intro).filter(w => !st.suspended[w] && !st.cards[w + '|p']).length;
    const fresh = order.find(w => !st.intro[w.w] && !st.suspended[w.w]);
    if (fresh && due.length < DUE_THRESHOLD && young < YOUNG_CAP) return { intro: fresh.w };
    if (ready.length) return { key: ready[0].key };
    if (st.retry.length) { const r = st.retry.find(x => wordOf(x.key) !== last) || st.retry[0]; return { key: r.key }; }
    // 4. nothing is slipping: extra practice, longest-unpractised first
    const extra = scored.filter(x => wordOf(x.k) !== last).sort((a, b) => a.r - b.r).slice(0, 3);
    if (extra.length) return { key: extra[rand(extra.length)].k, extra: true };
    if (fresh) return { intro: fresh.w };
    if (scored.length) return { key: scored[0].k, extra: true };
    return { done: true };
  }

  function typeFor(key) {
    const w = wordOf(key), rec = st.cards[key], has = sentsFor(w).length > 0;
    let cyc;
    if (dirOf(key) === 'r') {
      if (!rec.right || !has) return 'read';
      cyc = ['gap', 'tiles', 'read'];
    } else if (!has) return 'meaningToWord';
    else if (rec.right < 2) cyc = ['tilesType', 'typedGap'];
    else if (rec.right < 4) cyc = ['typedGap', 'retype', 'meaningToWord'];
    else cyc = ['typeBack', 'typedGap', 'meaningToWord', 'retype'];
    let t = cyc[rec.cyc % cyc.length];
    if (st.recent.length > 1 && st.recent[0].type === t && st.recent[1].type === t) t = cyc[(rec.cyc + 1) % cyc.length];
    if (t === 'typeBack' && !pickSent(w, true)) t = 'retype';
    if (t === 'gap' && !pickSent(w, false, true)) t = 'tiles';
    if (t === 'typedGap' && !pickSent(w, false, true)) t = 'tilesType';
    return t;
  }

  function makeTask(key, type, preview) {
    const w = wordOf(key);
    const needsSent = type !== 'read' && type !== 'meaningToWord';
    const sent = needsSent ? pickSent(w, type === 'typeBack' && !preview, type === 'gap' || type === 'typedGap') : null;
    return { key, word: w, type, sent, preview: !!preview, started: Date.now() };
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
  function textInput(placeholder) {
    return el('input', { type: 'text', placeholder: placeholder || '', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', lang: 'zh-CN' });
  }
  const readings = w => byWord[w].p.join(' / ');

  function sentView(s, opt) {
    opt = opt || {};
    const info = el('div', { class: 'tokinfo' });
    const line = el('div', { class: 'sent' });
    let gapDone = false;
    s.t.forEach(t => {
      if (t.k === 'p') { line.append(t.w); return; }
      if (opt.gap && t.w === opt.gap && !gapDone) { gapDone = true; line.append(el('span', { class: 'gap', text: opt.fill || '　' })); return; }
      const sp = el('span', { class: 'tok' + (t.w === opt.highlight ? ' target' : ''), text: t.w, onclick: () => {
        line.querySelectorAll('.sel').forEach(x => x.classList.remove('sel'));
        sp.classList.add('sel');
        info.replaceChildren(el('b', { text: t.w }), '  ' + t.p + (t.g ? ' — ' + t.g : ''));
      } });
      line.append(sp);
    });
    return el('div', null, line, opt.noInfo ? null : info);
  }
  const pinyinLine = s => el('div', { class: 'pinyin small', text: s.t.map(t => t.k === 'p' ? '' : t.p.replace(/ \/ /g, '/')).filter(Boolean).join('  ') });

  function showIntro(w) {
    const word = byWord[w], sents = sentsFor(w).slice(0, 2);
    const go = () => {
      st.intro[w] = Date.now(); newCard(w + '|r'); st.counter++;
      st.retry.push({ key: w + '|r', at: st.counter + 2 });
      st.recent.unshift({ word: w, type: 'intro' }); st.recent.length = Math.min(st.recent.length, 5);
      save(); advance();
    };
    screen('new word',
      el('div', { class: 'big', text: w }),
      el('div', { class: 'center pinyin', text: readings(w) }),
      el('div', { class: 'center def', text: word.def }),
      sents.map(s => el('div', null, sentView(s, { highlight: w }), el('div', { class: 'muted', text: s.en }))),
      el('button', { class: 'primary', text: 'Next', onclick: go }));
    onEnter = go;
  }

  function showTask(task, extra) {
    const head = task.preview ? el('div', { class: 'preview', text: 'Trying out: ' + TYPES[task.type] + ' (not recorded)' }) : null;
    const status = task.preview ? '' : (extra ? 'caught up · extra practice' : '');
    VIEWS[task.type](task, (...kids) => screen(status, head, ...kids));
  }

  const VIEWS = {
    read(task, put) {
      const w = byWord[task.word];
      const opts = shuffle([w].concat(distractorWords(w.w, 3, new Set())));
      const inp = textInput('pinyin with tone numbers, e.g. ni3hao3');
      inp.style.fontFamily = 'inherit';
      const answer = i => {
        const typed = inp.value.trim();
        if (!typed) { inp.focus(); inp.placeholder = 'type the pinyin first'; return; }
        const pinOk = w.n.some(n => normPin(n) === normPin(typed)) || w.p.some(p => normPin(p) === normPin(typed));
        const meanOk = opts[i].w === w.w;
        finish(task, {
          verdict: pinOk && meanOk ? 'right' : 'wrong', wordOk: pinOk && meanOk, answer: typed + ' | ' + opts[i].short,
          why: pinOk && meanOk ? '' : [pinOk ? '' : 'Pinyin: you typed “' + typed + '”, it is ' + w.n.join(' or ') + '.',
            meanOk ? '' : 'Meaning: you chose “' + opts[i].short + '”.'].filter(Boolean).join(' '),
        });
      };
      put(el('div', { class: 'prompt', text: 'How is it said, and what does it mean?' }),
        el('div', { class: 'big', text: w.w }), inp,
        el('div', { class: 'choices' }, opts.map((o, i) => el('button', { class: 'choice', text: o.short, onclick: () => answer(i) }))));
      inp.focus();
    },

    gap(task, put) {
      const s = task.sent, inSent = new Set(wordToks(s).map(t => t.w));
      const opts = shuffle([byWord[task.word]].concat(distractorWords(task.word, 3, inSent)));
      const answer = i => finish(task, { verdict: opts[i].w === task.word ? 'right' : 'wrong', wordOk: opts[i].w === task.word, answer: opts[i].w });
      put(el('div', { class: 'prompt', text: 'Which word goes in the gap?' }), el('div', { class: 'en', text: s.en }),
        sentView(s, { gap: task.word }),
        el('div', { class: 'choices two' }, opts.map((o, i) => el('button', { class: 'choice zh', text: o.w, onclick: () => answer(i) }))));
      onDigit = answer;
    },

    tiles(task, put) { tilesView(task, put, false); },
    tilesType(task, put) { tilesView(task, put, true); },

    typedGap(task, put) {
      const s = task.sent, inp = textInput('the missing word, in characters');
      const go = () => { const v = normZh(inp.value); if (!v) return; finish(task, { verdict: v === task.word ? 'right' : 'wrong', wordOk: v === task.word, answer: v }); };
      put(el('div', { class: 'prompt', text: 'Type the missing word.' }), el('div', { class: 'en', text: s.en }),
        sentView(s, { gap: task.word }), el('div', { class: 'muted small', text: 'Missing word: ' + byWord[task.word].short }),
        inp, el('button', { class: 'primary', text: 'Check', onclick: go }));
      onEnter = go; inp.focus();
    },

    meaningToWord(task, put) {
      const w = byWord[task.word], inp = textInput('the word, in characters');
      const hint = w.n[0][0] + '…, ' + w.w.length + (w.w.length === 1 ? ' character' : ' characters');
      const go = () => { const v = normZh(inp.value); if (!v) return; finish(task, { verdict: v === w.w ? 'right' : 'wrong', wordOk: v === w.w, answer: v }); };
      put(el('div', { class: 'prompt', text: 'Type the word.' }), el('div', { class: 'en', text: w.def }),
        el('div', { class: 'muted small', text: 'Starts with ' + hint }), inp, el('button', { class: 'primary', text: 'Check', onclick: go }));
      onEnter = go; inp.focus();
    },

    retype(task, put) {
      const s = task.sent;
      const phase2 = () => {
        const inp = textInput('type the sentence from memory');
        const go = () => {
          const v = normZh(inp.value); if (!v) return;
          const ok = v === normZh(s.zh);
          finish(task, { verdict: ok ? 'right' : 'wrong', wordOk: v.includes(task.word), answer: v, diff: !ok,
            why: ok ? '' : 'Not the sentence that was shown.' });
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
        finish(task, { verdict: ok ? 'right' : 'unchecked', wordOk: has, answer: v, diff: !ok,
          why: ok ? '' : 'It differs from the sentence you met. The app cannot tell whether yours is also correct, so it is saved for checking later. ' +
            (has ? 'You used ' + task.word + ', so the word counts as recalled.' : task.word + ' is not in your answer, so the word counts as not recalled.') });
      };
      put(el('div', { class: 'prompt', text: 'You have met this sentence. Type it in Chinese.' }), el('div', { class: 'en', text: s.en }),
        inp, el('button', { class: 'primary', text: 'Check', onclick: go }));
      onEnter = go; inp.focus();
    },
  };

  function tilesView(task, put, typed) {
    const s = task.sent, toks = wordToks(s), inSent = new Set(toks.map(t => t.w));
    let id = 0, blankDone = false;
    const tiles = toks.map(t => {
      if (typed && t.w === task.word && !blankDone) { blankDone = true; return { id: id++, w: '', g: t.g, blank: true }; }
      return { id: id++, w: t.w, g: t.g };
    });
    // two extra tiles from another sentence, so the bank is not exactly the answer
    const others = Object.values(S).filter(x => x.id !== s.id);
    const pool = [];
    for (let i = 0; i < 40 && pool.length < 2; i++) {
      const t = wordToks(others[rand(others.length)]);
      const c = t[rand(t.length)];
      if (c.k === 'w' && !inSent.has(c.w) && !pool.some(p => p.w === c.w)) pool.push({ id: id++, w: c.w, g: c.g });
    }
    let bank = shuffle(tiles.concat(pool)), row = [];
    const rowEl = el('div', { class: 'row' }), bankEl = el('div', { class: 'bank' });
    const inp = typed ? textInput('type the word for the ✎ tile') : null;
    const check = el('button', { class: 'primary', text: 'Check' });
    const tileEl = (t, from) => el('div', { class: 'tile' + (t.blank ? ' blank' : ''), onclick: () => {
      if (from === 'bank') { bank = bank.filter(x => x !== t); row.push(t); } else { row = row.filter(x => x !== t); bank.push(t); }
      draw();
    } }, el('span', { class: 'h', text: t.blank ? (normZh(inp.value) || '✎') : t.w }), el('span', { class: 'g', text: t.g }));
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
      const wordOk = typed ? typedWord === task.word : (ok ? true : null);
      finish(task, { verdict: ok ? 'right' : 'wrong', wordOk, answer: ans, diff: !ok, tiles: true,
        why: ok ? '' : (typed && typedWord !== task.word ? 'The missing word was ' + task.word + '. ' : '') +
          (orderOk ? '' : 'Not the order of the source sentence.') });
    };
    check.addEventListener('click', go);
    const tog = el('input', { type: 'checkbox' }); tog.checked = st.glosses;
    tog.addEventListener('change', () => { st.glosses = tog.checked; document.body.classList.toggle('noglosses', !st.glosses); save(); });
    put(el('div', { class: 'prompt', text: typed ? 'Build the sentence. One word is missing: type it.' : 'Build the sentence.' }),
      el('div', { class: 'en', text: s.en }), rowEl, bankEl, inp, check, el('label', { class: 'toggle' }, tog, 'English on the tiles'));
    draw(); onEnter = go;
  }

  // ---------- after an answer ----------
  function finish(task, res) {
    const w = task.word, rec = st.cards[task.key], now = new Date();
    if (!task.preview) {
      st.counter++;
      st.retry = st.retry.filter(r => r.key !== task.key);
      if (res.wordOk === true) {
        rec.card = fsrs.next(rec.card, now, F.Rating.Good).card; rec.right++;
        if (!rec.days.includes(today())) rec.days.push(today());
        if (dirOf(task.key) === 'r' && rec.days.length >= 2 && !st.cards[w + '|p']) newCard(w + '|p');
      } else {
        if (res.wordOk === false) { rec.card = fsrs.next(rec.card, now, F.Rating.Again).card; rec.wrong++; }
        st.retry.push({ key: task.key, at: st.counter + 3 + rand(3) });
      }
      rec.cyc++;
      if (task.sent) { st.seen[task.sent.id] = (st.seen[task.sent.id] || 0) + 1; st.lastSent[w] = task.sent.id; }
      st.log.push({ t: now.toISOString(), key: task.key, type: task.type, sid: task.sent ? task.sent.id : null,
        verdict: res.verdict, wordOk: res.wordOk, ans: res.answer, ms: Date.now() - task.started });
      if (res.verdict === 'unchecked') st.unchecked.push({ t: now.toISOString(), sid: task.sent.id, type: task.type, ans: res.answer });
      st.recent.unshift({ word: w, type: task.type }); st.recent.length = Math.min(st.recent.length, 5);
      save();
    }
    showResult(task, res);
  }

  function showResult(task, res) {
    const w = byWord[task.word], s = task.sent;
    const label = { right: 'Right', wrong: 'Wrong', unchecked: 'Not checked' }[res.verdict];
    const parts = [el('div', { class: 'verdict ' + res.verdict }, label, res.why ? el('span', { class: 'why', text: res.why }) : null)];
    if (res.diff && s) {
      const [ya, yb] = diff(res.answer, normZh(s.zh));
      parts.push(el('div', { class: 'muted small', text: 'You typed' }), ya, el('div', { class: 'muted small', text: 'The sentence' }), yb);
    }
    if (s) parts.push(sentView(s, { highlight: task.word }), pinyinLine(s), el('div', { class: 'en', text: s.en }));
    parts.push(el('div', { class: 'wordcard' }, el('span', { class: 'h', text: w.w }), el('span', { class: 'pinyin', text: readings(w.w) }),
      el('div', { class: 'def', text: w.def })));
    if (s) parts.push(el('div', { class: 'src', text: 'Sentence: Tatoeba #' + s.id + ', by ' + s.by + ' (CC BY 2.0 FR). Tap a word for its pinyin and meaning.' }));

    const flagRow = el('div', { class: 'flags' });
    const names = FLAGS.filter(f => s || f !== 'bad sentence').concat(res.tiles && res.verdict === 'wrong' ? ['my order may also be right'] : []);
    names.forEach(f => {
      const b = el('button', { text: f, onclick: () => {
        const on = b.classList.toggle('on');
        st.log.push({ t: new Date().toISOString(), flag: f, on, word: w.w, sid: s ? s.id : null, type: task.type });
        if (f === 'bad sentence') { if (on) st.retired[s.id] = true; else delete st.retired[s.id]; }
        if (f === "don't want this word") { if (on) st.suspended[w.w] = true; else delete st.suspended[w.w]; }
        if (f === 'my order may also be right' && on) st.unchecked.push({ t: new Date().toISOString(), sid: s.id, type: task.type, ans: res.answer });
        save();
      } });
      flagRow.append(b);
    });
    const note = el('input', { type: 'text', placeholder: 'note (optional)' });
    note.addEventListener('change', () => { if (note.value.trim()) { st.log.push({ t: new Date().toISOString(), note: note.value.trim(), word: w.w, sid: s ? s.id : null, type: task.type }); save(); } });
    parts.push(flagRow, el('div', { class: 'note' }, note));
    const next = el('button', { class: 'primary', text: 'Next', onclick: advance });
    parts.push(next);
    screen(task.preview ? 'trying out · not recorded' : '', parts);
    onEnter = advance;
  }

  function advance() {
    const it = nextItem();
    if (it.done) return screen('', el('p', { text: 'No words available.' }));
    if (it.intro) return showIntro(it.intro);
    showTask(makeTask(it.key, typeFor(it.key), false), it.extra);
  }

  // ---------- menu ----------
  function preview(type) {
    $('menu').hidden = true;
    const pool = order.slice(0, 200).filter(w => w.s.length >= 2 && w.h.length);
    const w = pool[rand(pool.length)].w;
    if (type === 'intro') {
      const word = byWord[w], sents = sentsFor(w).slice(0, 2);
      screen('trying out · not recorded', el('div', { class: 'big', text: w }), el('div', { class: 'center pinyin', text: readings(w) }),
        el('div', { class: 'center def', text: word.def }),
        sents.map(s => el('div', null, sentView(s, { highlight: w }), el('div', { class: 'muted', text: s.en }))),
        el('button', { class: 'primary', text: 'Back to practice', onclick: advance }));
      onEnter = advance;
      return;
    }
    showTask(makeTask(w + (['read', 'gap', 'tiles'].includes(type) ? '|r' : '|p'), type, true));
  }
  function exportData() {
    const blob = new Blob([JSON.stringify({ exported: new Date().toISOString(), log: st.log, unchecked: st.unchecked,
      retired: st.retired, suspended: st.suspended, cards: st.cards }, null, 1)], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: 'chinese-practice-' + today() + '.json' });
    document.body.append(a); a.click(); a.remove();
  }
  function openMenu() {
    const met = Object.keys(st.intro).length, answers = st.log.filter(l => l.verdict).length;
    const panel = el('div', { class: 'panel' },
      el('button', { class: 'plain', text: 'Close', onclick: () => { $('menu').hidden = true; } }),
      el('h3', { text: 'Try a task type (not recorded)' }),
      el('div', { class: 'list' }, [['intro', 'New word card']].concat(Object.entries(TYPES)).map(([k, v]) =>
        el('button', { class: 'plain', text: v, onclick: () => preview(k) }))),
      el('h3', { text: 'So far' }),
      el('div', { class: 'small', text: met + ' of ' + words.length + ' words met · ' + answers + ' answers · ' + st.unchecked.length + ' saved for checking' }),
      el('h3', { text: 'Data' }),
      el('button', { class: 'plain', text: 'Export my answers and flags', onclick: exportData }),
      el('button', { class: 'plain', text: 'Reset all progress', onclick: () => {
        if (confirm('Delete all progress on this device?')) { localStorage.removeItem(KEY); st = load(); $('menu').hidden = true; advance(); }
      } }),
      (window.HANYU && !window.HANYU.local) ? el('button', { class: 'plain', text: 'Forget the token on this device', onclick: () => {
        if (confirm('Remove the token and the downloaded words from this device? Your progress stays.')) window.HANYU.forget();
      } }) : null,
      el('h3', { text: 'Where the content comes from' }),
      el('div', { class: 'small muted', text: 'Words, pinyin and definitions: official 2012 HSK lists as published at hskhsk.com. ' + words.length +
        ' level-4 words. Sentences: ' + D.stats.sentences + ' sentences from Tatoeba written by self-declared native Mandarin speakers, ' +
        'limited to HSK 1–4 vocabulary (CC BY 2.0 FR). ' + D.stats.withSentence + ' words have at least one sentence. ' +
        'Tile glosses are picked automatically from the lists and CC-CEDICT and can be the wrong sense.' }));
    $('menu').replaceChildren(panel);
    $('menu').hidden = false;
  }
  $('menuBtn').addEventListener('click', openMenu);
  $('menu').addEventListener('click', e => { if (e.target === $('menu')) $('menu').hidden = true; });

  document.body.classList.toggle('noglosses', !st.glosses);
  window.__app = { state: () => st, nextItem, typeFor, preview, advance };   // for testing
  advance();
})();
