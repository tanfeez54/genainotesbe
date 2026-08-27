import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';

import { authMiddleware } from './middleware/auth';
import notesRouter from './routes/notes';
import subjectsRouter from './routes/subjects';
import sourcesRouter from './routes/sources';
import authRouter from './routes/auth';
import schoolsRouter from './routes/schools';
import classesRouter from './routes/classes';
import chaptersRouter from './routes/chapters';
import scansRouter from './routes/scans';
import questionsRouter from './routes/questions';
import questionPapersRouter from './routes/questionPapers';
import uploadRouter from './routes/upload';

const app = express();
const PORT = process.env.PORT || 4000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// Security & logging middleware
app.use(helmet());
app.use(morgan('dev'));

// CORS configuration supporting local dev & production origins
const allowedOrigins = [
  FRONTEND_URL,
  'http://localhost:3000',
  'http://localhost:3002',
  'https://genainotesbe.onrender.com',
];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, curl, or server-to-server)
      if (!origin || allowedOrigins.includes(origin) || origin.endsWith('.vercel.app') || origin.endsWith('.onrender.com')) {
        callback(null, true);
      } else {
        callback(null, true); // Permissive for API consumers with credentials
      }
    },
    credentials: true,
  })
);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});

const generateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Generation rate limit exceeded' },
});

app.use('/api', limiter);

// Health Check Endpoints (Root & /health & /api/health)
const healthHandler = (_req: express.Request, res: express.Response) => {
  res.status(200).json({
    status: 'healthy',
    service: 'SchoolPapers AI Backend API',
    uptime: `${Math.floor(process.uptime())}s`,
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    server_url: process.env.RENDER_EXTERNAL_URL || 'https://genainotesbe.onrender.com',
  });
};

app.get('/', healthHandler);
app.get('/health', healthHandler);
app.get('/api/health', healthHandler);

// Protected API routes
app.use('/api/notes/:id/generate', generateLimiter);
app.use('/api/notes', authMiddleware, notesRouter);
app.use('/api/subjects', authMiddleware, subjectsRouter);
app.use('/api/sources', authMiddleware, sourcesRouter);

// Public auth routes
app.use('/api/auth', authRouter);

// School & Multi-tenant routes
app.use('/api/schools', authMiddleware, schoolsRouter);
app.use('/api/classes', authMiddleware, classesRouter);
app.use('/api/chapters', authMiddleware, chaptersRouter);
app.use('/api/scans', authMiddleware, scansRouter);
app.use('/api/questions', authMiddleware, questionsRouter);
app.use('/api/question-papers', authMiddleware, questionPapersRouter);
app.use('/api/upload', authMiddleware, uploadRouter);

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Global error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[Error]', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`🚀 AI Notes Backend running on http://localhost:${PORT}`);
  console.log(`📡 Accepting requests from: ${FRONTEND_URL}`);
});

export default app;
