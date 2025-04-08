const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const path = require('path');
const helmet = require('helmet');

const app = express();
const PORT = process.env.PORT || 10000;

// Middleware: Security, CORS, and JSON parsing
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

app.use(cors({
  origin: function (origin, callback) {
    const allowedOrigins = [
      'https://faraz6188.github.io',
      'http://localhost:3000',
      'http://localhost:8000'
    ];
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.log('CORS blocked origin:', origin);
      // For development, allow it (remove in production)
      callback(null, true);
      // In production, consider rejecting unauthorized origins:
      // callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false
}));

app.use(bodyParser.json({ limit: '1mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Initialize SQLite DB
const dbPath = process.env.NODE_ENV === 'production' ? '/data/analytics.db' : './analytics.db';
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Database error:', err.message);
    return;
  }
  console.log(`Connected to SQLite database at ${dbPath}`);
  
  // Create visits table with additional fields
  db.run(`CREATE TABLE IF NOT EXISTS visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    visitor_id TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    url TEXT,
    path TEXT,
    referrer TEXT,
    user_agent TEXT,
    screen_width INTEGER,
    screen_height INTEGER,
    ip_address TEXT,
    country TEXT,
    event_type TEXT DEFAULT 'page_view',
    duration INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    processed INTEGER DEFAULT 0
  )`, (err) => {
    if (!err) {
      console.log('Visits table ready');
      db.run('CREATE INDEX IF NOT EXISTS idx_visitor_id ON visits (visitor_id)');
    } else {
      console.error('Table creation error:', err.message);
    }
  });
});

// Request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url} - ${req.ip}`);
  next();
});

// Helper function to safely insert visit data into the database
function safeInsertVisit(data, response) {
  if (!data.visitor_id || !data.timestamp) {
    console.error('Missing required fields in visit data');
    if (response) response.status(400).json({ error: 'Missing required fields' });
    return;
  }
  
  const sql = `INSERT INTO visits 
    (visitor_id, timestamp, url, path, referrer, user_agent, screen_width, screen_height, ip_address, event_type, duration) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  
  db.run(sql, [
    data.visitor_id,
    data.timestamp,
    data.url || '',
    data.path || '',
    data.referrer || '',
    data.user_agent || '',
    data.screen_width || 0,
    data.screen_height || 0,
    data.ip_address || '',
    data.event_type || 'page_view',
    data.duration || 0
  ], function (err) {
    if (err) {
      console.error('Error saving visit:', err.message);
      if (response) response.status(500).json({ error: 'Failed to save visit data' });
      return;
    }
    console.log(`Visit recorded (ID: ${this.lastID})`);
    if (response) response.status(200).json({ success: true, id: this.lastID });
  });
}

// POST tracking endpoint
app.post('/api/track', (req, res) => {
  try {
    const visitData = req.body;
    visitData.ip_address = req.headers['x-forwarded-for']?.split(',')[0] ||
                           req.headers['x-real-ip'] ||
                           req.connection.remoteAddress ||
                           req.ip;
    safeInsertVisit(visitData, res);
  } catch (e) {
    console.error('Error in /api/track POST:', e);
    res.status(500).json({ error: 'Server error processing request' });
  }
});

// GET pixel tracking endpoint
app.get('/api/track-pixel', (req, res) => {
  let visitData;
  try {
    visitData = JSON.parse(decodeURIComponent(req.query.data || '{}'));
  } catch {
    visitData = req.query;
    console.warn('Failed to parse tracking data in pixel endpoint; using raw query params');
  }
  
  visitData.ip_address = req.headers['x-forwarded-for']?.split(',')[0] ||
                         req.headers['x-real-ip'] ||
                         req.connection.remoteAddress ||
                         req.ip;
  
  safeInsertVisit(visitData);
  
  res.set({
    'Content-Type': 'image/gif',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  }).send(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
});

// iOS-specific tracking endpoint
app.get('/api/ios-track', (req, res) => {
  const visitData = {
    visitor_id: req.query.vid || 'ios-unknown',
    timestamp: new Date().toISOString(),
    url: decodeURIComponent(req.query.url || ''),
    path: '',
    referrer: req.headers.referer || '',
    user_agent: req.headers['user-agent'] || '',
    screen_width: parseInt(req.query.w) || 0,
    screen_height: parseInt(req.query.h) || 0,
    ip_address: req.headers['x-forwarded-for']?.split(',')[0] ||
                req.headers['x-real-ip'] ||
                req.connection.remoteAddress ||
                req.ip,
    event_type: 'ios_visit'
  };
  
  safeInsertVisit(visitData);
  
  res.set({
    'Content-Type': 'image/gif',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  }).send(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Analytics endpoint with simple authentication
app.get('/api/analytics', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== 'Bearer your-secret-token') {
    console.warn('Unauthorized analytics access');
    // In production, you would return a 401 error:
    // return res.status(401).json({ error: 'Unauthorized' });
  }
  
  db.all('SELECT * FROM visits ORDER BY timestamp DESC LIMIT 1000', [], (err, rows) => {
    if (err) {
      console.error('Error fetching analytics data:', err.message);
      return res.status(500).json({ error: 'Failed to fetch data' });
    }
    res.json(rows);
  });
});

// Dashboard route
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Catch-all 404 route
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

// Start the server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Analytics server running on port ${PORT}`);
});
