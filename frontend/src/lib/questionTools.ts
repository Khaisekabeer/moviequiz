import { parseCsv } from './csv';

// Bulk import and the set checker for the quiz master. Both work on the open set in the browser,
// so the questions stay encrypted on the server.

interface LevelRef { number: number; name: string; isActive: boolean; mode?: string }
export interface CheckQuestion {
  level: number; text: string; type: string; options: string[]; correctAnswer: string;
  isActive: boolean; backup?: boolean; imageId?: string | null; videoId?: string | null; clipKind?: string | null;
}

export const IMPORT_TEMPLATE = [
  'round,type,question,a,b,c,d,answer,accepted,note,seconds,points',
  '1,mcq,Who directed Drishyam?,Jeethu Joseph,Priyadarshan,Lijo Jose Pellissery,Aashiq Abu,A,,Released in 2013,10,1000',
  '3,spoken,Name the film described: a bench watches two strangers fall in love over many years,,,,,Before Sunrise,Before Sunset,,20,10',
].join('\r\n');

const COLUMNS = ['round', 'type', 'question', 'a', 'b', 'c', 'd', 'answer', 'accepted', 'note', 'seconds', 'points'];

// One spreadsheet row per question. "round" is the number on the level tabs, counting only levels
// that are on. "answer" is A-D or the text of an option; spoken questions leave a-d empty.
export function parseQuestionImport(csv: string, levels: LevelRef[]) {
  const rows = parseCsv(csv);
  if (rows.length < 2) return { questions: [], errors: ['The file has no question rows'] };
  const header = rows[0].map(h => h.trim().toLowerCase());
  const missing = ['round', 'question', 'answer'].filter(c => !header.includes(c));
  if (missing.length) return { questions: [], errors: [`Missing column: ${missing.join(', ')}. Download the template to see the layout.`] };
  const at = (row: string[], name: string) => (row[header.indexOf(name)] ?? '').trim();
  const rounds = levels.filter(l => l.isActive);

  const questions: Record<string, unknown>[] = [];
  const errors: string[] = [];
  rows.slice(1).forEach((row, i) => {
    const line = i + 2;
    const level = rounds[Number(at(row, 'round')) - 1];
    if (!level) { errors.push(`Row ${line}: there is no round ${at(row, 'round') || '(blank)'}`); return; }
    const options = ['a', 'b', 'c', 'd'].map(c => at(row, c)).filter(Boolean);
    const named = at(row, 'type').toLowerCase();
    const type = named === 'spoken' || named === 'short' || (!named && !options.length) ? 'short'
      : named === 'tf' || named === 'true/false' ? 'tf' : 'mcq';
    let answer = at(row, 'answer');
    if (type === 'mcq' && /^[a-d]$/i.test(answer)) answer = options['abcd'.indexOf(answer.toLowerCase())] ?? answer;
    if (type === 'tf') answer = answer.toLowerCase().startsWith('t') ? 'True' : 'False';
    questions.push({
      level: level.number,
      type,
      text: at(row, 'question'),
      options: type === 'tf' ? ['True', 'False'] : options,
      correctAnswer: answer,
      accepted: at(row, 'accepted'),
      note: at(row, 'note'),
      timeLimit: Number(at(row, 'seconds')) || (type === 'short' ? 20 : 10),
      points: Number(at(row, 'points')) || 1000,
      isActive: true,
    });
  });
  return { questions, errors };
}

export const importColumns = COLUMNS.join(', ');

const normal = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// Warnings for the quiz master: nothing here blocks a save.
export function checkSet(questions: CheckQuestion[], levels: LevelRef[]) {
  const warnings: string[] = [];
  const live = questions.filter(q => q.isActive && !q.backup);
  const rounds = levels.filter(l => l.isActive);

  for (const level of rounds) {
    const inLevel = live.filter(q => q.level === level.number);
    const withOptions = inLevel.filter(q => q.type !== 'short').length;
    if (withOptions && ['buzzer', 'passing'].includes(level.mode ?? '')) {
      warnings.push(`${level.name}: ${withOptions === 1 ? '1 question still has' : `${withOptions} questions still have`} options. This round has none, so they play as spoken and the coordinator marks them.`);
    }
    const positions = inLevel.filter(q => q.type === 'mcq' && q.options.length === 4).map(q => q.options.indexOf(q.correctAnswer));
    if (positions.length >= 8) {
      const counts = [0, 1, 2, 3].map(p => positions.filter(x => x === p).length);
      const most = Math.max(...counts);
      if (most > positions.length * 0.4) warnings.push(`${level.name}: answers lean on ${'ABCD'[counts.indexOf(most)]} (A ${counts[0]} · B ${counts[1]} · C ${counts[2]} · D ${counts[3]}).`);
    }
    positions.forEach((p, i) => {
      if (i >= 2 && p === positions[i - 1] && p === positions[i - 2]) warnings.push(`${level.name}: questions ${i - 1}–${i + 1} all have answer ${'ABCD'[p]}.`);
    });
    const formats = inLevel.map(q => (q.clipKind === 'audio' ? 'audio' : q.videoId || q.imageId ? 'picture' : 'text'));
    if (inLevel.some(q => q.type === 'short') && new Set(formats).size > 1) {
      formats.forEach((f, i) => { if (i > 0 && f === formats[i - 1]) warnings.push(`${level.name}: questions ${i} and ${i + 1} are the same kind (${f}).`); });
    }
  }

  // The same answer in more than one place usually means the same film twice.
  const seen = new Map<string, { round: string; n: number }>();
  live.forEach(q => {
    const round = levels.find(l => l.number === q.level)?.name ?? `Level ${q.level}`;
    const key = normal(q.correctAnswer);
    if (!key || ['true', 'false'].includes(key)) return;
    const first = seen.get(key);
    if (first) warnings.push(`"${q.correctAnswer}" is the answer more than once (${first.round} and ${round}).`);
    else seen.set(key, { round, n: 1 });
  });
  return warnings;
}
