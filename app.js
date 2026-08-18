/* ============================================================
   NoteSlap — study-by-typing
   Everything runs client-side. Optional local Ollama for splitting.
   ============================================================ */
'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const store = {
  get(k, fallback) { try { return JSON.parse(localStorage.getItem('noteslap.' + k)) ?? fallback; } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem('noteslap.' + k, JSON.stringify(v)); } catch { /* private mode */ } }
};

const state = {
  rawText: '',
  deck: [],
  abort: null,
  webllmEngine: null,
  webllmModel: null
};

/* ============================================================
   1. TEXT NORMALISATION
   Curly quotes and em dashes are effectively untypeable on a
   standard keyboard, so everything gets flattened to ASCII.
   ============================================================ */

function normalise(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[\u00A0\u2007\u202F]/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/([a-z])-\n([a-z])/g, '$1$2')      // de-hyphenate across line breaks
    .replace(/https?:\/\/\S+/g, '')             // URLs are miserable to type
    .replace(/\[\d{1,3}(,\s*\d{1,3})*\]/g, '')  // citation markers [12]
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
}

/* ============================================================
   2. FILE EXTRACTION
   ============================================================ */

async function extractPdf(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const pages = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    let out = '';
    for (const item of content.items) {
      out += item.str;
      if (item.hasEOL) out += '\n';
    }
    pages.push(out);
    setExtractStatus(`Reading page ${p} of ${pdf.numPages}…`);
  }
  return pages.join('\n\n');
}

async function extractDocx(file) {
  const buf = await file.arrayBuffer();
  const res = await mammoth.extractRawText({ arrayBuffer: buf });
  return res.value;
}

async function extractFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf')) return extractPdf(file);
  if (name.endsWith('.docx')) return extractDocx(file);
  if (name.endsWith('.txt') || name.endsWith('.md')) return file.text();
  throw new Error(`${file.name} is not a supported format`);
}

/* ============================================================
   3. RULE-BASED SPLITTER  (the no-model path, and the fallback)
   ============================================================ */

const ABBR = /\b(?:e\.g|i\.e|etc|vs|cf|approx|est|fig|no|vol|ch|pp|Dr|Mr|Mrs|Ms|Prof|St|Jr|Sr|al)\.$/i;

/**
 * A paragraph from a PDF arrives as hard-wrapped lines, so naively joining
 * every newline glues bullets and headers onto the prose beside them.
 * Wrapped prose almost always continues in lowercase — that's the signal
 * used here to tell a real header from a mid-sentence line break.
 */
function segmentBlock(block) {
  const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
  const segments = [];
  let buffer = [];
  const flush = () => { if (buffer.length) { segments.push(buffer.join(' ')); buffer = []; } };

  lines.forEach((line, i) => {
    const next = lines[i + 1] || '';
    const isBullet = /^(?:[-*•·‣o]|\d{1,2}[.)]|[a-z][.)])\s+/i.test(line);
    const isTabular = /\||\t/.test(line);
    const isHeader = line.length < 60 && !/[.!?]$/.test(line) && (!next || /^["'(]?[A-Z0-9]/.test(next));
    if (isBullet || isTabular || isHeader) { flush(); segments.push(line); }
    else buffer.push(line);
  });

  flush();
  return segments;
}

