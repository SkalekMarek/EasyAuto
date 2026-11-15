import {
  EXAM_LAYOUT, EXAM_SECONDS, MAX_SCORE, MASTERY_STREAK, PASS_SCORE, ROUND_SIZE, STATUS, TOPICS,
  examQuestions, examResult, matchesSearch, mistakes, newState, normalize, practiceQuestions,
  questionStats, readiness, statusOf, summarize,
} from './model.js';
import { bookmarklet, importResult, isResultUrl, resultHosts } from './imports.js';

const $ = (selector, root = document) => root.querySelector(selector);
const main = $('#main');
const dialog = $('#dialog');
const storageKey = 'easyauto-progress-v1';
const mediaQuery = matchMedia('(prefers-color-scheme: dark)');
const navigation = [
  ['prehled', 'Přehled', '▦'], ['procvicovani', 'Procvičování', '◎'], ['chybovnik', 'Chybovník', '↺'],
  ['nerozumim', 'Nerozumím', '?'], ['zkouska', 'Cvičná zkouška', '◷'], ['otazky', 'Otázky', '☷'],
  ['historie', 'Historie testů', '≡'], ['import', 'Import z eTestů', '↓'],
];

let state = newState();
let bank;
let bulletin;
let groupB;
let byId;
let ministryIds;
let stats;
let practice;
let modal;
let noticeTimer;
let examVisit;
let lastRoute;
let catalog = { search: '', topic: 'all', status: 'all', scope: 'all', view: 'list', page: 0 };
let mapFilter = 'all';
let mistakeTopic = 'all';
let historyFilter = 'all';
let lastOpenedResult;

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);
const route = () => {
  const [page, sub] = location.hash.slice(1).split('/');
  return page && page !== 'main' ? [page, sub] : ['prehled'];
};
const go = page => { location.hash = page; };
const getStatus = id => statusOf(stats.get(id));
const statusFilters = [['all', 'Všechny stavy'], ...Object.entries(STATUS), ['ever-wrong', 'Někdy špatně']];
const matchesStatus = (id, filter) => filter === 'ever-wrong' ? Boolean(stats.get(id)?.wrong)
  : filter === 'all' || getStatus(id) === filter;
