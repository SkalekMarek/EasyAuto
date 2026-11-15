import { normalize, PASS_SCORE } from './model.js';

const schoolOrigin = 'https://www.autoskola-testy.cz';
const ministryOrigin = 'https://etesty.md.gov.cz';
export const resultHosts = new Set(['autoskola-testy.cz', 'www.autoskola-testy.cz', 'etesty.md.gov.cz']);

export function isResultUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && resultHosts.has(url.hostname)
      && /^\/autoskola_test_vyhodnoceni(?:_full)?\.php$/.test(url.pathname)
      && /^[a-z0-9]+$/i.test(url.searchParams.get('test_ident') ?? '');
  } catch {
    return false;
  }
}

function text(node) {
  return node?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

function safeResultMediaUrl(raw, base) {
  try {
    const url = new URL(raw, base);
    return url.protocol === 'https:' && resultHosts.has(url.hostname) ? url.href : '';
  } catch {
    return '';
  }
}

function parseSchool(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const body = text(doc.body);
  const ident = html.match(/test_ident=([a-z0-9]+)/i)?.[1];
  const title = body.match(/název testu:\s*(.+?)(?=začátek|datum|počet bodů|čas vyplňování|$)/i)?.[1];
  const date = doc.title.match(/\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})\]/);
  let startedAt;
  if (date) {
    const [, y, m, d, h, min] = date.map(Number);
    const guess = Date.UTC(y, m - 1, d, h, min);
    const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Prague', hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const parts = Object.fromEntries(fmt.formatToParts(guess).map(part => [part.type, Number(part.value)]));
    startedAt = 2 * guess - Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  }
  const score = body.match(/Počet bodů:\s*(\d+)\s*z\s*(\d+)/i);
  const time = body.match(/Čas vyplňování:\s*(\d+):(\d+)/i);
  const rows = new Map([...doc.querySelectorAll('tr[onclick]')].flatMap(row => {
    const id = row.getAttribute('onclick').match(/#ot(\d+)/)?.[1];
    if (!id) return [];
    const time = text(row.cells[2]).match(/(\d+):(\d+)/);
    return [[Number(id), { correct: normalize(text(row.cells[1])) === 'spravne',
      timeMs: time ? (Number(time[1]) * 60 + Number(time[2])) * 1000 : null }]];
  }));
  const items = [...doc.querySelectorAll('span[id^="ot"]')].flatMap(node => {
    const position = Number(node.id.match(/^ot(\d+)$/)?.[1]);
    if (!position) return [];
    const meta = text(node).match(/kód otázky:\s*([^,]+),\s*počet bodů:+\s*(\d+),\s*kategorie:\s*([^)]*)/i);
    const image = node.querySelector('img')?.getAttribute('src');
    const prompt = [...node.querySelectorAll('b')].find(b => !b.closest('ul, ol, font'));
    const answers = [...node.querySelectorAll('li')].map(li => {
      const line = text(li);
      return {
        chosen: line.includes('(VAŠE VOLBA)'), correct: line.includes('(SPRÁVNÁ ODPOVĚĎ)'),
        text: line.replace(/\((VAŠE VOLBA|SPRÁVNÁ ODPOVĚĎ)\)/g, '').replace(/^\d+\)\s*/, '').trim(),
      };
    });
    if (!answers.length) return [];
    return [{ position, code: meta?.[1].trim(), points: meta ? Number(meta[2]) : undefined, category: meta?.[3].trim(),
      question: text(prompt) || text(node).split(text(node.querySelector('li')))[0],
      image: image ? safeResultMediaUrl(image, schoolOrigin) : '', answers,
      correct: rows.get(position)?.correct ?? answers.some(a => a.correct && a.chosen), timeMs: rows.get(position)?.timeMs }];
  });
  items.sort((a, b) => a.position - b.position);
  if (!items.length) throw new Error('Na stránce chybí podrobné vyhodnocení otázek z autoskola-testy.cz.');
  return {
    source: 'autoskola-testy.cz', externalId: ident, title: title?.trim() || 'Test z autoškoly', startedAt,
    score: score ? Number(score[1]) : undefined, maxScore: score ? Number(score[2]) : undefined,
    passScore: Number(body.match(/potřebné minimum:\s*(\d+)/i)?.[1] ?? PASS_SCORE),
    duration: time ? Number(time[1]) * 60 + Number(time[2]) : null, items,
  };
}

