const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const HOST_PASSWORD = process.env.HOST_PASSWORD || 'host123';
const VALID_ANSWERS = ['A', 'B', 'C', 'D'];
let hostToken = crypto.randomUUID();

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth middleware ──────────────────────────────────────────────────

function requireHost(req, res, next) {
  if (req.headers['x-host-token'] !== hostToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function requireParticipant(req, res, next) {
  const token = req.headers['x-participant-token'];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const p = db.getParticipantByToken(token);
  if (!p) return res.status(401).json({ error: 'Invalid token' });
  req.participant = p;
  next();
}

// ── Host routes ─────────────────────────────────────────────────────

app.post('/api/host/login', (req, res) => {
  if (req.body.password !== HOST_PASSWORD) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  res.json({ token: hostToken });
});

app.get('/api/host/dashboard', requireHost, (_req, res) => {
  res.json(db.getFullStats());
});

app.get('/api/host/participants', requireHost, (_req, res) => {
  res.json(db.getAllParticipants());
});

app.post('/api/host/questions', requireHost, (req, res) => {
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Question text required' });
  const imageData = req.body.imageData || null;
  const question = db.addQuestion(text, imageData);
  broadcastHostStats();
  res.json(question);
});

app.put('/api/host/questions/:id', requireHost, (req, res) => {
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Question text required' });
  db.updateQuestionText(parseInt(req.params.id), text);
  broadcastHostStats();
  res.json({ success: true });
});

app.delete('/api/host/questions/:id', requireHost, (req, res) => {
  db.deleteQuestion(parseInt(req.params.id));
  const activeOrder = parseInt(db.getConfig('active_question_order')) || 0;
  const questions = db.getAllQuestions();
  if (activeOrder > questions.length) {
    db.setConfig('active_question_order', String(questions.length));
  }
  broadcastHostStats();
  res.json({ success: true });
});

app.post('/api/host/questions/reorder', requireHost, (req, res) => {
  const { questionIds } = req.body;
  if (!Array.isArray(questionIds)) {
    return res.status(400).json({ error: 'questionIds array required' });
  }
  db.reorderQuestions(questionIds);
  broadcastHostStats();
  res.json({ success: true });
});

app.post('/api/host/activate', requireHost, (req, res) => {
  const orderNum = parseInt(req.body.orderNum);
  db.setConfig('active_question_order', String(orderNum));
  io.to('participants').emit('question-activated', { activeQuestionOrder: orderNum });
  broadcastHostStats();
  res.json({ success: true });
});

app.post('/api/host/reset', requireHost, (_req, res) => {
  db.resetQuiz();
  io.to('participants').emit('quiz-reset');
  broadcastHostStats();
  res.json({ success: true });
});

app.post('/api/host/reset-all', requireHost, (_req, res) => {
  db.resetAll();
  io.to('participants').emit('quiz-reset');
  broadcastHostStats();
  res.json({ success: true });
});

// ── Participant routes ──────────────────────────────────────────────

app.post('/api/join', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const token = crypto.randomUUID();
  const participant = db.addParticipant(name, token);
  broadcastHostStats();
  res.json({ token: participant.token, id: participant.id, name: participant.name });
});

app.get('/api/quiz/state', requireParticipant, (req, res) => {
  const questions = db.getAllQuestions();
  const activeOrder = parseInt(db.getConfig('active_question_order')) || 0;
  const answers = db.getParticipantAnswers(req.participant.id);
  const answerMap = {};
  answers.forEach(a => { answerMap[a.question_id] = a.answer; });

  const visibleQuestions = questions
    .filter(q => q.order_num <= activeOrder)
    .map(q => ({
      id: q.id,
      text: q.text,
      image_data: q.image_data || null,
      order_num: q.order_num,
      answer: answerMap[q.id] || null,
    }));

  res.json({
    participant: { id: req.participant.id, name: req.participant.name },
    questions: visibleQuestions,
    activeQuestionOrder: activeOrder,
  });
});

app.post('/api/quiz/answer', requireParticipant, (req, res) => {
  const { questionId, answer } = req.body;
  if (!questionId || !VALID_ANSWERS.includes(answer)) {
    return res.status(400).json({ error: 'Valid questionId and answer (A/B/C/D) required' });
  }
  const questions = db.getAllQuestions();
  const question = questions.find(q => q.id === questionId);
  if (!question) return res.status(404).json({ error: 'Question not found' });

  const activeOrder = parseInt(db.getConfig('active_question_order')) || 0;
  if (question.order_num > activeOrder) {
    return res.status(403).json({ error: 'Question not yet active' });
  }

  db.submitAnswer(req.participant.id, questionId, answer);
  broadcastHostStats();
  res.json({ success: true });
});

// ── Socket.io ───────────────────────────────────────────────────────

io.on('connection', (socket) => {
  socket.on('join-host', () => socket.join('host'));
  socket.on('join-participant', () => socket.join('participants'));
});

function broadcastHostStats() {
  io.to('host').emit('stats-update', db.getFullStats());
}

// ── Page routes ─────────────────────────────────────────────────────

app.get('/host', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));
app.get('/quiz', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'quiz.html')));

// ── Start ───────────────────────────────────────────────────────────

const BIND_HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, BIND_HOST, () => {
  console.log(`\n  Quiz App running on http://${BIND_HOST}:${PORT}`);
  console.log(`  Host dashboard:    http://localhost:${PORT}/host`);
  console.log(`  Participant join:  http://localhost:${PORT}`);
  console.log(`  Host password:     ${HOST_PASSWORD}\n`);
});