const count = number => number.toLocaleString('cs-CZ');
const topicName = question => TOPICS.get(question.topic_id);
const dateText = timestamp => new Date(timestamp).toLocaleString('cs-CZ', { dateStyle: 'medium', timeStyle: 'short' });
const duration = seconds => seconds == null ? '—' : `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
const label = (status, text = STATUS[status]) => `<span class="badge ${status}">${esc(text)}</span>`;
const link = (page, text, primary = false) => `<a class="button${primary ? ' primary' : ''}" href="#${page}">${esc(text)}</a>`;
const button = (action, text, { value = '', style = '', disabled = false } = {}) =>
  `<button type="button" class="${style}" data-action="${action}" data-value="${esc(value)}" ${disabled ? 'disabled' : ''}>${esc(text)}</button>`;
const empty = text => `<p class="empty">${esc(text)}</p>`;
const heading = (title, subtitle, actions = '') =>
  `<header class="page-heading"><div><h1>${esc(title)}</h1><p class="muted">${esc(subtitle)}</p></div><div class="tools">${actions}</div></header>`;
const markFor = id => state.flagged.includes(id);
const flagButton = q => `<button type="button" data-action="flag" data-value="${q.id}" aria-pressed="${markFor(q.id)}">${markFor(q.id) ? 'Odebrat z Nerozumím' : 'Nerozumím'}</button>`;

function notify(message) {
  $('#notice').textContent = message;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { $('#notice').textContent = ''; }, 5200);
}

function save() {
  try {
    localStorage.setItem(storageKey, JSON.stringify(state));
  } catch {
    notify('Prohlížeč nemohl uložit pokrok. Stáhni si zálohu z profilu.');
  }
  stats = questionStats(state);
}

function updateTheme() {
  const dark = state.theme === 'dark' || (state.theme === 'system' && mediaQuery.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

function navMarkup(current) {
  const wrong = bank.exam.filter(q => getStatus(q.id) === 'wrong').length;
  $('#navigation').innerHTML = navigation.map(([id, title, icon]) => {
    const tally = { chybovnik: wrong, nerozumim: state.flagged.length, zkouska: state.exam ? '•' : null }[id];
    return `<a href="#${id}" ${current === id ? 'aria-current="page"' : ''}>
      <span class="nav-icon" aria-hidden="true">${icon}</span><span>${title}</span>${tally ? label('unseen', tally) : ''}</a>`;
  }).join('');
  $('#profile-button').textContent = state.profile.name || 'Můj profil';
}

function mediaMarkup(media, { thumbnail = false } = {}) {
  let official;
  try { official = new URL(media.url); } catch { return ''; }
  if (official.protocol !== 'https:') return '';
  const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) || official.pathname.endsWith('.pdf');
  const useLocal = local && /^media\/[\w.-]+$/.test(media.path ?? '');
  const source = useLocal ? `./czech-driving-licence/${media.path}` : official.href;
  const attributes = `class="question-media" src="${esc(source)}" data-fallback="${useLocal ? esc(official.href) : ''}"`;
  const replacement = `<a href="${esc(official.href)}" target="_blank" rel="noopener noreferrer">Otevřít médium ve zdroji</a>`;
  return media.type === 'video'
    ? `<video ${attributes} controls playsinline preload="metadata" aria-label="Video k otázce"></video>${replacement}`
    : `<img ${attributes} alt="${thumbnail ? 'Náhled otázky' : 'Obrázek k otázce'}" loading="lazy">`;
}

function questionMarkup(question, selected, reveal, action, disabled = false) {
  return `<p class="question-text">${esc(question.question)}</p>
    ${question.media.map(item => mediaMarkup(item)).join('')}
    <div class="stack" aria-label="Možnosti odpovědi">
      ${question.answers.map((answer, index) => {
        const chosen = selected === answer.label;
        const good = reveal && answer.label === question.correct_answer;
        const style = good ? ' correct' : reveal && chosen ? ' wrong' : '';
        const content = `<kbd>${index + 1}</kbd><span class="answer-body">${esc(answer.text)}
          ${answer.media.map(item => mediaMarkup(item)).join('')}</span>
          ${good ? label('correct', 'Správně') : ''}${chosen && reveal ? label(style.trim(), 'Tvoje odpověď') : ''}`;
        return disabled
          ? `<div class="answer${style}">${content}</div>`
          : `<button type="button" class="answer${style}" data-action="${action}" data-value="${answer.label}" aria-pressed="${chosen}">${content}</button>`;
      }).join('')}
    </div>`;
}

function questionRow(q, suffix = '') {
  const s = getStatus(q.id);
  return `<div class="list-row">
    <button type="button" class="row-open" data-action="question" data-value="${q.id}">
      <span>${esc(q.question)}</span><small>${q.id} · ${topicName(q)}${suffix ? ` · ${esc(suffix)}` : ''}</small>
    </button>${label(s)}
  </div>`;
}

function testRows(tests) {
  if (!tests.length) return empty('Zatím tu nejsou žádné testy.');
  return `<div class="list">${tests.map(test => `<a class="list-row listed" href="#historie/${esc(test.id)}">
    <span><strong>${esc(test.title)}</strong><br><small>${dateText(test.startedAt)} · ${esc(test.source)}${test.duration == null ? '' : ` · ${duration(test.duration)}`}</small></span>
    <span class="row"><strong>${test.score} / ${test.maxScore}</strong> ${test.score >= test.passScore ? label('correct', 'Splněno') : label('wrong', 'Nesplněno')}</span>
  </a>`).join('')}</div>`;
}

function overview() {
  const totals = summarize(bank.exam, stats);
  const topics = readiness(groupB, stats);
  const estimate = Math.round(topics.reduce((sum, t) => sum + t.estimated, 0));
  const weak = [...topics].sort((a, b) => b.max - b.estimated - (a.max - a.estimated))[0];
  const queue = mistakes(bank.exam, stats).slice(0, 5);
  const tests = sortedTests();
  const recent = tests.slice(0, 12).reverse();
  const chart = recent.length
    ? `<div class="chart" aria-label="Vývoj skóre">${recent.map(t => {
      const percentage = Math.min(100, Math.max(0, (t.score / t.maxScore) * 100));
      const title = `${dateText(t.startedAt)} · ${t.score} / ${t.maxScore}`;
      return `<a href="#historie/${esc(t.id)}" class="${t.score >= t.passScore ? '' : 'wrong'}" style="height:${percentage}%" aria-label="${title}" title="${title}"></a>`;
    }).join('')}</div><small>Přerušovaná čára označuje 43 bodů z 50.</small>`
    : empty('Po prvním testu tady uvidíš vývoj skóre.');
  return `${heading('Přehled', 'Pokrok v otázkách a připravenost na zkoušku skupiny B.',
      link('procvicovani', 'Procvičovat') + link('zkouska', state.exam ? 'Pokračovat ve zkoušce' : 'Cvičná zkouška', true))}
    <div class="stack">
      <div class="grid grid-3">
        ${[['unseen', 'Nezodpovězené'], ['wrong', 'V chybovníku'], ['known', 'Zvládnuté']].map(([id, title]) =>
          `<a class="panel metric" href="#otazky/${id}"><span>${title}</span><strong>${count(totals[id])}</strong><small>Zobrazit otázky →</small></a>`).join('')}
      </div>
      <div class="grid">
        <section class="panel readiness stack">
          <h2>Odhad skóre · skupina B</h2>
          <div><span class="readiness-number">${estimate}</span> <span class="muted">/ 50 bodů</span></div>
          <progress class="bar" value="${estimate}" max="50" aria-label="Odhad skóre"></progress>
          <p>${estimate >= PASS_SCORE ? 'Odhad je nad hranicí pro úspěch.' : `Do hranice 43 bodů zbývá ${PASS_SCORE - estimate}.`}</p>
          <small>Největší prostor ke zlepšení · ${TOPICS.get(weak.topic)}</small>
        </section>
        <section class="panel stack"><h2>Odhad podle témat</h2><div class="list">
          ${topics.map(t => `<a class="list-row listed" href="#procvicovani/${t.topic}"><span>${TOPICS.get(t.topic)}</span>
            <strong>${t.estimated.toLocaleString('cs-CZ', { maximumFractionDigits: 1 })} / ${t.max}</strong></a>`).join('')}
        </div></section>
      </div>
      <section class="panel">
        <div class="row between"><h2>Mapa všech ${count(bank.exam.length)} otázek</h2><div class="row">
          <label for="map-filter" class="muted">Zobrazit</label><select id="map-filter">
              ${options(statusFilters, mapFilter)}
          </select></div>
        </div>
        <div class="legend" aria-label="Legenda mapy">${Object.entries(STATUS).map(([id, name]) => label(id, name)).join('')}</div>
        <div id="map-body">${mapMarkup()}</div>
      </section>
      <div class="grid">
        <section class="panel stack"><h2>Vývoj skóre</h2>${chart}</section>
        <section class="panel"><div class="row between"><h2>Na řadě v chybovníku</h2><a href="#chybovnik">Zobrazit vše</a></div>
          ${queue.length ? queue.map(q => questionRow(q, `${stats.get(q.id).wrong}× špatně`)).join('') : empty('Otázky se sem přidají po první chybě.')}
        </section>
      </div>
      <section class="panel"><div class="row between"><h2>Poslední testy</h2><a href="#historie">Celá historie</a></div>${testRows(tests.slice(0, 5))}</section>
    </div>`;
}

function options(items, value) {
  return items.map(([key, name]) => `<option value="${esc(key)}" ${String(value) === String(key) ? 'selected' : ''}>${esc(name)}</option>`).join('');
}

function mapMarkup() {
  const groups = EXAM_LAYOUT.map(([topic]) => {
    const questions = bank.exam.filter(q => q.topic_id === topic && matchesStatus(q.id, mapFilter));
    if (!questions.length) return '';
    return `<div class="map-group"><h3>${TOPICS.get(topic)} <small>${count(questions.length)}</small></h3>
      <div class="map">${questions.map(q => {
        const status = getStatus(q.id);
        return `<button type="button" class="cell ${status}" data-action="question" data-value="${q.id}"
          title="${q.id} · ${STATUS[status]}" aria-label="${q.id} · ${STATUS[status]}"></button>`;
      }).join('')}</div></div>`;
  }).join('');
  return groups || empty('Žádná otázka v tomto stavu.');
}

function catalogMarkup() {
  return `${heading('Otázky', 'Oficiální otázky, odpovědi a historie procvičování.')}
    <section class="panel stack">
      <div class="row">
        <label class="field grow">Vyhledávání<input id="catalog-search" type="search" placeholder="Text, odpověď nebo kód" value="${esc(catalog.search)}"></label>
        <label class="field">Sada<select data-filter="scope">${options([['all', 'Všechny zkušební'], ['b', 'Skupina B'], ['examples', 'Ukázkové otázky']], catalog.scope)}</select></label>
        <label class="field">Téma<select data-filter="topic">${options([['all', 'Všechna témata'], ...[...TOPICS].filter(([id]) => id !== null)], catalog.topic)}</select></label>
        <label class="field">Stav<select data-filter="status">${options(statusFilters, catalog.status)}</select></label>
      </div>
      <div class="tabs" aria-label="Zobrazení katalogu">
        ${button('view', 'Seznam', { value: 'list', style: catalog.view === 'list' ? 'primary' : '' })}
        ${button('view', 'Galerie obrázků', { value: 'gallery', style: catalog.view === 'gallery' ? 'primary' : '' })}
      </div>
      <div id="catalog-results" class="stack" aria-live="polite">${catalogResults()}</div>
    </section>`;
}

function catalogResults() {
  const questions = { all: bank.exam, b: groupB, examples: bank.examples }[catalog.scope];
  const search = normalize(catalog.search);
  const filtered = questions.filter(q =>
    (catalog.topic === 'all' || q.topic_id === Number(catalog.topic)) &&
    matchesStatus(q.id, catalog.status) &&
    (catalog.view !== 'gallery' || q.media.some(m => m.type === 'image')) &&
    matchesSearch(q, search));
  const perPage = 24;
  const pages = Math.max(1, Math.ceil(filtered.length / perPage));
  catalog.page = Math.max(0, Math.min(catalog.page, pages - 1));
  const visible = filtered.slice(catalog.page * perPage, (catalog.page + 1) * perPage);
  const results = catalog.view === 'gallery'
    ? `<div class="gallery">${visible.map(q => `<button type="button" class="tile" data-action="question" data-value="${q.id}">
      ${mediaMarkup(q.media.find(m => m.type === 'image'), { thumbnail: true })}<small>${q.id}</small><span>${esc(q.question)}</span>
      </button>`).join('')}</div>`
    : `<div class="list">${visible.map(q => questionRow(q)).join('')}</div>`;
  return `<p class="muted">Počet otázek · ${count(filtered.length)}</p>
    ${filtered.length ? results : empty('Žádné otázky neodpovídají filtrům.')}
    ${pages > 1 ? `<div class="row between"><small>Strana ${catalog.page + 1} / ${pages}</small><div class="row">
      ${button('catalog-page', 'Předchozí', { value: '-1', disabled: catalog.page === 0 })}
      ${button('catalog-page', 'Další', { value: '1', disabled: catalog.page === pages - 1 })}
    </div></div>` : ''}`;
}

function queueMarkup(flagged) {
  const questions = flagged ? [...state.flagged].reverse().map(id => byId.get(id)).filter(Boolean) : mistakes(bank.exam, stats);
  const filtered = flagged || mistakeTopic === 'all' ? questions : questions.filter(q => q.topic_id === Number(mistakeTopic));
  const external = flagged ? [] : sortedTests().flatMap(test =>
    test.items.filter(item => !item.id && !item.correct).map(item => ({ test, item })));
  return `${heading(flagged ? 'Nerozumím' : 'Chybovník',
    flagged ? 'Otázky, které si chceš znovu projít. Označení můžeš kdykoli odebrat.'
      : `Otázka z chybovníku zmizí po ${MASTERY_STREAK} správných odpovědích za sebou.`,
    questions.length ? link(`procvicovani/${flagged ? 'oznacene' : 'chyby'}`, 'Procvičit otázky', true) : '')}
    <div class="stack"><section class="panel"><div class="title-row row between"><h2>Počet otázek · ${count(filtered.length)}</h2>
      ${flagged ? '' : `<label>Téma <select id="mistake-topic">${options([['all', 'Všechna témata'], ...[...TOPICS].filter(([id]) => id !== null)], mistakeTopic)}</select></label>`}</div>
      ${filtered.length ? filtered.map(q => {
        const stat = stats.get(q.id);
        return flagged ? `<div class="list-row"><button type="button" class="row-open" data-action="question" data-value="${q.id}">
          <span>${esc(q.question)}</span><small>${q.id} · ${topicName(q)}</small></button>${flagButton(q)}</div>`
          : questionRow(q, `${stat.wrong}× špatně · ${stat.streak}/3 správně v řadě`);
      }).join('') : empty(flagged ? 'Zatím nemáš žádnou označenou otázku.' : 'V tomto výběru zatím nemáš žádné chyby.')}
    </section>${external.length ? `<section class="panel"><h2>Chyby z importovaných testů</h2>
      ${external.map(({ test, item }) => `<a class="list-row listed" href="#historie/${esc(test.id)}"><span>${esc(item.snapshot.question)}</span><small>${esc(test.title)}</small></a>`).join('')}
    </section>` : ''}</div>`;
}

function practiceMenu() {
  const totals = summarize(bank.exam, stats);
  return `${heading('Procvičování', `Kolo má až ${ROUND_SIZE} otázek. Správnou odpověď uvidíš hned.`)}
    <div class="stack">
      <div class="grid">
        <section class="panel stack"><div><h2>Mix všech témat</h2><p class="muted">Nové otázky proložené opakováním chyb.</p></div>
          <div>${link('procvicovani/mix', 'Začít mix', true)}</div></section>
        <section class="panel stack"><div><h2>Vlastní výběr</h2><p class="muted">Vyber, na co se chceš zaměřit.</p></div>
          <div class="tools">${link('procvicovani/nove', `Nezodpovězené (${totals.unseen})`)}
            ${link('procvicovani/chyby', `Chyby (${totals.wrong})`)}${link('procvicovani/oznacene', `Nerozumím (${state.flagged.length})`)}</div></section>
      </div>
      <section class="panel"><h2>Procvičování podle témat</h2><div class="list">${EXAM_LAYOUT.map(([id]) => {
        const questions = bank.exam.filter(q => q.topic_id === id);
        const info = summarize(questions, stats);
        return `<a class="list-row listed" href="#procvicovani/${id}"><span><strong>${TOPICS.get(id)}</strong><br>
          <small>${info.unseen} nezodpovězených · ${info.wrong} v chybovníku</small></span><span>${info.known} / ${questions.length} →</span></a>`;
      }).join('')}</div></section>
    </div>`;
}

function startPractice(mode) {
  const pool = mode === 'oznacene' ? bank.questions : bank.exam;
  practice = { mode, questions: practiceQuestions(pool, stats, state.flagged, mode), index: 0,
    selected: null, results: [], shownAt: Date.now() };
}

function practiceRound(mode) {
  if (practice?.mode !== mode) startPractice(mode);
  const title = { mix: 'Mix všech témat', nove: 'Nezodpovězené otázky', chyby: 'Opakování chyb', oznacene: 'Nerozumím' }[mode]
    ?? TOPICS.get(Number(mode)) ?? 'Procvičování';
  const back = link('procvicovani', 'Zpět na procvičování');
  if (!practice.questions.length) {
    return `${heading(title, 'Procvičování', back)}<section class="panel">${empty('V tomto výběru teď nejsou žádné otázky.')}</section>`;
  }
  const question = practice.questions[practice.index];
  if (!question) {
    const correct = practice.results.filter(Boolean).length;
    const total = practice.results.length;
    return `${heading('Kolo dokončeno', title, back)}<section class="panel question-card stack">
      <div class="readiness-number">${correct} / ${total}</div>
      <p>${Math.round(100 * correct / total)} % správně · ${total - correct} chyb</p>
      <div>${button('practice-restart', 'Další kolo', { style: 'primary' })}</div></section>`;
  }
  const selected = practice.selected;
  return `${heading(title, `Otázka ${practice.index + 1} z ${practice.questions.length}`, back)}
    <section class="panel question-card stack">
      <div class="row between"><span class="muted">${topicName(question)} · ${question.id} · ${question.points} b.</span>${flagButton(question)}</div>
      <progress class="bar" value="${practice.index + (selected ? 1 : 0)}" max="${practice.questions.length}" aria-label="Pokrok kola"></progress>
      ${questionMarkup(question, selected, Boolean(selected), 'practice-answer', Boolean(selected))}
      ${selected ? `<div class="row between" aria-live="polite">
        ${label(selected === question.correct_answer ? 'correct' : 'wrong', selected === question.correct_answer ? 'Správně' : 'Špatně')}
        ${button('practice-next', practice.index + 1 === practice.questions.length ? 'Zobrazit výsledek' : 'Další otázka', { style: 'primary' })}
      </div>` : ''}
      <small>Klávesy 1–3 · odpověď · N · Nerozumím · Enter · další otázka</small>
    </section>`;
}

function examMarkup() {
  const exam = state.exam;
  if (!exam) {
    return `${heading('Cvičná zkouška', 'Simulace teoretické zkoušky pro skupinu B.')}
      <div class="stack">
        <section class="panel stack">
          <div class="grid grid-3">
            <div><strong class="readiness-number">25</strong><p>otázek</p></div>
            <div><strong class="readiness-number">30</strong><p>minut</p></div>
            <div><strong class="readiness-number">43</strong><p>bodů z 50 pro úspěch</p></div>
          </div>
          <p>Odpovědi můžeš měnit až do vyhodnocení. Po vypršení času se pokus automaticky uloží.</p>
          <div>${button('exam-start', 'Začít zkoušku', { style: 'primary' })}</div>
        </section>
        <section class="panel"><h2>Složení testu</h2><div class="list">
          ${EXAM_LAYOUT.map(([topic, n]) => `<div class="list-row"><span>${TOPICS.get(topic)}</span><strong>${n}</strong></div>`).join('')}
        </div></section>
        <section class="panel"><h2>Poslední cvičné zkoušky</h2>${testRows(sortedTests().filter(t => t.source === 'EasyAuto').slice(0, 5))}</section>
      </div>`;
  }
  const q = byId.get(exam.ids[exam.index]);
  const answered = Object.keys(exam.answers).length;
  return `${heading('Cvičná zkouška', `Otázka ${exam.index + 1} z ${exam.ids.length}`)}
    <div class="grid exam-layout">
      <section class="panel stack">
        <small>${topicName(q)} · ${q.id} · ${q.points} b.</small>
        ${questionMarkup(q, exam.answers[q.id], false, 'exam-answer')}
        <div class="row between">
          ${button('exam-go', 'Předchozí', { value: exam.index - 1, disabled: exam.index === 0 })}
          ${exam.index + 1 < exam.ids.length ? button('exam-go', 'Další', { value: exam.index + 1, style: 'primary' })
            : button('exam-confirm', 'Vyhodnotit', { style: 'primary' })}
        </div>
      </section>
      <section class="panel stack">
        <div><small>Zbývající čas</small><div class="timer" id="timer" role="timer">${duration(timeLeft())}</div></div>
        <p id="exam-count">${answered} / ${exam.ids.length} zodpovězeno</p>
        <div class="exam-grid" aria-label="Přejít na otázku">${exam.ids.map((id, index) => {
          const current = index === exam.index;
          const filled = Boolean(exam.answers[id]);
          return `<button type="button" data-action="exam-go" data-value="${index}" class="${current ? 'current ' : ''}${filled ? 'correct' : ''}"
            aria-label="Otázka ${index + 1} · ${filled ? 'zodpovězená' : 'nezodpovězená'}" ${current ? 'aria-current="step"' : ''}>${index + 1}</button>`;
        }).join('')}</div>
        ${button('exam-confirm', 'Vyhodnotit zkoušku')}
        <small>1–3 · odpověď<br>← → · otázky<br>U · vyhodnotit</small>
      </section>
    </div>`;
}

function timeLeft() {
  return state.exam ? Math.max(0, Math.ceil((state.exam.startedAt + EXAM_SECONDS * 1000 - Date.now()) / 1000)) : EXAM_SECONDS;
}

function visitExamQuestion() {
  examVisit = { id: state.exam.ids[state.exam.index], at: Date.now() };
}

function logExamTime() {
  if (!examVisit || !state.exam) return;
  const { id, at } = examVisit;
  state.exam.times[id] = (state.exam.times[id] ?? 0) + Math.max(0, Date.now() - at);
  examVisit = null;
}

function finishExam() {
  if (!state.exam) return;
  logExamTime();
  const test = examResult(state.exam, byId);
  if (!state.tests.some(t => t.id === test.id)) state.tests.push(test);
  state.exam = null;
  save();
  if (route()[0] === 'zkouska') {
    closeDialog();
    go(`historie/${test.id}`);
  } else {
    navMarkup(route()[0]);
    notify('Čas vypršel. Zkouška je uložená v historii.');
  }
}

function sortedTests() {
  return [...state.tests].sort((a, b) => b.startedAt - a.startedAt);
}

function historyMarkup(id) {
  const tests = sortedTests();
  if (!id) {
    const passed = tests.filter(t => t.score >= t.passScore).length;
    const best = Math.max(0, ...tests.map(t => Math.round(50 * t.score / t.maxScore)));
    return `${heading('Historie testů', tests.length ? `${tests.length} testů · ${passed} splněno · nejlepší výsledek ${best} / 50`
      : 'Cvičné zkoušky a importované výsledky.', link('import', 'Importovat test'))}<section class="panel">${testRows(tests)}</section>`;
  }
  const test = tests.find(t => t.id === id);
  if (!test) return `${heading('Test nenalezen', 'Výsledek není uložený v tomto prohlížeči.', link('historie', 'Zpět do historie'))}`;
  const pointsByTopic = new Map();
  const items = test.items.map((item, index) => {
    const q = byId.get(item.id);
    const name = q ? topicName(q) : item.snapshot?.category || 'Vlastní otázky autoškoly';
    const tally = pointsByTopic.get(name) ?? { earned: 0, possible: 0 };
    tally.earned += item.correct ? item.points : 0;
    tally.possible += item.points;
    pointsByTopic.set(name, tally);
    return { item, index, q };
  });
  const correct = test.items.filter(i => i.correct).length;
  const passed = test.score >= test.passScore;
  return `${heading(test.title, `${dateText(test.startedAt)} · ${test.source}`, link('historie', 'Zpět do historie'))}
    <div class="stack">
      <div class="grid"><section class="panel stack">
        <div class="row between"><h2>Výsledek</h2>${label(passed ? 'correct' : 'wrong', passed ? 'Splněno' : 'Nesplněno')}</div>
        <div><span class="readiness-number">${test.score}</span> / ${test.maxScore} bodů</div>
        <small>Minimum ${test.passScore} · ${correct} / ${items.length} správně · čas ${duration(test.duration)}</small>
      </section><section class="panel"><h2>Body podle témat</h2><div class="list">
        ${[...pointsByTopic].map(([name, p]) => `<div class="list-row"><span>${esc(name)}</span><strong>${p.earned} / ${p.possible}</strong></div>`).join('')}
      </div></section></div>
      <section class="panel"><div class="row between title-row"><h2>Otázky v testu</h2><div class="row">
        ${button('history-filter', `Všechny (${items.length})`, { value: 'all', style: historyFilter === 'all' ? 'primary' : '' })}
        ${button('history-filter', `Chyby (${items.length - correct})`, { value: 'wrong', style: historyFilter === 'wrong' ? 'primary' : '' })}
      </div></div>
        ${items.filter(({ item }) => historyFilter === 'all' || !item.correct).map(({ item, index, q }) =>
          `<div class="list-row"><button class="row-open" type="button" data-action="history-item" data-value="${index}">
            <span>${index + 1}. ${esc(q?.question ?? item.snapshot?.question ?? 'Otázka z importu')}</span>
            <small>${esc(q?.id ?? item.snapshot?.code)}${item.timeMs == null ? '' : ` · ${Math.round(item.timeMs / 1000)} s`}</small>
          </button>${label(item.correct ? 'correct' : 'wrong', item.correct ? `+${item.points} b.` : `0 / ${item.points} b.`)}</div>`).join('')
        || empty('V tomto testu nemáš žádnou chybu.')}
      </section>
      <div>${button('delete-test', 'Smazat test', { value: test.id, style: 'danger' })}</div>
    </div>`;
}

function importMarkup() {
  const url = lastOpenedResult ? esc(lastOpenedResult) : '';
  return `${heading('Import z eTestů', 'Přidej výsledky z autoskola-testy.cz nebo z cvičné zkoušky Ministerstva dopravy.')}
    <div class="stack">
      <section class="panel stack"><div><h2>Odkaz na vyhodnocení</h2>
        <p class="muted">Vlož odkaz na podrobné vyhodnocení z autoskola-testy.cz.</p></div>
        <form id="result-url" class="row"><label class="field grow">Odkaz na výsledek
          <input name="url" type="url" required placeholder="https://www.autoskola-testy.cz/…" value="${url}"></label>
          <button type="submit">Načíst výsledek</button>
        </form>
        <p id="result-link-help" ${url ? '' : 'hidden'}>${url ? `<a href="${url}" target="_blank" rel="noopener noreferrer">Otevřít výsledek</a> a na stránce použít záložku „Do EasyAuto“.` : ''}</p>
      </section>
      <div class="grid">
        <section class="panel stack"><h2>Záložka prohlížeče</h2>
          <ol><li>Přetáhni tlačítko do lišty záložek.</li><li>Otevři podrobné vyhodnocení dokončeného testu.</li>
            <li>Klikni na záložku. Pokud se stáhne soubor, nahraj ho zde.</li></ol>
          <div><a class="button primary" id="bookmarklet" href="#" draggable="true">Do EasyAuto</a></div>
        </section>
        <section class="panel stack"><div><h2>Nahrát soubor</h2>
          <p class="muted">Ulož detail výsledku z autoskola-testy.cz jako HTML. Přijímáme také soubory JSON ze záložky.</p></div>
          <label class="file-drop" id="file-drop">Přetáhni soubory nebo je vyber
            <input type="file" id="result-files" multiple accept=".html,.htm,.json,text/html,application/json"></label>
        </section>
      </div>
      <section class="panel"><h2>Importované testy</h2>${testRows(sortedTests().filter(t => t.source !== 'EasyAuto'))}</section>
    </div>`;
}

function doImport(payload, jump = true) {
  const test = importResult(payload, byId, ministryIds, bank.questions);
  const existing = state.tests.find(t => t.signature === test.signature);
  if (!existing) {
    state.tests.push(test);
    save();
    notify(`Test uložen · ${test.items.filter(i => i.id).length} / ${test.items.length} otázek spárováno.`);
  } else {
    notify('Tento test je už uložený.');
  }
  const id = (existing ?? test).id;
  if (jump) go(`historie/${id}`);
  return id;
}

async function importFiles(files) {
  let id;
  const errors = [];
  for (const file of files) {
    try {
      if (file.size > 10_000_000) throw new Error('Soubor je větší než 10 MB.');
      const contents = await file.text();
      if (file.name.toLowerCase().endsWith('.json')) {
        const data = JSON.parse(contents);
        id = doImport(data.html ?? data.result ?? data, false);
      } else id = doImport(contents, false);
    } catch (error) {
      errors.push(`${file.name} · ${error.message}`);
    }
  }
  if (id) go(`historie/${id}`);
  if (errors.length) notify(errors.join(' | '));
}

function render() {
  const [page, sub] = route();
  navMarkup(page);
  const views = {
    prehled: overview,
    procvicovani: () => sub ? practiceRound(sub) : practiceMenu(),
    chybovnik: () => queueMarkup(false),
    nerozumim: () => queueMarkup(true),
    zkouska: examMarkup,
    otazky: catalogMarkup,
    historie: () => historyMarkup(sub),
    import: importMarkup,
  };
  main.innerHTML = (Object.hasOwn(views, page) ? views[page] : overview)();
  if (page === 'prehled') {
    const source = document.createElement('footer');
    source.className = 'source';
    const citation = document.createElement('a');
    citation.href = 'https://etesty.md.gov.cz/ro/Bulletin';
    citation.target = '_blank';
    citation.rel = 'noopener noreferrer';
    citation.textContent = 'Věstník Ministerstva dopravy';
    source.append('Zdroj otázek · ', citation, ` · vydání ${new Date(bulletin + 'T12:00:00').toLocaleDateString('cs-CZ')}`);
    main.append(source);
  }
  const bookmark = $('#bookmarklet');
  if (bookmark) bookmark.href = bookmarklet(new URL('#import', location.href).href);
}

function routeChanged() {
  const [page, sub] = route();
  if (lastRoute === 'zkouska' && page !== 'zkouska' && state.exam) {
    logExamTime();
    save();
  }
  if (lastRoute === 'procvicovani' && page !== 'procvicovani') practice = null;
  lastRoute = page;
  if (page === 'zkouska' && state.exam && !examVisit) visitExamQuestion();
  if (page === 'otazky') {
    catalog = { ...catalog, status: statusFilters.some(([value]) => value === sub) ? sub : 'all', page: 0 };
    if (sub) catalog = { ...catalog, search: '', topic: 'all', scope: 'all', view: 'list' };
  }
  if (page === 'historie') historyFilter = 'all';
  closeDialog();
  $('#sidebar-content').classList.remove('open');
  $('#mobile-menu').setAttribute('aria-expanded', 'false');
  render();
  window.scrollTo(0, 0);
  main.focus({ preventScroll: true });
}

function showDialog(title, html, info) {
  modal = info;
  dialog.innerHTML = `<div class="stack"><header class="row between"><h2 id="dialog-title">${esc(title)}</h2>
    ${button('close-dialog', 'Zavřít')}</header>${html}</div>`;
  if (!dialog.open) dialog.showModal();
}

function closeDialog() {
  if (dialog.open) dialog.close();
  modal = null;
}

function questionDialog(q, options = {}) {
  if (!q) return;
  const s = getStatus(q.id);
  const stat = stats.get(q.id);
  const choice = options.choice ?? null;
  const reveal = options.reveal ?? s === 'known';
  const feedback = choice ? (choice === q.correct_answer ? 'Správně' : 'Špatně') : 'Otázka';
  showDialog(feedback, `<div class="row between"><small>${q.id} · ${topicName(q)} · ${q.points} b.</small>${label(s)}</div>
    ${questionMarkup(q, choice, reveal, 'dialog-answer', reveal)}
    <div class="row between"><small>Odpovědi · ${stat?.seen ?? 0} celkem · ${stat?.correct ?? 0} správně · ${stat?.wrong ?? 0} špatně · řada ${stat?.streak ?? 0}</small>${flagButton(q)}</div>
    <div class="row">${reveal ? '' : button('reveal', 'Ukázat odpověď')}
      ${q.practice_only ? '' : link(`procvicovani/${q.topic_id}`, 'Procvičit téma')}</div>`,
    { type: 'question', q, reveal, choice, shownAt: options.shownAt ?? Date.now() });
}

function historyItem(index) {
  const test = state.tests.find(t => t.id === route()[1]);
  const item = test?.items[index];
  if (!item) return;
  const known = byId.get(item.id);
  const snapshot = item.snapshot;
  const useSnapshot = snapshot?.answers.length && (!known || (!item.answer && snapshot.selected));
  const q = useSnapshot ? { ...snapshot, media: snapshot.media.length ? snapshot.media : known?.media ?? [] } : known ?? snapshot;
  const choice = useSnapshot ? snapshot.selected : item.answer;
  showDialog(`Otázka ${index + 1} / ${test.items.length}`, `
    <div class="row between">${label(item.correct ? 'correct' : 'wrong', item.correct ? 'Správně' : item.skipped ? 'Bez odpovědi' : 'Špatně')}
      <small>${item.points} b.${item.timeMs == null ? '' : ` · ${Math.round(item.timeMs / 1000)} s`}</small></div>
    ${q ? questionMarkup(q, choice, true, '', true) : ''}
    ${choice || item.skipped ? '' : '<p class="muted">Zvolená odpověď není v tomto výsledku k dispozici.</p>'}
    <div class="row between">${button('history-item', 'Předchozí', { value: index - 1, disabled: index === 0 })}
      ${known ? flagButton(known) : ''}${button('history-item', 'Další', { value: index + 1, disabled: index + 1 === test.items.length })}</div>`,
    { type: 'history', index });
}

function searchResults(raw) {
  const query = normalize(raw);
  const pages = navigation.filter(([, title]) => normalize(title).includes(query));
  const results = query.length >= 2 ? bank.questions.filter(q => matchesSearch(q, query)).slice(0, 30) : [];
  return `${pages.length ? `<div class="list"><h3>Stránky</h3>${pages.map(([id, title]) =>
    `<a class="list-row listed" href="#${id}">${title}</a>`).join('')}</div>` : ''}
    ${results.length ? `<div class="list"><h3>Otázky</h3>${results.map(q => questionRow(q)).join('')}</div>`
    : empty(query.length < 2 ? 'Napiš alespoň dva znaky pro hledání otázek.' : 'Žádná odpovídající otázka.') }`;
}

function searchDialog() {
  showDialog('Hledat', `<label class="field">Otázka, odpověď, kód nebo stránka
    <input type="search" id="global-search" autofocus></label><div id="search-results" aria-live="polite">${searchResults('')}</div>`, { type: 'search' });
  $('#global-search').focus();
}

function profileDialog() {
  showDialog('Můj profil', `<form id="profile-form" class="stack">
    <label class="field">Jméno<input name="name" maxlength="80" autocomplete="name" value="${esc(state.profile.name)}"></label>
    <label class="field">Autoškola<input name="school" maxlength="80" value="${esc(state.profile.school)}"></label>
    <label class="field">Vzhled<select name="theme">${options([['system', 'Podle systému'], ['light', 'Světlý'], ['dark', 'Tmavý']], state.theme)}</select></label>
    <p class="muted">Výsledky a pokrok se ukládají v tomto prohlížeči.</p>
    <div class="row">${button('backup', 'Stáhnout zálohu')}<button type="submit" class="primary">Uložit profil</button></div>
  </form>`, { type: 'profile' });
}

function recordPractice(q, choice, shownAt) {
  if (!q.answers.some(answer => answer.label === choice)) return;
  const correct = choice === q.correct_answer;
  state.practice.push({ id: q.id, answer: choice, correct, at: Date.now(), timeMs: Date.now() - shownAt });
  save();
  return correct;
}

function toggleFlag(id) {
  if (!byId.has(id)) return;
  const marked = markFor(id);
  state.flagged = marked ? state.flagged.filter(q => q !== id) : [...state.flagged, id];
  save();
  if (route()[0] === 'nerozumim') {
    render();
  } else {
    navMarkup(route()[0]);
    document.querySelectorAll('button[data-action="flag"]').forEach(flag => {
      if (flag.dataset.value !== id) return;
      flag.setAttribute('aria-pressed', String(!marked));
      flag.textContent = marked ? 'Nerozumím' : 'Odebrat z Nerozumím';
    });
  }
  notify(marked ? 'Otázka byla odebrána z Nerozumím.' : 'Otázka byla přidána do Nerozumím.');
}

const actions = {
  search: searchDialog,
  profile: profileDialog,
  'close-dialog': closeDialog,
  question: value => questionDialog(byId.get(value)),
  flag: toggleFlag,
  reveal: () => questionDialog(modal.q, { ...modal, reveal: true }),
  'dialog-answer': value => {
    if (modal?.type !== 'question' || modal.reveal) return;
    if (recordPractice(modal.q, value, modal.shownAt) === undefined) return;
    questionDialog(modal.q, { reveal: true, choice: value });
    render();
  },
  view: value => {
    catalog.view = value;
    catalog.page = 0;
    if (value === 'gallery' && catalog.topic === 'all' && catalog.scope !== 'examples') catalog.topic = '54';
    render();
  },
  'catalog-page': value => {
    catalog.page += Number(value);
    $('#catalog-results').innerHTML = catalogResults();
    main.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  },
  'practice-answer': value => {
    const question = practice?.questions[practice.index];
    if (!question || practice.selected) return;
    const correct = recordPractice(question, value, practice.shownAt);
    if (correct === undefined) return;
    practice.selected = value;
    practice.results.push(correct);
    render();
    $('[data-action="practice-next"]')?.focus({ preventScroll: true });
  },
  'practice-next': () => {
    if (!practice?.selected) return;
    practice.index++;
    practice.selected = null;
    practice.shownAt = Date.now();
    render();
    main.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  },
  'practice-restart': () => {
    startPractice(practice.mode);
    render();
  },
  'exam-start': () => {
    if (state.exam) return;
    try {
      const ids = examQuestions(groupB).map(q => q.id);
      state.exam = { id: crypto.randomUUID(), startedAt: Date.now(), ids, answers: {}, index: 0, times: {} };
      visitExamQuestion();
      save();
      render();
    } catch (error) {
      notify(error.message);
    }
  },
  'exam-answer': value => {
    if (!state.exam || !timeLeft()) return;
    const exam = state.exam;
    const q = byId.get(exam.ids[exam.index]);
    if (!q.answers.some(answer => answer.label === value)) return;
    exam.answers[q.id] = value;
    save();
    document.querySelectorAll('button[data-action="exam-answer"]').forEach(element => {
      element.setAttribute('aria-pressed', String(element.dataset.value === value));
    });
    $('.exam-grid .current').classList.add('correct');
    $('.exam-grid .current').setAttribute('aria-label', `Otázka ${exam.index + 1} · zodpovězená`);
    $('#exam-count').textContent = `${Object.keys(exam.answers).length} / ${exam.ids.length} zodpovězeno`;
  },
  'exam-go': value => {
    const index = Number(value);
    if (!state.exam || !Number.isInteger(index) || index < 0 || index >= state.exam.ids.length) return;
    logExamTime();
    state.exam.index = index;
    visitExamQuestion();
    save();
    render();
    main.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  },
  'exam-confirm': () => {
    if (!state.exam) return;
    const unanswered = state.exam.ids.length - Object.keys(state.exam.answers).length;
    showDialog('Vyhodnotit zkoušku?', `<p>${unanswered ? `Zbývá ${unanswered} nezodpovězených otázek.` : 'Všechny otázky jsou zodpovězené.'}
      Po vyhodnocení se výsledek uloží do historie.</p><div class="row">
      ${button('close-dialog', 'Pokračovat')}${button('exam-finish', 'Vyhodnotit', { style: 'primary' })}</div>`, { type: 'confirm' });
  },
  'exam-finish': finishExam,
  'history-item': value => historyItem(Number(value)),
  'history-filter': value => { historyFilter = value; render(); },
  'delete-test': value => {
    showDialog('Smazat test?', `<p>Odpovědi z tohoto testu se odeberou z historie i statistik.</p><div class="row">
      ${button('close-dialog', 'Ponechat')}${button('delete-confirm', 'Smazat', { value, style: 'danger' })}</div>`, { type: 'confirm' });
  },
  'delete-confirm': value => {
    state.tests = state.tests.filter(t => t.id !== value);
    save();
    closeDialog();
    go('historie');
  },
  backup: () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const href = URL.createObjectURL(blob);
    const download = document.createElement('a');
    download.href = href;
    download.download = 'easyauto-zaloha.json';
    download.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  },
};

function installEvents() {
  window.addEventListener('hashchange', routeChanged);
  window.addEventListener('storage', event => {
    if (event.key !== storageKey) return;
    try {
      const next = JSON.parse(event.newValue);
      const visitId = state.exam?.ids[state.exam.index];
      state = { ...newState(), ...next };
      stats = questionStats(state);
      updateTheme();
      const [page] = route();
      if (page === 'zkouska') {
        if (!state.exam) examVisit = null;
        else if (visitId !== state.exam.ids[state.exam.index] || !examVisit) visitExamQuestion();
      }
      if (page === 'import') navMarkup(page);
      else render();
    } catch { /* Ignore incompatible records from another tab. */ }
  });
  $('.skip').addEventListener('click', event => {
    event.preventDefault();
    main.focus();
  });
  window.addEventListener('pagehide', () => {
    if (examVisit) {
      logExamTime();
      save();
    }
  });
  window.addEventListener('pageshow', () => {
    if (route()[0] === 'zkouska' && state.exam && !examVisit) visitExamQuestion();
  });
  mediaQuery.addEventListener('change', updateTheme);
  dialog.addEventListener('close', () => { if (!dialog.open) modal = null; });
  $('#mobile-menu').addEventListener('click', event => {
    const open = $('#sidebar-content').classList.toggle('open');
    event.currentTarget.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('error', event => {
    const target = event.target;
    const fallback = target.dataset?.fallback;
    if (fallback && !fallback.includes('.pdf#')) {
      target.dataset.fallback = '';
      target.src = fallback;
      if (target instanceof HTMLVideoElement) target.load();
    }
  }, true);
  document.addEventListener('click', event => {
    const trigger = event.target.closest('[data-action]');
    if (trigger && !trigger.disabled && Object.hasOwn(actions, trigger.dataset.action)) {
      actions[trigger.dataset.action](trigger.dataset.value);
    }
    if (event.target.closest('#bookmarklet')) {
      event.preventDefault();
      notify('Přetáhni tlačítko do lišty záložek prohlížeče.');
    }
    if (event.target.closest('dialog a[href^="#"]:not(#bookmarklet)')) closeDialog();
  });
  document.addEventListener('input', event => {
    const input = event.target;
    if (input.id === 'catalog-search') {
      catalog.search = input.value;
      catalog.page = 0;
      $('#catalog-results').innerHTML = catalogResults();
    }
    if (input.id === 'global-search') $('#search-results').innerHTML = searchResults(input.value);
  });
  document.addEventListener('change', event => {
    const input = event.target;
    if (input.dataset.filter) {
      catalog[input.dataset.filter] = input.value;
      if (input.dataset.filter === 'scope' && input.value === 'examples') catalog.topic = 'all';
      catalog.page = 0;
      const id = input.dataset.filter;
      render();
      $(`[data-filter="${id}"]`)?.focus();
    }
    if (input.id === 'map-filter') {
      mapFilter = input.value;
      $('#map-body').innerHTML = mapMarkup();
    }
    if (input.id === 'mistake-topic') {
      mistakeTopic = input.value;
      render();
      $('#mistake-topic')?.focus();
    }
    if (input.id === 'result-files') void importFiles([...input.files]);
  });
  document.addEventListener('submit', async event => {
    const form = event.target;
    if (form.id === 'profile-form') {
      event.preventDefault();
      const fields = new FormData(form);
      state.profile = { name: fields.get('name').trim(), school: fields.get('school').trim() };
      state.theme = fields.get('theme');
      save();
      updateTheme();
      navMarkup(route()[0]);
      closeDialog();
      notify('Profil uložen.');
    }
    if (form.id === 'result-url') {
      event.preventDefault();
      const value = String(new FormData(form).get('url')).trim();
      if (!isResultUrl(value)) return notify('Vlož odkaz na detail vyhodnocení z autoskola-testy.cz.');
      const submit = $('button[type="submit"]', form);
      submit.disabled = true;
      try {
        const response = await fetch(value, { signal: AbortSignal.timeout(6000) });
        if (!response.ok) throw new Error();
        doImport(await response.text());
      } catch {
        lastOpenedResult = value;
        if (route()[0] === 'import') render();
        notify('Otevři odkaz a pro přenos výsledku použij záložku „Do EasyAuto“.');
      } finally {
        submit.disabled = false;
      }
    }
  });
  for (const name of ['dragover', 'drop']) {
    document.addEventListener(name, event => {
      if (!event.target.closest('#file-drop')) return;
      event.preventDefault();
      if (name === 'drop') void importFiles([...event.dataTransfer.files]);
    });
  }
  window.addEventListener('message', event => {
    let origin;
    try { origin = new URL(event.origin); } catch { return; }
    if (origin.protocol !== 'https:' || !resultHosts.has(origin.hostname) || event.data?.type !== 'easyauto-result') return;
    event.source?.postMessage('easyauto-received', event.origin);
    try {
      doImport(event.data.html ?? event.data.result);
    } catch (error) {
      notify(error.message);
    }
  });
  document.addEventListener('keydown', event => {
    const key = event.key.toLowerCase();
    if (key === 'escape' && dialog.open) {
      event.preventDefault();
      closeDialog();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && key === 'k') {
      event.preventDefault();
      if (modal?.type === 'search') closeDialog();
      else searchDialog();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey ||
      event.target.closest('input, select, textarea, [contenteditable], video, audio')) return;
    const choice = 'ABC'[Number(key) - 1];
    if (dialog.open) {
      if (modal?.type === 'question' && choice) actions['dialog-answer'](choice);
      if (modal?.type === 'history' && ['arrowleft', 'arrowright'].includes(key)) {
        event.preventDefault();
        historyItem(modal.index + (key === 'arrowleft' ? -1 : 1));
      }
      return;
    }
    const [page, sub] = route();
    if (page === 'procvicovani' && sub) {
      const q = practice?.questions[practice.index];
      if (choice) actions['practice-answer'](choice);
      if (q && key === 'n') toggleFlag(q.id);
      if (practice?.selected && (key === 'arrowright' || (key === 'enter' && !event.target.closest('button, a')))) {
        event.preventDefault();
        actions['practice-next']();
      }
    }
    if (page === 'zkouska' && state.exam) {
      if (choice) actions['exam-answer'](choice);
      if (['arrowleft', 'arrowright'].includes(key)) {
        event.preventDefault();
        actions['exam-go'](state.exam.index + (key === 'arrowleft' ? -1 : 1));
      }
      if (key === 'u') actions['exam-confirm']();
    }
  });
}

async function start() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (saved) state = { ...state, ...saved };
  } catch { /* A new profile starts with empty progress. */ }
  updateTheme();
  const read = async path => {
    const response = await fetch(path);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  };
  const [source, licences] = await Promise.all([
    read('./czech-driving-licence/questions.json'), read('./data/licence-groups.json'),
  ]);
  bank = { questions: source.questions, exam: source.questions.filter(q => !q.practice_only), examples: source.questions.filter(q => q.practice_only) };
  bulletin = source.bulletin_date;
  byId = new Map(bank.questions.map(q => [q.id, q]));
  groupB = licences.group_b.map(id => byId.get(id)).filter(Boolean);
  ministryIds = licences.question_codes_by_ministry_id;
  stats = questionStats(state);
  installEvents();
  routeChanged();
  const tick = () => {
    if (!state.exam) return;
    const left = timeLeft();
    if (!left) finishExam();
    else if ($('#timer')) $('#timer').textContent = duration(left);
  };
  tick();
  setInterval(tick, 500);
}

start().catch(error => {
  console.error(error);
  main.innerHTML = '<h1>Otázky se nepodařilo načíst</h1><p>Zkus obnovit stránku. Při místním spuštění použij HTTP server.</p>';
});