function substituteAnswer(q, item, rawAnswers) {
  if (!q) return null;
  const chosen = rawAnswers.findIndex(a => a.chosen);
  if (chosen < 0) return null;
  if (item.correct === true) return q.correct_answer;
  const candidate = q.answers.find(a => a.label !== q.correct_answer &&
    normalize(a.text) && normalize(a.text) === normalize(rawAnswers[chosen].text));
  if (candidate) return candidate.label;
  return new Set(rawAnswers.map(a => normalize(a.text))).size === 1 && item.sourceLabel
    ? q.answers.find(a => a.label === item.sourceLabel && a.label !== q.correct_answer)?.label ?? null
    : null;
}

export function importResult(input, byId, ministryIds, bank) {
  const raw = typeof input === 'string' ? parseSchool(input) : input;
  if (!raw || !Array.isArray(raw.items) || raw.items.length < 1 || raw.items.length > 120) {
    throw new Error('Soubor neobsahuje platný výsledek testu.');
  }
  const source = raw.source === 'autoskola-testy.cz' ? raw.source : 'Ministerstvo dopravy';
  const startedAt = typeof raw.startedAt === 'number' && Number.isFinite(raw.startedAt) &&
    raw.startedAt > 0 && raw.startedAt < 8.64e15 ? raw.startedAt : Date.now();
  const items = raw.items.map(item => {
    if (!item || typeof item !== 'object') throw new Error('Výsledek obsahuje neplatnou otázku.');
    const answers = (Array.isArray(item.answers) ? item.answers : []).slice(0, 8).map((a, index) => ({
      label: 'ABCDEFGH'[index], text: String(a?.text ?? '').slice(0, 2000),
      chosen: a?.chosen === true, correct: a?.correct === true, media: [],
    }));
    const code = String(item.code ?? ministryIds[item.id] ?? '').trim().toUpperCase();
    let q = byId.get(code);
    if (!q && item.question && answers.length) {
      const prompt = normalize(item.question);
      const matches = bank.filter(q => normalize(q.question) === prompt && q.answers.length === answers.length
        && answers.every(a => normalize(a.text) && q.answers.some(b => normalize(b.text) === normalize(a.text))));
      if (matches.length === 1) q = matches[0];
    }
    const correct = item.correct === true || answers.some(a => a.chosen && a.correct);
    const points = q?.points ?? (Number.isInteger(item.points) && item.points >= 0 && item.points <= 50 ? item.points : 1);
    const img = item.image ? safeResultMediaUrl(item.image, source === 'autoskola-testy.cz' ? schoolOrigin : ministryOrigin) : '';
    const snapshot = {
      code, question: String(item.question ?? q?.question ?? 'Otázka z importu').slice(0, 2000),
      category: String(item.category ?? '').slice(0, 200), answers,
      media: img ? [{ type: 'image', url: img }] : [],
      correct_answer: answers.find(a => a.correct)?.label ?? null,
      selected: answers.find(a => a.chosen)?.label ?? null,
    };
    const selected = correct && q ? q.correct_answer : substituteAnswer(q, item, answers);
    return { id: q?.id ?? null, answer: selected, correct, skipped: item.skipped === true, points, at: startedAt,
      timeMs: Number.isFinite(item.timeMs) && item.timeMs >= 0 ? item.timeMs : null, snapshot };
  });
  const maxScore = Number.isInteger(raw.maxScore) && raw.maxScore > 0 && raw.maxScore <= 1000 ? raw.maxScore
    : Math.max(1, items.reduce((sum, item) => sum + item.points, 0));
  const score = Number.isInteger(raw.score) && raw.score >= 0 && raw.score <= maxScore ? raw.score
    : Math.min(maxScore, items.reduce((sum, item) => sum + (item.correct ? item.points : 0), 0));
  const passScore = Number.isInteger(raw.passScore) && raw.passScore > 0 && raw.passScore <= maxScore ? raw.passScore
    : Math.ceil((PASS_SCORE / 50) * maxScore);
  const signature = JSON.stringify([source, raw.externalId || '', score, maxScore,
    items.map(i => [i.id, i.correct, i.answer, i.snapshot.selected, i.id ? null : i.snapshot.question])]);
  return { id: crypto.randomUUID(), signature, source, title: String(raw.title || 'Importovaný test').slice(0, 200),
    startedAt, duration: Number.isFinite(raw.duration) && raw.duration >= 0 ? raw.duration : null, score, maxScore, passScore, items };
}

