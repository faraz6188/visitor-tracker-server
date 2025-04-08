const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const path = require('path');
const helmet = require('helmet');
const fs = require('fs');
const geoip = require('geoip-lite');

const app = express();
const PORT = process.env.PORT || 10000;

// Middleware: Security, CORS, JSON parsing, Static Files
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
      callback(null, true);
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false
}));

app.use(bodyParser.json({ limit: '1mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Determine the database directory
let dbDir;
try {
  fs.accessSync('/data', fs.constants.W_OK);
  dbDir = '/data';
  console.log('/data directory is writable.');
} catch (e) {
  console.error('/data is not writable or does not exist, defaulting to local directory.');
  dbDir = '.';
}
const dbPath = path.join(dbDir, 'analytics.db');

// Initialize SQLite DB
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Database error:', err.message);
    process.exit(1);
  }
  console.log(`Connected to SQLite database at ${dbPath}`);
  
  // Create visits table
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
    city TEXT,
    device_type TEXT,
    language TEXT,
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

// Helper function to safely insert visit data
function safeInsertVisit(data, response) {
  if (!data.visitor_id || !data.timestamp) {
    console.error('Missing required fields in visit data');
    if (response) response.status(400).json({ error: 'Missing required fields' });
    return;
  }
  
  // Detect device type
  const deviceType = detectDeviceType(data.user_agent);
  
  // Get location from IP
  const geoData = geoip.lookup(data.ip_address || '');
  const country = geoData?.country || 'Unknown';
  const city = geoData?.city || 'Unknown';
  
  // Get language from headers
  const language = req.headers['accept-language']?.split(',')[0] || 'Unknown';
  
  const sql = `INSERT INTO visits 
    (visitor_id, timestamp, url, path, referrer, user_agent, screen_width, screen_height, 
     ip_address, country, city, device_type, language, event_type, duration) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  
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
    country,
    city,
    deviceType,
    language,
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

// Device detection helper
function detectDeviceType(userAgent) {
  if (!userAgent) return 'Unknown';
  
  if (/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(userAgent)) {
    return 'Mobile';
  } else if (/Macintosh|MacIntel/i.test(userAgent)) {
    return 'Desktop';
  } else if (/Windows NT/i.test(userAgent)) {
    return 'Desktop';
  } else if (/Linux/i.test(userAgent)) {
    return 'Desktop';
  } else if (/Chromebook/i.test(userAgent)) {
    return 'Laptop';
  } else {
    return 'Unknown';
  }
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

// Start the server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Analytics server running on port ${PORT}`);
});
