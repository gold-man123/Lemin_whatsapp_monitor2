import makeWASocket, { 
  fetchLatestBaileysVersion, 
  useMultiFileAuthState, 
  DisconnectReason 
} from '@adiwajshing/baileys';
import { Boom } from '@hapi/boom';
import express from 'express';
import http from 'http';
import { Server as IOServer } from 'socket.io';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import compression from 'compression';
import cors from 'cors';
import { body, validationResult } from 'express-validator';
import path from 'path';
import { fileURLToPath } from 'url';
import sqlite3 from 'sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const CONFIG = {
  AUTH_DIR: './auth_info',
  DB_FILE: './whatsapp_data.db',
  PORT: parseInt(process.env.PORT || '3000'),
  WEBHOOK_URL: process.env.WEBHOOK_URL || '',
  LOG_LEVEL: process.env.LOG_LEVEL || 'info'
};

// Database Manager
class DatabaseManager {
  constructor(dbFile) {
    this.dbFile = dbFile;
    this.db = null;
  }

  async initialize() {
    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(this.dbFile, (err) => {
        if (err) {
          reject(err);
          return;
        }
        this.createTables().then(resolve).catch(reject);
      });
    });
  }

  async createTables() {
    return new Promise((resolve, reject) => {
      const queries = [
        `CREATE TABLE IF NOT EXISTS channels (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          jid TEXT UNIQUE NOT NULL,
          label TEXT NOT NULL,
          is_active INTEGER DEFAULT 1,
          created_at INTEGER NOT NULL,
          last_message_at INTEGER,
          message_count INTEGER DEFAULT 0
        )`,
        `CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          sender TEXT NOT NULL,
          target_channel TEXT NOT NULL,
          type TEXT NOT NULL,
          content TEXT,
          timestamp INTEGER NOT NULL,
          is_from_me INTEGER DEFAULT 0,
          message_type TEXT DEFAULT 'text'
        )`,
        `CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_messages_target ON messages(target_channel)`
      ];

      let completed = 0;
      queries.forEach(query => {
        this.db.run(query, (err) => {
          if (err) {
            reject(err);
            return;
          }
          completed++;
          if (completed === queries.length) {
            resolve();
          }
        });
      });
    });
  }

  async saveMessage(message) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT OR REPLACE INTO messages(id, sender, target_channel, type, content, timestamp, is_from_me, message_type) 
         VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          message.id,
          message.sender,
          message.target_channel,
          message.type,
          message.content,
          message.timestamp,
          message.is_from_me ? 1 : 0,
          message.message_type
        ],
        function(err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });
  }

  async addChannel(channel) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO channels(jid, label, is_active, created_at) VALUES(?, ?, ?, ?)`,
        [channel.jid, channel.label, channel.is_active ? 1 : 0, channel.created_at],
        function(err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });
  }

  async removeChannel(id) {
    return new Promise((resolve, reject) => {
      this.db.run('UPDATE channels SET is_active = 0 WHERE id = ?', [id], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async getChannels() {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT c.*, COALESCE(m.message_count, 0) as message_count
         FROM channels c
         LEFT JOIN (
           SELECT target_channel, COUNT(*) as message_count 
           FROM messages 
           GROUP BY target_channel
         ) m ON c.jid = m.target_channel
         WHERE c.is_active = 1
         ORDER BY c.created_at DESC`,
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });
  }

  async getMessages(filters = {}) {
    return new Promise((resolve, reject) => {
      let query = 'SELECT * FROM messages WHERE 1=1';
      const params = [];

      if (filters.channel) {
        query += ' AND target_channel = ?';
        params.push(filters.channel);
      }

      if (filters.search) {
        query += ' AND (content LIKE ? OR sender LIKE ?)';
        params.push(`%${filters.search}%`, `%${filters.search}%`);
      }

      query += ' ORDER BY timestamp DESC LIMIT ?';
      params.push(filters.limit || 200);

      this.db.all(query, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  }

  async getSystemStats() {
    return new Promise((resolve, reject) => {
      const queries = [
        'SELECT COUNT(*) as total_messages FROM messages',
        'SELECT COUNT(*) as total_channels FROM channels WHERE is_active = 1',
        `SELECT COUNT(*) as recent_messages FROM messages WHERE timestamp > ${Date.now() - 24 * 60 * 60 * 1000}`
      ];

      Promise.all(queries.map(query => 
        new Promise((res, rej) => {
          this.db.get(query, (err, row) => {
            if (err) rej(err);
            else res(row);
          });
        })
      )).then(results => {
        resolve({
          total_messages: results[0].total_messages || 0,
          total_channels: results[1].total_channels || 0,
          recent_messages: results[2].recent_messages || 0,
          active_alerts: 0
        });
      }).catch(reject);
    });
  }

  async close() {
    if (this.db) {
      this.db.close();
    }
  }
}

// WhatsApp Manager
class WhatsAppManager {
  constructor(authDir, db, connectionStatusEmitter) {
    this.authDir = authDir;
    this.db = db;
    this.connectionStatusEmitter = connectionStatusEmitter;
    this.sock = null;
    this.connectionStatus = 'disconnected';
    this.monitoredChannels = new Set();
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
  }

  async initialize() {
    await this.loadMonitoredChannels();
    await this.startSocket();
  }

  async loadMonitoredChannels() {
    try {
      const channels = await this.db.getChannels();
      this.monitoredChannels = new Set(channels.filter(c => c.is_active).map(c => c.jid));
      console.log(`📋 Loaded ${this.monitoredChannels.size} monitored channels`);
    } catch (error) {
      console.error('❌ Failed to load monitored channels:', error);
    }
  }

  async startSocket() {
    try {
      const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
      const { version } = await fetchLatestBaileysVersion();

      this.sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true,
        logger: {
          level: 'warn',
          fatal: (...args) => console.error('[Baileys Fatal]', ...args),
          error: (...args) => console.error('[Baileys Error]', ...args),
          warn: (...args) => console.warn('[Baileys Warn]', ...args),
          info: (...args) => console.info('[Baileys Info]', ...args),
          debug: (...args) => console.debug('[Baileys Debug]', ...args),
          trace: (...args) => console.trace('[Baileys Trace]', ...args)
        },
        markOnlineOnConnect: false,
        syncFullHistory: false
      });

      this.setupEventHandlers();
      console.log('🔄 WhatsApp socket initialized');
    } catch (error) {
      console.error('❌ Failed to start WhatsApp socket:', error);
      await this.handleReconnection();
    }
  }

  setupEventHandlers() {
    if (!this.sock) return;

    this.sock.ev.on('creds.update', async () => {
      try {
        const { saveCreds } = await useMultiFileAuthState(this.authDir);
        await saveCreds();
      } catch (error) {
        console.error('❌ Failed to save credentials:', error);
      }
    });

    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('📱 Scan QR Code with WhatsApp to connect');
        this.connectionStatus = 'qr_ready';
        this.connectionStatusEmitter('qr_ready');
      }

      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log('❌ Connection closed. Reconnecting:', shouldReconnect);
        this.connectionStatus = 'disconnected';
        this.connectionStatusEmitter('disconnected');

        if (shouldReconnect) {
          await this.handleReconnection();
        }
      } else if (connection === 'open') {
        console.log('✅ WhatsApp connected successfully');
        this.connectionStatus = 'connected';
        this.reconnectAttempts = 0;
        this.connectionStatusEmitter('connected');
      }
    });

    this.sock.ev.on('messages.upsert', async (messageUpdate) => {
      for (const message of messageUpdate.messages) {
        await this.processMessage(message);
      }
    });
  }

  async processMessage(message) {
    try {
      const messageData = this.extractMessageData(message);
      if (!messageData || !this.monitoredChannels.has(messageData.target_channel)) {
        return;
      }

      await this.db.saveMessage(messageData);
      console.log(`📨 Message saved: ${messageData.sender} -> ${messageData.target_channel}`);
    } catch (error) {
      console.error('❌ Failed to process message:', error);
    }
  }

  extractMessageData(message) {
    try {
      if (!message.message || !message.key) return null;

      const messageId = message.key.id || `generated-${Date.now()}-${Math.random()}`;
      const remoteJid = message.key.remoteJid;
      const participant = message.key.participant;
      const isFromMe = message.key.fromMe;
      const isGroup = remoteJid?.endsWith('@g.us');

      const targetChannel = isGroup ? remoteJid : (participant || remoteJid);
      const sender = isFromMe ? 'You' : (participant || remoteJid || 'unknown');

      const content = this.extractMessageContent(message);
      const messageType = this.getMessageType(message);

      let type = 'message';
      if (isFromMe) type = 'outgoing';
      else if (isGroup) type = 'group';
      else type = 'direct';

      return {
        id: messageId,
        sender,
        target_channel: targetChannel,
        type: messageType,
        content,
        timestamp: message.messageTimestamp ? parseInt(message.messageTimestamp) * 1000 : Date.now(),
        is_from_me: isFromMe,
        message_type: type
      };
    } catch (error) {
      console.error('❌ Failed to extract message data:', error);
      return null;
    }
  }

  extractMessageContent(message) {
    if (!message.message) return '';

    try {
      return (
        message.message.conversation ||
        message.message.extendedTextMessage?.text ||
        message.message.imageMessage?.caption ||
        message.message.videoMessage?.caption ||
        message.message.documentMessage?.fileName ||
        '[Media message]'
      ).toString();
    } catch (error) {
      return '[Error extracting content]';
    }
  }

  getMessageType(message) {
    if (!message.message) return 'other';

    if (message.message.conversation || message.message.extendedTextMessage) return 'text';
    if (message.message.imageMessage) return 'image';
    if (message.message.videoMessage) return 'video';
    if (message.message.audioMessage) return 'audio';
    if (message.message.documentMessage) return 'document';
    if (message.message.contactMessage) return 'contact';
    if (message.message.locationMessage) return 'location';

    return 'other';
  }

  async handleReconnection() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('🚫 Max reconnection attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    
    console.log(`🔄 Reconnection attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms`);
    
    setTimeout(async () => {
      try {
        await this.startSocket();
      } catch (error) {
        console.error('❌ Reconnection failed:', error);
        await this.handleReconnection();
      }
    }, delay);
  }

  async addMonitoredChannel(jid) {
    this.monitoredChannels.add(jid);
    console.log(`➕ Added channel to monitoring: ${jid}`);
  }

  async removeMonitoredChannel(jid) {
    this.monitoredChannels.delete(jid);
    console.log(`➖ Removed channel from monitoring: ${jid}`);
  }

  getConnectionStatus() {
    return this.connectionStatus;
  }

  async cleanup() {
    if (this.sock) {
      try {
        await this.sock.logout();
      } catch (error) {
        console.warn('⚠️ Error during logout:', error);
      }
    }
  }
}