// The generated bookmark runs on the source result page and transfers only its result.
async function sendResultToEasyAuto(destination) {
  const hosts = ['autoskola-testy.cz', 'www.autoskola-testy.cz', 'etesty.md.gov.cz'];
  if (!hosts.includes(location.hostname)) return alert('Otevři podrobné vyhodnocení testu.');
  const tab = window.open(destination, 'easyauto-import');
  const send = payload => {
    const result = { type: 'easyauto-result', ...payload };
    let timer;
    const onReply = event => {
      if (event.origin === new URL(destination).origin && event.source === tab && event.data === 'easyauto-received') {
        clearInterval(timer);
        window.removeEventListener('message', onReply);
      }
    };
    const download = () => {
      const file = new Blob([JSON.stringify(result)], { type: 'application/json' });
      const download = document.createElement('a');
      download.href = URL.createObjectURL(file);
      download.download = 'easyauto-vysledek.json';
      download.click();
      setTimeout(() => URL.revokeObjectURL(download.href), 10_000);
    };
    if (!tab) return download();
    let tries = 0;
    window.addEventListener('message', onReply);
    timer = setInterval(() => {
      if (tab.closed || ++tries > 20) {
        clearInterval(timer);
        window.removeEventListener('message', onReply);
        download();
      } else tab.postMessage(result, new URL(destination).origin);
    }, 400);
  };
  const fail = () => {
    tab?.close();
    alert('Vyhodnocení se nepodařilo přečíst. Otevři detail výsledku a zkus záložku spustit znovu.');
  };
  if (document.querySelector('#ot1')) return send({ html: document.documentElement.outerHTML });

  const body = document.body.innerText;
  const old = [...document.querySelectorAll('.question-overview[data-question-id]')];
  const score = body.match(/dosaženo (\d+) bod\S* z maxima (\d+)/i) ??
    body.match(/max\. možných bodů\s*(\d+)\s*\/\s*(\d+)/i);
  const duration = body.match(/Doba trvání testu\s*(\d+):(\d+):(\d+)/i);
  const result = { source: 'Ministerstvo dopravy', title: 'Cvičná zkouška · Ministerstvo dopravy',
    score: score ? Number(score[1]) : null, maxScore: score ? Number(score[2]) : null, passScore: 43,
    duration: duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : null,
    items: [] };
  if (old.length) {
    for (const tile of old) {
      const id = Number(tile.dataset.questionId);
      const selected = Number(tile.getAttribute('onclick')?.match(/[?&](?:amp;)?a=(\d+)/)?.[1] ?? 0);
      const correct = tile.classList.contains('answer-correct');
      const item = { id, correct, skipped: !selected && !correct };
      try {
        const response = await fetch(`/api/v1/PublicWeb/Question/${id}`, { signal: AbortSignal.timeout(4000) });
        if (response.ok) {
          const q = await response.json();
          item.answers = q.questionAnswers.sort((a, b) => a.sortOrder - b.sortOrder).map(a => ({
            text: a.multilingualAnswerTexts?.cs ?? '', correct: a.answerId === q.correctAnswerId, chosen: a.answerId === selected,
          }));
          const index = item.answers.findIndex(a => a.chosen);
          item.sourceLabel = 'ABC'[index];
        }
      } catch { /* The score and Ministry question ID are still available. */ }
      result.items.push(item);
    }
    return send({ result });
  }

  const tiles = () => [...document.querySelectorAll('.question-overview-tile')];
  const total = tiles().length;
  if (!total) return fail();
  for (let n = 1; n <= total; n++) {
    tiles()[n - 1]?.click();
    let meta;
    for (let poll = 0; poll < 100; poll++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      const candidate = document.querySelector('.question-detail-meta-vestnik')?.parentElement;
      if (candidate?.textContent.includes(`Otázka č. ${n} z`)) {
        meta = candidate;
        break;
      }
    }
    if (!meta) return fail();
    const answers = [...document.querySelectorAll('.question-detail-answers li.answer')].map(li => ({
      text: li.querySelector('.answer-text')?.textContent.trim() ?? '',
      chosen: li.classList.contains('selected'), correct: li.classList.contains('answer--correct'),
    }));
    result.items.push({
      code: meta.textContent.match(/RP\d+/)?.[0],
      points: Number(meta.querySelector('.media-qbadge')?.textContent.match(/\d+/)?.[0]),
      question: document.querySelector('.question__text')?.textContent.trim(), answers,
      correct: answers.some(answer => answer.chosen && answer.correct), skipped: !answers.some(answer => answer.chosen),
    });
  }
  send({ result });
}

export function bookmarklet(destination) {
  return `javascript:void%20${encodeURIComponent(`(${sendResultToEasyAuto.toString()})(${JSON.stringify(destination)})`)}`;
}