function splitSentences(text) {
  const out = [];
  for (const block of text.split(/\n{2,}/)) {
    for (const flat of segmentBlock(block)) {
    const parts = flat.split(/(?<=[.!?])\s+(?=["'(]?[A-Z0-9])/);
    let buffer = '';
    for (const part of parts) {
      buffer = buffer ? `${buffer} ${part}` : part;
      if (ABBR.test(buffer.trim())) continue;   // "e.g." isn't a sentence end
      out.push(buffer.trim());
      buffer = '';
    }
    if (buffer.trim()) out.push(buffer.trim());
    }
  }
  return out;
}

/** Drop anything that would make a bad typing drill. */
function isDrillable(s) {
  if (s.length < 35 || s.length > 165) return false;
  const words = s.split(/\s+/);
  if (words.length < 6 || words.length > 26) return false;
  if (!/[a-z]{3}/.test(s)) return false;                 // all-caps headers
  if (/^\W*(?:page|figure|table|chapter|references|appendix)\b/i.test(s)) return false;
  const alpha = (s.match(/[a-zA-Z]/g) || []).length;
  if (alpha / s.length < 0.6) return false;              // formula / table soup
  if ((s.match(/[|•·§©†‡=<>{}\\^~]/g) || []).length > 1) return false;
  return true;
}

function tidyLine(s) {
  return s
    .replace(/^\s*(?:[-*•·o]|\d{1,2}[.)]|[a-z][.)])\s+/i, '')  // leading bullets
    .replace(/^["']|["']$/g, '')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function dedupe(lines) {
  const seen = new Set();
  return lines.filter((l) => {
    const key = l.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildFromRules(text) {
  return dedupe(splitSentences(text).map(tidyLine).filter(isDrillable));
}

/* ============================================================
   4. OLLAMA
   ============================================================ */

const PROMPT = `You convert study notes into typing drills for a student revising.

Rewrite the notes below as standalone factual sentences. Rules:
- One sentence per line. No numbering, no bullets, no markdown, no preamble.
- Each sentence must be 8 to 22 words and carry exactly one fact.
- Each must make sense alone: never write "this", "the above", "as mentioned".
- Plain ASCII only. No curly quotes, em dashes, LaTeX or symbols.
- Skip headers, page numbers, citations, author names and admin text.
- Prefer definitions, causes, mechanisms and contrasts over trivia.
- Output nothing at all if the passage has no factual content.

NOTES:
"""
{{CHUNK}}
"""

SENTENCES:`;

function ollamaHost() {
  return $('#host').value.trim().replace(/\/+$/, '');
}

/**
 * @param {{silent?: boolean}} opts silent = used for the on-load auto-probe:
 *   updates the connection dot but never shows a "can't reach Ollama" error,
 *   since a first-time visitor without Ollama running shouldn't see one.
 * @returns {Promise<boolean>} whether Ollama responded with at least one model
 */
async function listModels({ silent = false } = {}) {
  setConn('busy', 'Connecting…');
  try {
    const res = await fetch(`${ollamaHost()}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { models = [] } = await res.json();
    const select = $('#model');
    select.innerHTML = '';
    if (!models.length) {
      select.innerHTML = '<option value="">No models — run: ollama pull llama3.2</option>';
      setConn('bad', 'No models');
      return false;
    }
    const saved = store.get('model', '');
    for (const m of models) {
      const opt = document.createElement('option');
      opt.value = m.name;
      opt.textContent = `${m.name}  (${(m.size / 1e9).toFixed(1)} GB)`;
      select.appendChild(opt);
    }
    select.value = models.some((m) => m.name === saved) ? saved : models[0].name;
    store.set('host', ollamaHost());
    setConn('ok', `${models.length} model${models.length > 1 ? 's' : ''} ready`);
    return true;
  } catch (err) {
    setConn(silent ? 'idle' : 'bad', silent ? 'Not connected' : 'No connection');
    if (!silent) {
      setExtractStatus(
        `Can't reach Ollama at ${ollamaHost()}. Start it with OLLAMA_ORIGINS="*" and check the README.`, true
      );
    }
    return false;
  }
}

async function generate(model, chunk, signal) {
  const res = await fetch(`${ollamaHost()}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      model,
      prompt: PROMPT.replace('{{CHUNK}}', () => chunk), // fn form: "$&" in notes stays literal
      stream: false,
      options: { temperature: 0.2, top_p: 0.9, num_predict: 700 }
    })
  });
  if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}`);
  const data = await res.json();
  return data.response || '';
}

/** Split on paragraph boundaries so a definition never straddles two calls. */
function chunkText(text, size) {
  const chunks = [];
  let current = '';
  for (const para of text.split(/\n{2,}/)) {
    if (current.length + para.length > size && current) {
      chunks.push(current.trim());
      current = '';
    }
    current += para + '\n\n';
    while (current.length > size * 1.6) {          // one huge paragraph
      chunks.push(current.slice(0, size).trim());
      current = current.slice(size);
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

/* ============================================================
   5. WEBLLM
   Runs a small instruct model inside this tab via WebGPU — no
   server, no install. The module is fetched only once the user
   actually picks this mode, so visitors who never touch it pay
   nothing for it.
   ============================================================ */

const WEBLLM_URL = 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.84/+esm';
let webllmModulePromise = null;

/** `'gpu' in navigator` only checks the API exists, not that a real adapter can be found —
 *  VMs, remote desktops, and some integrated GPUs expose the API but fail here. */
async function webgpuAdapterAvailable() {
  if (!('gpu' in navigator)) return false;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter;
  } catch {
    return false;
  }
}

function loadWebllmModule() {
  if (!webllmModulePromise) webllmModulePromise = import(WEBLLM_URL);
  return webllmModulePromise;
}

function setWebllmStatus(kind, msg) {
  const el = $('#webllm-status');
  el.textContent = msg;
  el.classList.toggle('err', kind === 'bad');
}

/** model_list entries carry a fixed vram_required_MB, so that doubles as a size sort. */
async function ensureWebllmModelList() {
  const select = $('#webllm-model');
  if (select.dataset.loaded) return;
  select.innerHTML = '<option value="">Loading model list…</option>';
  try {
    const webllm = await loadWebllmModule();
    const models = webllm.prebuiltAppConfig.model_list
      .filter((m) => /instruct/i.test(m.model_id))
      .sort((a, b) => (a.vram_required_MB || Infinity) - (b.vram_required_MB || Infinity));

    select.innerHTML = '';
    if (!models.length) {
      select.innerHTML = '<option value="">No instruct models found</option>';
      return;
    }
    for (const m of models) {
      const opt = document.createElement('option');
      opt.value = m.model_id;
      opt.textContent = m.vram_required_MB
        ? `${m.model_id}  (${(m.vram_required_MB / 1024).toFixed(1)} GB)`
        : m.model_id;
      select.appendChild(opt);
    }
    const saved = store.get('webllmModel', '');
    select.value = models.some((m) => m.model_id === saved) ? saved : models[0].model_id;
    select.dataset.loaded = '1';
  } catch (err) {
    select.innerHTML = `<option value="">Couldn't load model list</option>`;
    setWebllmStatus('bad', `Failed to reach the WebLLM CDN: ${err.message}`);
  }
}

async function loadWebllmEngine() {
  const modelId = $('#webllm-model').value;
  if (!modelId) return;
  store.set('webllmModel', modelId);

  $('#webllm-load').disabled = true;
  showProgress(true);
  setWebllmStatus('busy', 'Downloading…');

  try {
    const webllm = await loadWebllmModule();
    state.webllmEngine = await webllm.CreateMLCEngine(modelId, {
      initProgressCallback: (report) => {
        setProgress(report.progress || 0, report.text || 'Loading model…');
      }
    });
    state.webllmModel = modelId;
    setWebllmStatus('ok', `${modelId} loaded — ready to build`);
  } catch (err) {
    state.webllmEngine = null;
    state.webllmModel = null;
    setWebllmStatus('bad', `Couldn't load that model: ${err.message}`);
  } finally {
    showProgress(false);
    $('#webllm-load').disabled = false;
  }
}

/** Same prompt as the Ollama path, so both modes produce identical output. */
async function generateWebllm(chunk) {
  const completion = await state.webllmEngine.chat.completions.create({
    messages: [{ role: 'user', content: PROMPT.replace('{{CHUNK}}', () => chunk) }],
    temperature: 0.2,
    top_p: 0.9,
    max_tokens: 700
  });
  return completion.choices?.[0]?.message?.content || '';
}

/* ============================================================
   6. BUILD PIPELINE
   ============================================================ */

async function build() {
  const text = state.rawText.trim();
  if (!text) return;

  const mode = $('input[name="mode"]:checked').value;
  setExtractStatus('');

  if (mode === 'rules') {
    finishBuild(buildFromRules(text));
    return;
  }

  if (mode === 'webllm') {
    await buildWithWebllm(text);
    return;
  }

  const model = $('#model').value;
  if (!model) { setExtractStatus('Connect to Ollama and choose a model first.', true); return; }
  store.set('model', model);

  const chunks = chunkText(text, Number($('#chunk').value));
  state.abort = new AbortController();
  showProgress(true);
  $('#build').disabled = true;
  $('#cancel').hidden = false;

  const lines = [];
  try {
    for (let i = 0; i < chunks.length; i++) {
      setProgress(i / chunks.length, `Chunk ${i + 1} of ${chunks.length} — the model is reading…`);
      const raw = await generate(model, chunks[i], state.abort.signal);
      lines.push(...raw.split('\n').map(tidyLine).filter(isDrillable));
      setProgress((i + 1) / chunks.length, `${dedupe(lines).length} lines so far`);
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      setExtractStatus('Cancelled.');
    } else {
      setExtractStatus(`${err.message} — falling back to rule-based splitting.`, true);
      lines.push(...buildFromRules(text));
    }
  } finally {
    showProgress(false);
    $('#build').disabled = false;
    $('#cancel').hidden = true;
    state.abort = null;
  }

  finishBuild(dedupe(lines));
}

async function buildWithWebllm(text) {
  if (!state.webllmEngine || state.webllmModel !== $('#webllm-model').value) {
    setExtractStatus('Click "Download and load" to load the in-browser model first.', true);
    return;
  }

  const chunks = chunkText(text, Number($('#chunk').value));
  state.abort = new AbortController();
  showProgress(true);
  $('#build').disabled = true;
  $('#cancel').hidden = false;

  const lines = [];
  try {
    for (let i = 0; i < chunks.length; i++) {
      if (state.abort.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      setProgress(i / chunks.length, `Chunk ${i + 1} of ${chunks.length} — the model is reading…`);
      const raw = await generateWebllm(chunks[i]);
      lines.push(...raw.split('\n').map(tidyLine).filter(isDrillable));
      setProgress((i + 1) / chunks.length, `${dedupe(lines).length} lines so far`);
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      setExtractStatus('Cancelled.');
    } else {
      setExtractStatus(`${err.message} — falling back to rule-based splitting.`, true);
      lines.push(...buildFromRules(text));
    }
  } finally {
    showProgress(false);
    $('#build').disabled = false;
    $('#cancel').hidden = true;
    state.abort = null;
  }

  finishBuild(dedupe(lines));
}

function finishBuild(lines) {
  if (!lines.length) {
    setExtractStatus('Nothing usable came out of that. Try a longer document, or paste text directly.', true);
    return;
  }
  state.deck = lines;
  store.set('deck', lines);
  renderDeck();
  show('deck');
}

/* ============================================================
   7. DECK SCREEN
   ============================================================ */

function renderDeck() {
  const list = $('#deck');
  list.innerHTML = '';
  state.deck.forEach((line, i) => {
    const li = document.createElement('li');

    const num = document.createElement('span');
    num.className = 'deck-num';
    num.textContent = String(i + 1).padStart(2, '0');

    const text = document.createElement('div');
    text.className = 'deck-text';
    text.contentEditable = 'true';
    text.spellcheck = false;
    text.textContent = line;
    text.addEventListener('blur', () => {
      state.deck[i] = tidyLine(text.textContent);
      store.set('deck', state.deck);
    });

    const del = document.createElement('button');
    del.className = 'deck-del';
    del.type = 'button';
    del.title = 'Remove this line';
    del.setAttribute('aria-label', `Remove line ${i + 1}`);
    del.textContent = '×';
    del.addEventListener('click', () => {
      state.deck.splice(i, 1);
      store.set('deck', state.deck);
      renderDeck();
    });

    li.append(num, text, del);
    list.appendChild(li);
  });
  $('#start').disabled = state.deck.length === 0;
}

/* ============================================================
   8. TYPING ENGINE
   ============================================================ */

const T = {
  lines: [], idx: 0, chars: [], pos: 0,
  startedAt: null, keys: 0, hits: 0, correctChars: 0,
  cleanLines: 0, lineHadError: false, missed: [],
  ticker: null, blinkTimer: null, active: false
};

const lineEl = $('#line');
const caretEl = $('#caret');
const captureEl = $('#capture');
const veilEl = $('#veil');

function startSession(lines) {
  Object.assign(T, {
    lines: lines.slice(), idx: 0, startedAt: null,
    keys: 0, hits: 0, correctChars: 0, cleanLines: 0,
    lineHadError: false, missed: [], active: true
  });
  $('#s-total').textContent = T.lines.length;
  show('type');
  renderLine();
  focusCapture();
  T.ticker = setInterval(tick, 200);
}

function endSession() {
  T.active = false;
  clearInterval(T.ticker);
  const secs = T.startedAt ? (Date.now() - T.startedAt) / 1000 : 0;
  $('#r-clean').textContent = T.cleanLines;
  $('#r-lines').textContent = T.lines.length;
  $('#r-wpm').textContent = wpm(secs);
  $('#r-acc').textContent = accuracy();
  $('#r-time').textContent = clock(secs);
  $('#r-keys').textContent = T.keys;
  $('#review').hidden = T.missed.length === 0;
  show('results');
}

function renderLine() {
  const text = T.lines[T.idx];
  T.chars = [];
  T.pos = 0;
  T.lineHadError = false;
  lineEl.textContent = '';
  const frag = document.createDocumentFragment();
  for (const ch of text) {
    const span = document.createElement('span');
    span.className = 'ch';
    span.textContent = ch;
    frag.appendChild(span);
    T.chars.push(span);
  }
  lineEl.appendChild(frag);
  $('#s-pos').textContent = T.idx + 1;
  moveCaret();
}

function moveCaret() {
  const atEnd = T.pos >= T.chars.length;
  const ref = T.chars[atEnd ? T.chars.length - 1 : T.pos];
  if (!ref) return;
  // Spans measure from #line; the caret is positioned inside #stage.
  const x = lineEl.offsetLeft + ref.offsetLeft + (atEnd ? ref.offsetWidth : 0);
  const y = lineEl.offsetTop + ref.offsetTop + (ref.offsetHeight - caretEl.offsetHeight) / 2;
  caretEl.style.transform = `translate(${x}px, ${y}px)`;

  caretEl.classList.remove('blink');
  clearTimeout(T.blinkTimer);
  T.blinkTimer = setTimeout(() => caretEl.classList.add('blink'), 900);
}

function typeChar(ch) {
  if (T.pos >= T.chars.length) return;
  if (!T.startedAt) { T.startedAt = Date.now(); $('#stats').classList.add('is-dim'); }

  const span = T.chars[T.pos];
  const target = span.textContent;
  T.keys++;

  if (ch === target) {
    span.className = 'ch ok';
    T.hits++;
    T.correctChars++;
  } else {
    span.className = target === ' ' ? 'ch bad bad-space' : 'ch bad';
    T.lineHadError = true;
  }

  T.pos++;
  moveCaret();

  if (T.pos >= T.chars.length) completeLine();
}

function backspace() {
  if (T.pos === 0) return;
  T.pos--;
  const span = T.chars[T.pos];
  if (span.classList.contains('ok')) T.correctChars--;
  span.className = 'ch';
  moveCaret();
}

function completeLine() {
  if (!T.lineHadError) T.cleanLines++;
  else T.missed.push(T.lines[T.idx]);

  setTimeout(() => {
    if (!T.active) return;
    T.idx++;
    if (T.idx >= T.lines.length) endSession();
    else renderLine();
  }, 180);
}

function restartLine() { renderLine(); }

function skipLine() {
  T.missed.push(T.lines[T.idx]);
  T.idx++;
  if (T.idx >= T.lines.length) endSession();
  else renderLine();
}

/* — metrics — */
function wpm(secs) {
  if (!secs || secs < 1) return 0;
  return Math.round((T.correctChars / 5) / (secs / 60));
}
function accuracy() {
  return T.keys ? Math.round((T.hits / T.keys) * 100) : 100;
}
function clock(secs) {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
function tick() {
  if (!T.startedAt) return;
  const secs = (Date.now() - T.startedAt) / 1000;
  $('#s-wpm').textContent = wpm(secs);
  $('#s-acc').textContent = accuracy();
  $('#s-time').textContent = clock(secs);
}

/* — input — */
function focusCapture() { captureEl.focus({ preventScroll: true }); }

captureEl.addEventListener('focus', () => { veilEl.hidden = true; });
captureEl.addEventListener('blur', () => {
  if (T.active) { veilEl.hidden = false; $('#stats').classList.remove('is-dim'); }
});
$('#stage').addEventListener('mousedown', (e) => { e.preventDefault(); focusCapture(); });

captureEl.addEventListener('keydown', (e) => {
  if (!T.active) return;

  if (e.key === 'Tab') { e.preventDefault(); restartLine(); return; }
  if (e.key === 'Escape') { e.preventDefault(); T.active = false; clearInterval(T.ticker); show('deck'); return; }
  if (e.key === 'Backspace') { e.preventDefault(); backspace(); return; }
  if (e.key === '/' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); skipLine(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key.length !== 1) return;

  e.preventDefault();
  typeChar(e.key);
});

// Keep the value empty so mobile keyboards don't try to autocomplete.
captureEl.addEventListener('input', () => { captureEl.value = ''; });
window.addEventListener('resize', () => { if (T.active) moveCaret(); });

/* ============================================================
   9. UI PLUMBING
   ============================================================ */

function show(name) {
  $$('.screen').forEach((s) => s.classList.toggle('is-active', s.id === `screen-${name}`));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function setConn(kind, label) {
  $('#conn').className = `conn conn-${kind}`;
  $('#conn-label').textContent = label;
}

function setExtractStatus(msg, isError = false) {
  const el = $('#extract-status');
  el.textContent = msg;
  el.classList.toggle('err', isError);
}

function showProgress(on) { $('#progress').hidden = !on; }
function setProgress(ratio, label) {
  $('#progress-bar').style.width = `${Math.round(ratio * 100)}%`;
  $('#progress-label').textContent = label;
}

function refreshBuildButton() {
  state.rawText = [state.fileText || '', $('#paste').value].filter(Boolean).join('\n\n');
  const chars = state.rawText.trim().length;
  $('#build').disabled = chars < 200;
  if (chars) setExtractStatus(`${chars.toLocaleString()} characters ready`);
}

async function handleFiles(files) {
  const list = $('#file-list');
  const texts = [];
  for (const file of files) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="fname"></span><span class="fmeta">reading…</span>`;
    li.querySelector('.fname').textContent = file.name;
    list.appendChild(li);
    try {
      const text = normalise(await extractFile(file));
      texts.push(text);
      li.querySelector('.fmeta').textContent = `${text.length.toLocaleString()} chars`;
    } catch (err) {
      li.querySelector('.fmeta').textContent = err.message;
      li.querySelector('.fmeta').style.color = 'var(--wrong)';
    }
  }
  state.fileText = [state.fileText || '', ...texts].filter(Boolean).join('\n\n');
  refreshBuildButton();
}

/* — wiring — */
const drop = $('#drop');
drop.addEventListener('click', () => $('#file-input').click());
drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#file-input').click(); }
});
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('is-over');
  handleFiles(e.dataTransfer.files);
});
$('#file-input').addEventListener('change', (e) => handleFiles(e.target.files));
$('#paste').addEventListener('input', refreshBuildButton);

function updateModeUI() {
  const mode = $('input[name="mode"]:checked')?.value;
  $('#ollama-opts').disabled = mode !== 'ollama';
  $('#webllm-opts').disabled = mode !== 'webllm';
  $('#chunk-field').hidden = mode === 'rules';
  if (mode === 'webllm') ensureWebllmModelList();
}

let userPickedMode = false; // stops the async auto-detect in init() from clobbering a manual pick
$$('input[name="mode"]').forEach((r) => r.addEventListener('change', () => {
  userPickedMode = true;
  updateModeUI();
}));

$('#chunk').addEventListener('input', (e) => { $('#chunk-out').textContent = e.target.value; });
$('#connect').addEventListener('click', () => listModels());
$('#host').addEventListener('change', () => store.set('host', ollamaHost()));
$('#build').addEventListener('click', build);
$('#webllm-load').addEventListener('click', loadWebllmEngine);
$('#cancel').addEventListener('click', () => {
  state.abort?.abort();
  if ($('input[name="mode"]:checked').value === 'webllm') state.webllmEngine?.interruptGenerate();
});

$('#deck-back').addEventListener('click', () => show('setup'));
$('#start').addEventListener('click', () => startSession(state.deck));
$('#again').addEventListener('click', () => startSession(state.deck));
$('#review').addEventListener('click', () => startSession(T.missed));
$('#results-deck').addEventListener('click', () => show('deck'));
$('[data-close-banner]').addEventListener('click', () => { $('#mixed-warning').hidden = true; });

$('#theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  store.set('theme', next);
});

/* — boot — */
(async function init() {
  document.documentElement.dataset.theme =
    store.get('theme', matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

  $('#host').value = store.get('host', 'http://localhost:11434');

  const hasWebgpu = await webgpuAdapterAvailable();
  if (!hasWebgpu) {
    $('input[name="mode"][value="webllm"]').disabled = true;
    $('#webllm-sub').textContent = 'gpu' in navigator
      ? "Your browser supports the WebGPU API, but no compatible GPU adapter was found (common on remote desktops, VMs, or older/integrated graphics), so in-browser models can't run here. Try Ollama instead, or a different device."
      : "This browser doesn't support WebGPU, so in-browser models can't run here. Try a recent Chrome or Edge on desktop.";
  }
  updateModeUI(); // matches the "Rules only" default checked in the markup, before auto-detect below runs

  const saved = store.get('deck', []);
  if (saved.length) {
    state.deck = saved;
    renderDeck();
    setExtractStatus(`${saved.length} lines from your last session are still here — press Build, or skip to the deck.`);
    show('deck');
  }

  // GitHub Pages is HTTPS; Ollama is HTTP. Warn before it fails silently.
  if (location.protocol === 'https:') $('#mixed-warning').hidden = false;

  // Auto-pick a mode that actually works, so a first-time visitor never lands on a connection error.
  const ollamaOk = await listModels({ silent: true });
  if (!userPickedMode) {
    const mode = ollamaOk ? 'ollama' : hasWebgpu ? 'webllm' : 'rules';
    $(`input[name="mode"][value="${mode}"]`).checked = true;
    updateModeUI();
  }
})();