// Express + Socket.io Setup
const app = express();
const server = http.createServer(app);
const io = new IOServer(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Security Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdn.tailwindcss.com"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com", "https://cdn.jsdelivr.net"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "ws:", "wss:"]
    }
  }
}));

app.use(cors());
app.use(compression());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests from this IP, please try again later.'
});
app.use('/api/', limiter);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Static files and view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

// Service Initialization
const dbManager = new DatabaseManager(CONFIG.DB_FILE);
let whatsappManager;

// Global connection status emitter
let connectionStatusEmitter = (status) => {
  io.emit('connection_status', { status });
};

// Validation Middleware
const validateChannelInput = [
  body('jid').trim().isLength({ min: 10, max: 100 }).matches(/^[\w\d@.-]+$/),
  body('label').optional().trim().isLength({ max: 100 })
];

// Error Handling
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

const errorHandler = (err, req, res, next) => {
  console.error('❌ Error:', err);
  
  if (req.accepts('html')) {
    res.status(500).render('error', { 
      error: 'Internal Server Error',
      message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
    });
  } else {
    res.status(500).json({ 
      error: 'Internal Server Error',
      message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
    });
  }
};

// Dashboard Routes
app.get('/', asyncHandler(async (req, res) => {
  try {
    const [channels, messages, stats] = await Promise.all([
      dbManager.getChannels(),
      dbManager.getMessages({
        channel: req.query.channel,
        search: req.query.search,
        limit: 200
      }),
      dbManager.getSystemStats()
    ]);

    const enhancedStats = {
      ...stats,
      connection_status: whatsappManager?.getConnectionStatus() || 'disconnected'
    };

    res.render('dashboard', { 
      channels, 
      messages, 
      alerts: [],
      channelFilter: req.query.channel || '', 
      searchQuery: req.query.search || '',
      stats: enhancedStats,
      connectionStatus: whatsappManager?.getConnectionStatus() || 'disconnected'
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).render('error', { 
      error: 'Dashboard Error',
      message: 'Failed to load dashboard data'
    });
  }
}));

// Add new monitoring channel
app.post('/channels', validateChannelInput, asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.redirect('/?error=invalid_input');
  }

  const { jid, label } = req.body;
  
  try {
    const channels = await dbManager.getChannels();
    const existingChannel = channels.find(c => c.jid === jid.trim());
    
    if (existingChannel) {
      return res.redirect('/?error=channel_exists');
    }

    await dbManager.addChannel({
      jid: jid.trim(),
      label: label?.trim() || jid.trim(),
      is_active: true,
      created_at: Date.now()
    });

    if (whatsappManager) {
      await whatsappManager.addMonitoredChannel(jid.trim());
    }
    
    console.log(`✅ Added monitoring channel: ${jid}`);
    res.redirect('/?success=channel_added');
  } catch (error) {
    console.error('Error adding channel:', error);
    res.redirect('/?error=database_error');
  }
}));

