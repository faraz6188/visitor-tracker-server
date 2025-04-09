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

// Determine the database directory
let dbDir;
try {
  // For Render.com environment
  if (process.env.RENDER && fs.existsSync('/data')) {
    dbDir = '/data';
    console.log('Using /data directory for database storage');
  } else {
    dbDir = '.';
    console.log('Using local directory for database storage');
  }
} catch (e) {
  console.error('Error determining database directory:', e);
  dbDir = '.';
}

// Create the public directory if it doesn't exist
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
  
  // Create a simple index.html page for the root path
  fs.writeFileSync(path.join(publicDir, 'index.html'), `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Analytics Server</title>
    </head>
    <body>
      <h1>Analytics Server</h1>
      <p>The analytics server is running.</p>
      <p><a href="/dashboard">View Dashboard</a></p>
    </body>
    </html>
  `);
  
  // Copy dashboard.html to public directory if it exists
  if (fs.existsSync('./dashboard.html')) {
    fs.copyFileSync('./dashboard.html', path.join(publicDir, 'dashboard.html'));
  }
}


// Middleware: Security, CORS, JSON parsing, Static Files
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

// More permissive CORS setup
// Replace your existing CORS setup with this
app.use(cors({
  origin: '*', // Allow requests from any origin
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Add OPTIONS handling for preflight requests
app.options('*', cors());
// Debug middleware to log requests
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url} from ${req.ip}`);
  next();
});

// Determine the database directory
let dbDir;
try {
  // For Render.com environment
  if (process.env.RENDER && fs.existsSync('/data')) {
    dbDir = '/data';
    console.log('Using /data directory for database storage');
  } else {
    dbDir = '.';
    console.log('Using local directory for database storage');
  }
} catch (e) {
  console.error('Error determining database directory:', e);
  dbDir = '.';
}

const dbPath = path.join(dbDir, 'analytics.db');
console.log(`Database path: ${dbPath}`);

// Initialize SQLite DB
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Database error:', err.message);
    console.log('Will continue without database persistence');
  } else {
    console.log(`Connected to SQLite database at ${dbPath}`);
  }
  
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

// Helper function to safely insert visit data
function safeInsertVisit(data, req, response) {
  if (!data.visitor_id || !data.timestamp) {
    console.error('Missing required fields in visit data:', data);
    if (response) response.status(400).json({ error: 'Missing required fields' });
    return;
  }
  
  // Detect device type
  const deviceType = detectDeviceType(data.user_agent);
  
  // Get location from IP
  let country = 'Unknown';
  let city = 'Unknown';
  
  try {
    const geoData = geoip.lookup(data.ip_address || '');
    if (geoData) {
      country = geoData.country || 'Unknown';
      city = geoData.city || 'Unknown';
    }
  } catch (e) {
    console.error('Error looking up geo data:', e);
  }
  
  // Get language from headers
  const language = req?.headers['accept-language']?.split(',')[0] || 'Unknown';
  
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
    console.log('Received tracking request:', req.body);
    const visitData = req.body;
    visitData.ip_address = req.headers['x-forwarded-for']?.split(',')[0] ||
                           req.headers['x-real-ip'] ||
                           req.connection.remoteAddress ||
                           req.ip;
    safeInsertVisit(visitData, req, res);
  } catch (e) {
    console.error('Error in /api/track POST:', e);
    res.status(500).json({ error: 'Server error processing request' });
  }
});

// GET pixel tracking endpoint
app.get('/api/track-pixel', (req, res) => {
  console.log('Received pixel tracking request');
  let visitData;
  try {
    visitData = JSON.parse(decodeURIComponent(req.query.data || '{}'));
  } catch (e) {
    visitData = req.query;
    console.warn('Failed to parse tracking data in pixel endpoint; using raw query params');
  }
  
  visitData.ip_address = req.headers['x-forwarded-for']?.split(',')[0] ||
                         req.headers['x-real-ip'] ||
                         req.connection.remoteAddress ||
                         req.ip;
  
  safeInsertVisit(visitData, req);
  
  res.set({
    'Content-Type': 'image/gif',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  }).send(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
});

// Add analytics API endpoint
app.get('/api/analytics', (req, res) => {
  console.log('Analytics data requested');
  db.all(`SELECT * FROM visits ORDER BY id DESC LIMIT 1000`, [], (err, rows) => {
    if (err) {
      console.error('Error fetching analytics data:', err.message);
      return res.status(500).json({ error: 'Database error' });
    }
    console.log(`Returning ${rows.length} visits`);
    res.json(rows);
  });
});

// Serve dashboard
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Serve the index page as default
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start the server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Analytics server running on port ${PORT}`);
});
