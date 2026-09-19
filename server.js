import express from 'express';
import cors from 'cors';
import projectsHandler from './api/projects.js';
import locationsHandler from './api/locations.js';
import chatHandler from './api/chat.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

const allowedOrigins = String(process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin: allowedOrigins.length > 0 ? allowedOrigins : false,
  methods: ['GET', 'POST', 'OPTIONS'],
}));

const toExpressHandler = (handler) => async (req, res) => {
  try {
    await handler(req, res);
  } catch (error) {
    console.error('Unhandled API error:', error);
    if (!res.headersSent) {
      res.status(500).json({ ok: false, message: 'Internal server error' });
    }
  }
};

app.get('/api/projects', toExpressHandler(projectsHandler));
app.get('/api/locations', toExpressHandler(locationsHandler));
app.post('/api/chat', toExpressHandler(chatHandler));

app.get('/health', (_req, res) => res.status(200).json({ ok: true }));

const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`API listening on port ${port}`);
});