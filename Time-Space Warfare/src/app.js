require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const db = require('./db');
const attachSockets = require('./sockets');

const authRoutes = require('./routes/auth');
const mapRoutes = require('./routes/map');
const checkpointRoutes = require('./routes/checkpoints');
const pkRoutes = require('./routes/pk');
const adminRoutes = require('./routes/admin');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(503).json({ status: 'db unreachable' });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/map', mapRoutes);
app.use('/api/checkpoints', checkpointRoutes);
app.use('/api/pk', pkRoutes);
app.use('/admin/api', adminRoutes);

const server = http.createServer(app);
const io = new Server(server);
attachSockets(io);

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`time-space-warfare listening on ${port}`);
});
