export const PASS_SCORE = 43;
export const MAX_SCORE = 50;
export const EXAM_SECONDS = 30 * 60;
export const MASTERY_STREAK = 3;
export const ROUND_SIZE = 20;
export const EXAM_LAYOUT = [[52, 10], [53, 4], [54, 3], [55, 3], [56, 2], [57, 2], [58, 1]];

export const TOPICS = new Map([
  [52, 'Pravidla provozu'], [53, 'Zásady bezpečné jízdy'], [54, 'Dopravní značky'],
  [55, 'Dopravní situace'], [56, 'Podmínky provozu vozidel'], [57, 'Související předpisy'],
  [58, 'Zdravotnická příprava'], [null, 'Ukázkové otázky'],
]);

export const STATUS = { unseen: 'Nezodpovězená', wrong: 'V chybovníku', known: 'Zvládnutá' };

export const newState = () => ({ practice: [], tests: [], flagged: [], exam: null, profile: {}, theme: 'system' });

export function questionStats(state) {
  const stats = new Map();
  const attempts = [...state.practice, ...state.tests.flatMap(test => test.items)];
  attempts.sort((a, b) => a.at - b.at);
  for (const attempt of attempts) {
    if (!attempt.id || attempt.skipped) continue;
    const stat = stats.get(attempt.id) ?? { seen: 0, correct: 0, wrong: 0, streak: 0 };
    stat.seen++;
    stat.lastAt = attempt.at;
    if (attempt.correct) {
      stat.correct++;
      stat.streak++;
    } else {
      stat.wrong++;
      stat.streak = 0;
    }
    stats.set(attempt.id, stat);
  }
  return stats;
}

export function statusOf(stat) {
  if (!stat?.seen) return 'unseen';
  return stat.wrong && stat.streak < MASTERY_STREAK ? 'wrong' : 'known';
}

export function summarize(questions, stats) {
  const result = { unseen: 0, wrong: 0, known: 0 };
  for (const question of questions) result[statusOf(stats.get(question.id))]++;
  return result;
}

export function shuffle(items) {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const other = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[other]] = [shuffled[other], shuffled[i]];
  }
  return shuffled;
}

export function mistakes(questions, stats) {
  const priority = question => {
    const { wrong, streak } = stats.get(question.id);
    return wrong * 2 + question.points - streak * 3;
  };
  return questions.filter(q => statusOf(stats.get(q.id)) === 'wrong')
    .sort((a, b) => priority(b) - priority(a));
}

export function practiceQuestions(questions, stats, flagged, mode) {
  if (mode === 'chyby') return shuffle(mistakes(questions, stats).slice(0, ROUND_SIZE));
  if (mode === 'oznacene') return shuffle(questions.filter(q => flagged.includes(q.id))).slice(0, ROUND_SIZE);

  const pool = mode === 'mix' || mode === 'nove' ? questions : questions.filter(q => q.topic_id === Number(mode));
  const unseen = shuffle(pool.filter(q => !stats.has(q.id)));
  if (mode === 'nove') return unseen.slice(0, ROUND_SIZE);

  const wrong = mistakes(pool, stats);
  const known = shuffle(pool.filter(q => statusOf(stats.get(q.id)) === 'known'));
  const reserved = wrong.slice(0, 4);
  const other = [...unseen, ...known, ...wrong.slice(reserved.length)];
  return shuffle([...reserved, ...other.slice(0, ROUND_SIZE - reserved.length)]);
}

export function examQuestions(groupB) {
  const result = EXAM_LAYOUT.flatMap(([topic, count]) => shuffle(groupB.filter(q => q.topic_id === topic)).slice(0, count));
  if (result.length !== 25 || result.reduce((sum, q) => sum + q.points, 0) !== MAX_SCORE) {
    throw new Error('Sada otázek pro cvičnou zkoušku není úplná.');
  }
  return result;
}

export function readiness(groupB, stats) {
  return EXAM_LAYOUT.map(([topic, count]) => {
    const questions = groupB.filter(q => q.topic_id === topic);
    const totals = questions.reduce((result, q) => {
      const stat = stats.get(q.id);
      result.attempts += stat?.seen ?? 0;
      result.correct += stat?.correct ?? 0;
      return result;
    }, { attempts: 0, correct: 0 });
    const baseline = totals.attempts >= 10 ? totals.correct / totals.attempts : 0.4;
    const expected = questions.reduce((sum, q) => {
      const stat = stats.get(q.id);
      const status = statusOf(stat);
      const chance = status === 'known' ? 0.95 : status === 'wrong' ? 0.4 + 0.15 * stat.streak : baseline;
      return sum + q.points * chance;
    }, 0);
    return { topic, estimated: count * expected / questions.length, max: count * questions[0].points };
  });
}

export function examResult(exam, byId, now = Date.now()) {
  const items = exam.ids.map(id => {
    const question = byId.get(id);
    const answer = exam.answers[id] ?? null;
    return { id, answer, skipped: answer === null, correct: answer === question.correct_answer, points: question.points,
      timeMs: exam.times[id] ?? 0, at: now };
  });
  return { id: exam.id, source: 'EasyAuto', title: 'Cvičná zkouška – skupina B', startedAt: exam.startedAt,
    duration: Math.max(0, Math.min(EXAM_SECONDS, Math.floor((now - exam.startedAt) / 1000))),
    score: items.reduce((sum, item) => sum + (item.correct ? item.points : 0), 0),
    maxScore: MAX_SCORE, passScore: PASS_SCORE, items };
}

export function normalize(value = '') {
  return String(value).normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function matchesSearch(question, search) {
  return [question.id, question.question, ...question.answers.map(a => a.text)]
    .some(value => normalize(value).includes(search));
}
