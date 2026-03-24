const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'quiz.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    order_num INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    token TEXT UNIQUE NOT NULL,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    participant_id INTEGER NOT NULL,
    question_id INTEGER NOT NULL,
    answer TEXT NOT NULL CHECK(answer IN ('yes', 'no')),
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
  addQuestion: db.prepare('INSERT INTO questions (text, order_num) VALUES (?, ?)'),
  maxOrder: db.prepare('SELECT COALESCE(MAX(order_num), 0) as max FROM questions'),
  deleteQuestion: db.prepare('DELETE FROM questions WHERE id = ?'),
  updateOrder: db.prepare('UPDATE questions SET order_num = ? WHERE id = ?'),
  questionIds: db.prepare('SELECT id FROM questions ORDER BY order_num ASC'),
  questionById: db.prepare('SELECT * FROM questions WHERE id = ?'),
  updateQuestionText: db.prepare('UPDATE questions SET text = ? WHERE id = ?'),

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
  yesCount: db.prepare("SELECT COUNT(*) as count FROM responses WHERE question_id = ? AND answer = 'yes'"),
  noCount: db.prepare("SELECT COUNT(*) as count FROM responses WHERE question_id = ? AND answer = 'no'"),
  answeredCount: db.prepare("SELECT COUNT(*) as count FROM responses WHERE question_id = ?"),

  deleteResponsesByQuestion: db.prepare('DELETE FROM responses WHERE question_id = ?'),
  clearResponses: db.prepare('DELETE FROM responses'),
  clearParticipants: db.prepare('DELETE FROM participants'),
  clearQuestions: db.prepare('DELETE FROM questions'),
};

stmts.setConfig.run('active_question_order', '0');

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

  addQuestion(text) {
    const orderNum = stmts.maxOrder.get().max + 1;
    const info = stmts.addQuestion.run(text, orderNum);
    return { id: Number(info.lastInsertRowid), text, order_num: orderNum };
  },

  updateQuestionText(id, text) {
    stmts.updateQuestionText.run(text, id);
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
    const yes = stmts.yesCount.get(questionId).count;
    const no = stmts.noCount.get(questionId).count;
    const total = yes + no;
    let majority = 'Tie';
    if (yes > no) majority = 'Yes';
    else if (no > yes) majority = 'No';
    return { yes, no, total, majority };
  },

  getFullStats() {
    const questions = stmts.allQuestions.all();
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
