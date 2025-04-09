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

// Middleware: Security with more permissive settings for Render deployment
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

// More permissive CORS setup to ensure all origins can connect
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(bodyParser.json({ limit: '1mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Debug middleware to log ALL requests in detail
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  console.log('Headers:', JSON.stringify(req.headers));
  if (req.method === 'POST') {
    console.log('Body:', JSON.stringify(req.body));
  }
  next();
});

// Improved database directory determination for Render.com
let dbDir;
try {
  // Check for Render.com environment
  if (process.env.RENDER && fs.existsSync('/data')) {
    dbDir = '/data';
    console.log('Using /data directory for database storage on Render');
  } else if (process.env.RENDER) {
    // If on Render but /data doesn't exist, use tmp directory
    dbDir = '/tmp';
    console.log('Using /tmp directory for database storage on Render');
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

// Initialize SQLite DB with better error handling
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Database connection error:', err.message);
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

// Helper function to safely insert visit data with enhanced error handling
function safeInsertVisit(data, req, response) {
  // Log the data we're trying to insert
  console.log('Attempting to insert visit data:', data);
  
  if (!data.visitor_id || !data.timestamp) {
    console.error('Missing required fields in visit data:', data);
    if (response) response.status(400).json({ error: 'Missing required fields' });
    return;
  }
  
  // Detect device type
  const deviceType = detectDeviceType(data.user_agent);
  
  // Get location from IP with better error handling
  let country = 'Unknown';
  let city = 'Unknown';
  
  try {
    if (data.ip_address && data.ip_address !== '::1' && !data.ip_address.startsWith('127.0.0.1')) {
      const geoData = geoip.lookup(data.ip_address);
      if (geoData) {
        country = geoData.country || 'Unknown';
        city = geoData.city || 'Unknown';
      }
    }
  } catch (e) {
    console.error('Error looking up geo data:', e);
  }
  
  // Get language from headers
  const language = req?.headers?.['accept-language']?.split(',')[0] || 'Unknown';
  
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
    console.log(`Visit recorded successfully (ID: ${this.lastID})`);
    if (response) response.status(200).json({ success: true, id: this.lastID });
  });
}

// Improved device detection helper
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

// POST tracking endpoint with improved error handling
app.post('/api/track', (req, res) => {
  try {
    console.log('Received tracking request at /api/track');
    const visitData = req.body;
    
    // Make sure we have the visitor's IP address
    visitData.ip_address = req.headers['x-forwarded-for']?.split(',')[0] ||
                           req.headers['x-real-ip'] ||
                           req.connection.remoteAddress ||
                           req.ip;
                           
    console.log('Processing visit with IP:', visitData.ip_address);
    safeInsertVisit(visitData, req, res);
  } catch (e) {
    console.error('Error in /api/track POST:', e);
    res.status(500).json({ error: 'Server error processing request' });
  }
});

// GET pixel tracking endpoint with improved logging
app.get('/api/track-pixel', (req, res) => {
  console.log('Received pixel tracking request');
  let visitData;
  try {
    const dataParam = req.query.data;
    console.log('Pixel data param:', dataParam);
    
    if (dataParam) {
      visitData = JSON.parse(decodeURIComponent(dataParam));
    } else {
      visitData = req.query;
      console.warn('No data param found; using raw query params');
    }
    
    console.log('Parsed pixel data:', visitData);
  } catch (e) {
    console.error('Failed to parse tracking data in pixel endpoint:', e);
    visitData = req.query;
  }
  
  visitData.ip_address = req.headers['x-forwarded-for']?.split(',')[0] ||
                         req.headers['x-real-ip'] ||
                         req.connection.remoteAddress ||
                         req.ip;
  
  safeInsertVisit(visitData, req);
  
  // Return a 1x1 transparent GIF
  res.set({
    'Content-Type': 'image/gif',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  }).send(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
});

// Analytics API endpoint with better error handling
app.get('/api/analytics', (req, res) => {
  console.log('Analytics data requested');
  db.all(`SELECT * FROM visits ORDER BY id DESC LIMIT 1000`, [], (err, rows) => {
    if (err) {
      console.error('Error fetching analytics data:', err.message);
      return res.status(500).json({ error: 'Database error', details: err.message });
    }
    console.log(`Returning ${rows.length} visits`);
    res.json(rows);
  });
});

// Serve dashboard
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Serve index page (homepage) for testing
app.get('/test', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Default route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check endpoint with database check
app.get('/health', (req, res) => {
  // Test database connection
  db.get('SELECT 1', [], (err, row) => {
    if (err) {
      return res.status(500).json({ 
        status: 'error', 
        message: 'Database connection error',
        error: err.message,
        timestamp: new Date().toISOString()
      });
    }
    
    res.status(200).json({ 
      status: 'ok', 
      database: 'connected',
      timestamp: new Date().toISOString() 
    });
  });
});

// Start the server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Analytics server running on port ${PORT}`);
  console.log(`Dashboard available at: http://localhost:${PORT}/dashboard`);
});