// Delete monitoring channel
app.post('/channels/delete', asyncHandler(async (req, res) => {
  const { id } = req.body;
  
  if (!id || isNaN(parseInt(id))) {
    return res.redirect('/?error=invalid_id');
  }

  try {
    const channels = await dbManager.getChannels();
    const channel = channels.find(c => c.id === parseInt(id));
    
    if (channel) {
      await dbManager.removeChannel(channel.id);
      if (whatsappManager) {
        await whatsappManager.removeMonitoredChannel(channel.jid);
      }
    }
    
    console.log(`🗑️ Removed monitoring channel: ${id}`);
    res.redirect('/?success=channel_removed');
  } catch (error) {
    console.error('Error removing channel:', error);
    res.redirect('/?error=database_error');
  }
}));

// API Routes
app.get('/api/messages', asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '200', 10), 1000);
  const channel = req.query.channel;
  
  const messages = await dbManager.getMessages({
    channel: channel,
    limit
  });
  
  res.json(messages);
}));

app.get('/api/channels', asyncHandler(async (req, res) => {
  const channels = await dbManager.getChannels();
  res.json(channels);
}));

app.get('/api/stats', asyncHandler(async (req, res) => {
  const stats = await dbManager.getSystemStats();
  const enhancedStats = {
    ...stats,
    connection_status: whatsappManager?.getConnectionStatus() || 'disconnected'
  };
  res.json(enhancedStats);
}));

