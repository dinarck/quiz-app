const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'quiz.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const SCHEMA_VERSION = '3';

db.exec(`
  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    image_data TEXT,
    options TEXT,
    order_num INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    token TEXT UNIQUE NOT NULL,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

const currentVer = db.prepare('SELECT value FROM config WHERE key = ?').get('schema_version');
if (!currentVer || currentVer.value !== SCHEMA_VERSION) {
  try { db.exec('ALTER TABLE questions ADD COLUMN image_data TEXT'); } catch (e) { /* already exists */ }
  try { db.exec('ALTER TABLE questions ADD COLUMN options TEXT'); } catch (e) { /* already exists */ }
  const defaultOpts = JSON.stringify({ A: 'Option A', B: 'Option B', C: 'Option C', D: 'Option D' });
  db.prepare('UPDATE questions SET options = ? WHERE options IS NULL').run(defaultOpts);
  db.exec('DROP TABLE IF EXISTS responses');
  db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run('schema_version', SCHEMA_VERSION);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    participant_id INTEGER NOT NULL,
    question_id INTEGER NOT NULL,
    answer TEXT NOT NULL CHECK(answer IN ('A', 'B', 'C', 'D')),
    answered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (participant_id) REFERENCES participants(id),
    FOREIGN KEY (question_id) REFERENCES questions(id),
    UNIQUE(participant_id, question_id)
  );
`);

const stmts = {
  getConfig: db.prepare('SELECT value FROM config WHERE key = ?'),
  setConfig: db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)'),

  allQuestions: db.prepare('SELECT * FROM questions ORDER BY order_num ASC'),
  allQuestionsLite: db.prepare('SELECT id, text, options, order_num, (image_data IS NOT NULL) as has_image FROM questions ORDER BY order_num ASC'),
  addQuestion: db.prepare('INSERT INTO questions (text, image_data, options, order_num) VALUES (?, ?, ?, ?)'),
  maxOrder: db.prepare('SELECT COALESCE(MAX(order_num), 0) as max FROM questions'),
  deleteQuestion: db.prepare('DELETE FROM questions WHERE id = ?'),
  updateOrder: db.prepare('UPDATE questions SET order_num = ? WHERE id = ?'),
  questionIds: db.prepare('SELECT id FROM questions ORDER BY order_num ASC'),
  questionById: db.prepare('SELECT * FROM questions WHERE id = ?'),
  updateQuestionText: db.prepare('UPDATE questions SET text = ?, options = ? WHERE id = ?'),

  addParticipant: db.prepare('INSERT INTO participants (name, token) VALUES (?, ?)'),
  participantByToken: db.prepare('SELECT * FROM participants WHERE token = ?'),
  allParticipants: db.prepare('SELECT id, name, joined_at FROM participants ORDER BY joined_at ASC'),
  participantCount: db.prepare('SELECT COUNT(*) as count FROM participants'),

  submitAnswer: db.prepare(`
    INSERT INTO responses (participant_id, question_id, answer)
    VALUES (?, ?, ?)
    ON CONFLICT(participant_id, question_id)
    DO UPDATE SET answer = excluded.answer, answered_at = CURRENT_TIMESTAMP
  `),
  participantAnswers: db.prepare('SELECT question_id, answer FROM responses WHERE participant_id = ?'),
  optionCount: db.prepare("SELECT answer, COUNT(*) as count FROM responses WHERE question_id = ? GROUP BY answer"),

  deleteResponsesByQuestion: db.prepare('DELETE FROM responses WHERE question_id = ?'),
  clearResponses: db.prepare('DELETE FROM responses'),
  clearParticipants: db.prepare('DELETE FROM participants'),
  clearQuestions: db.prepare('DELETE FROM questions'),
};

stmts.setConfig.run('active_question_order', db.prepare('SELECT value FROM config WHERE key = ?').get('active_question_order')?.value || '0');

module.exports = {
  getConfig(key) {
    const row = stmts.getConfig.get(key);
    return row ? row.value : null;
  },

  setConfig(key, value) {
    stmts.setConfig.run(key, String(value));
  },

  getAllQuestions() {
    return stmts.allQuestions.all();
  },

  getAllQuestionsLite() {
    return stmts.allQuestionsLite.all();
  },

  addQuestion(text, imageData, options) {
    const orderNum = stmts.maxOrder.get().max + 1;
    const optionsJson = JSON.stringify(options || { A: 'Option A', B: 'Option B', C: 'Option C', D: 'Option D' });
    const info = stmts.addQuestion.run(text, imageData || null, optionsJson, orderNum);
    return { id: Number(info.lastInsertRowid), text, options: optionsJson, has_image: !!imageData, order_num: orderNum };
  },

  updateQuestionText(id, text, options) {
    const optionsJson = options ? JSON.stringify(options) : null;
    if (optionsJson) {
      stmts.updateQuestionText.run(text, optionsJson, id);
    } else {
      db.prepare('UPDATE questions SET text = ? WHERE id = ?').run(text, id);
    }
  },

  deleteQuestion(id) {
    stmts.deleteResponsesByQuestion.run(id);
    stmts.deleteQuestion.run(id);
    const remaining = stmts.questionIds.all();
    remaining.forEach((q, i) => stmts.updateOrder.run(i + 1, q.id));
  },

  reorderQuestions: db.transaction((questionIds) => {
    questionIds.forEach((id, i) => stmts.updateOrder.run(i + 1, id));
  }),

  addParticipant(name, token) {
    const info = stmts.addParticipant.run(name, token);
    return { id: Number(info.lastInsertRowid), name, token };
  },

  getParticipantByToken(token) {
    return stmts.participantByToken.get(token);
  },

  getAllParticipants() {
    return stmts.allParticipants.all();
  },

  getParticipantCount() {
    return stmts.participantCount.get().count;
  },

  submitAnswer(participantId, questionId, answer) {
    stmts.submitAnswer.run(participantId, questionId, answer);
  },

  getParticipantAnswers(participantId) {
    return stmts.participantAnswers.all(participantId);
  },

  getQuestionStats(questionId) {
    const rows = stmts.optionCount.all(questionId);
    const counts = { A: 0, B: 0, C: 0, D: 0 };
    rows.forEach(r => { counts[r.answer] = r.count; });
    const total = counts.A + counts.B + counts.C + counts.D;
    const max = Math.max(counts.A, counts.B, counts.C, counts.D);
    const winners = Object.keys(counts).filter(k => counts[k] === max && max > 0);
    const majority = max === 0 ? 'None' : (winners.length === 1 ? winners[0] : 'Tie');
    return { ...counts, total, majority };
  },

  getFullStats() {
    const questions = stmts.allQuestionsLite.all();
    const participantCount = stmts.participantCount.get().count;
    const activeOrder = parseInt(this.getConfig('active_question_order')) || 0;

    const questionStats = questions.map(q => ({
      ...q,
      stats: this.getQuestionStats(q.id),
    }));

    return { participantCount, activeQuestionOrder: activeOrder, questions: questionStats };
  },

  resetQuiz() {
    stmts.clearResponses.run();
    stmts.clearParticipants.run();
    this.setConfig('active_question_order', '0');
  },

  resetAll() {
    stmts.clearResponses.run();
    stmts.clearParticipants.run();
    stmts.clearQuestions.run();
    this.setConfig('active_question_order', '0');
  },
};
