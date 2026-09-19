import express from 'express';
import cors from 'cors';
import projectsHandler from './api/projects.js';
import locationsHandler from './api/locations.js';

const app = express();
app.use(express.json());

const allowedOrigins = String(process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin: allowedOrigins.length > 0 ? allowedOrigins : false,
  methods: ['GET', 'OPTIONS'],
}));

const toExpressHandler = (handler) => async (req, res) => {
  req.query = req.query || {};
  await handler(req, res);
};

app.get('/api/projects', toExpressHandler(projectsHandler));
app.get('/api/locations', toExpressHandler(locationsHandler));

app.get('/health', (_req, res) => res.status(200).json({ ok: true }));

const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`API listening on port ${port}`);
});