// Health check endpoint
app.get('/health', asyncHandler(async (req, res) => {
  const health = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    connection: whatsappManager?.getConnectionStatus() || 'disconnected',
    database: 'connected'
  };
  
  res.json(health);
}));

// Socket.io Events
io.on('connection', (socket) => {
  console.log('🔌 Dashboard client connected');
  
  socket.emit('connection_status', { 
    status: whatsappManager?.getConnectionStatus() || 'disconnected' 
  });
  
  socket.on('disconnect', () => {
    console.log('🔌 Dashboard client disconnected');
  });
  
  socket.on('request_stats', asyncHandler(async () => {
    try {
      const stats = await dbManager.getSystemStats();
      const enhancedStats = {
        ...stats,
        connection_status: whatsappManager?.getConnectionStatus() || 'disconnected'
      };
      socket.emit('stats_update', enhancedStats);
    } catch (error) {
      console.error('Stats error:', error);
    }
  }));
});

// Error handling middleware
app.use(errorHandler);

// Initialize and Start
async function initialize() {
  try {
    console.log('🚀 Initializing WhatsApp Monitor System...');
    
    await dbManager.initialize();
    console.log('✅ Database initialized');
    
    whatsappManager = new WhatsAppManager(
      CONFIG.AUTH_DIR,
      dbManager,
      connectionStatusEmitter
    );
    
    await whatsappManager.initialize();
    console.log('✅ WhatsApp manager initialized');
    
    server.listen(CONFIG.PORT, () => {
      console.log(`🚀 WhatsApp Monitor Dashboard: http://localhost:${CONFIG.PORT}`);
      console.log(`📊 WebSocket server running on port ${CONFIG.PORT}`);
      console.log('\n⚠️  IMPORTANT: Only monitor accounts you own or have explicit permission to monitor.');
      console.log('   Unauthorized monitoring may violate WhatsApp ToS and local laws.\n');
    });
  } catch (error) {
    console.error('❌ Initialization failed:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  
  try {
    if (whatsappManager) {
      await whatsappManager.cleanup();
    }
    await dbManager.close();
    
    server.close(() => {
      console.log('✅ Server closed');
      process.exit(0);
    });
  } catch (error) {
    console.error('❌ Shutdown error:', error);
    process.exit(1);
  }
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

initialize();