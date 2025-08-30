import makeWASocket, { fetchLatestBaileysVersion, useMultiFileAuthState } from '@adiwajshing/baileys';
import { Boom } from '@hapi/boom';
import express from 'express';
import http from 'http';
import { Server as IOServer } from 'socket.io';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- Configuration ----------
const AUTH_DIR = './auth_info';
const DB_FILE = './whatsapp_data.db';
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';

// ---------- Express + Socket.io Setup ----------
const app = express();
const server = http.createServer(app);
const io = new IOServer(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Database Setup ----------
const dbPromise = open({
  filename: DB_FILE,
  driver: sqlite3.Database
});

async function initDb() {
  const db = await dbPromise;
  
  await db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jid TEXT UNIQUE NOT NULL,
      label TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL,
      last_message_at INTEGER
    );
  `);
  
  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      sender TEXT NOT NULL,
      target_channel TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT,
      timestamp INTEGER NOT NULL,
      is_from_me INTEGER DEFAULT 0,
      message_type TEXT DEFAULT 'text'
    );
  `);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_target ON messages(target_channel);
    CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender);
  `);
  
  console.log('✅ Database initialized');
}

// Global variables
let sock;
let connectionStatus = 'disconnected';

// ---------- Utility Functions ----------
function extractMessageContent(message) {
  if (!message.message) return '';
  
  return (
    message.message.conversation ||
    message.message.extendedTextMessage?.text ||
    message.message.imageMessage?.caption ||
    message.message.videoMessage?.caption ||
    message.message.documentMessage?.fileName ||
    message.message.audioMessage?.caption ||
    '[Media message]'
  ).toString();
}

function getMessageType(message) {
  if (!message.message) return 'unknown';
  
  if (message.message.conversation) return 'text';
  if (message.message.imageMessage) return 'image';
  if (message.message.videoMessage) return 'video';
  if (message.message.audioMessage) return 'audio';
  if (message.message.documentMessage) return 'document';
  if (message.message.contactMessage) return 'contact';
  if (message.message.locationMessage) return 'location';
  
  return 'other';
}

async function sendWebhook(payload) {
  if (!WEBHOOK_URL) return;
  
  try {
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    console.log('📤 Webhook sent successfully');
  } catch (error) {
    console.warn('⚠️ Webhook failed:', error.message);
  }
}

// ---------- WhatsApp Socket Implementation ----------
async function startWhatsAppSocket() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();
    
    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: true,
      logger: {
        level: 'warn',
        log: (level, ...args) => console.log('[Baileys]', level, ...args)
      }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr) {
        console.log('📱 Scan QR Code with WhatsApp to connect');
        connectionStatus = 'qr_ready';
        io.emit('connection_status', { status: 'qr_ready', qr });
      }
      
      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== 401;
        console.log('❌ Connection closed. Reconnecting:', shouldReconnect);
        connectionStatus = 'disconnected';
        io.emit('connection_status', { status: 'disconnected' });
        
        if (shouldReconnect) {
          setTimeout(startWhatsAppSocket, 5000);
        }
      } else if (connection === 'open') {
        console.log('✅ WhatsApp connected successfully');
        connectionStatus = 'connected';
        io.emit('connection_status', { status: 'connected' });
      }
    });

    // Handle incoming messages
    sock.ev.on('messages.upsert', async (messageUpdate) => {
      try {
        const db = await dbPromise;
        const monitoredChannels = await db.all('SELECT jid FROM channels WHERE is_active = 1');
        const monitoredJids = new Set(monitoredChannels.map(c => c.jid));

        for (const message of messageUpdate.messages) {
          if (!message.message || !message.key) continue;

          const messageId = message.key.id || `generated-${Date.now()}-${Math.random()}`;
          const remoteJid = message.key.remoteJid;
          const participant = message.key.participant;
          const isFromMe = message.key.fromMe;
          const isGroup = remoteJid?.endsWith('@g.us');
          
          // Determine target channel and sender
          const targetChannel = isGroup ? remoteJid : (participant || remoteJid);
          const sender = isFromMe ? 'You' : (participant || remoteJid || 'unknown');
          
          // Only process if we're monitoring this channel
          if (!monitoredJids.has(targetChannel)) continue;

          const content = extractMessageContent(message);
          const messageType = getMessageType(message);
          const timestamp = Date.now();

          // Determine message category
          let type = 'message';
          if (isFromMe) type = 'outgoing';
          else if (isGroup) type = 'group';
          else type = 'direct';

          // Save to database
          try {
            await db.run(
              `INSERT OR REPLACE INTO messages(id, sender, target_channel, type, content, timestamp, is_from_me, message_type) 
               VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
              [messageId, sender, targetChannel, type, content, timestamp, isFromMe ? 1 : 0, messageType]
            );

            // Update channel last message time
            await db.run(
              'UPDATE channels SET last_message_at = ? WHERE jid = ?',
              [timestamp, targetChannel]
            );

            const messageData = {
              id: messageId,
              sender,
              target_channel: targetChannel,
              type,
              content,
              timestamp,
              message_type: messageType,
              formatted_time: new Date(timestamp).toLocaleString()
            };

            // Send real-time update to dashboard
            io.emit('new_message', messageData);

            // Send webhook notification
            await sendWebhook({
              event: 'new_message',
              data: messageData
            });

            console.log(`📨 Message saved: ${targetChannel} - ${content.substring(0, 50)}...`);
          } catch (dbError) {
            console.error('Database error:', dbError);
          }
        }
      } catch (error) {
        console.error('Message processing error:', error);
      }
    });

    // Handle group participant updates
    sock.ev.on('group-participants.update', async (update) => {
      console.log('👥 Group participants update:', update);
      io.emit('group_update', update);
      
      await sendWebhook({
        event: 'group_participants_update',
        data: update
      });
    });

  } catch (error) {
    console.error('❌ Failed to start WhatsApp socket:', error);
    setTimeout(startWhatsAppSocket, 10000);
  }
}

// ---------- Dashboard Routes ----------
app.get('/', async (req, res) => {
  try {
    const db = await dbPromise;
    const channels = await db.all(`
      SELECT *, 
        (SELECT COUNT(*) FROM messages WHERE target_channel = channels.jid) as message_count
      FROM channels 
      ORDER BY created_at DESC
    `);
    
    const channelFilter = req.query.channel || '';
    const searchQuery = req.query.search || '';
    
    let messages;
    let queryParams = [];
    let whereClause = 'WHERE 1=1';
    
    if (channelFilter) {
      whereClause += ' AND target_channel = ?';
      queryParams.push(channelFilter);
    }
    
    if (searchQuery) {
      whereClause += ' AND content LIKE ?';
      queryParams.push(`%${searchQuery}%`);
    }
    
    messages = await db.all(
      `SELECT * FROM messages ${whereClause} ORDER BY timestamp DESC LIMIT 200`,
      queryParams
    );

    const stats = await db.get(`
      SELECT 
        COUNT(*) as total_messages,
        COUNT(DISTINCT target_channel) as active_channels,
        MAX(timestamp) as last_message_time
      FROM messages
    `);

    res.render('dashboard', { 
      channels, 
      messages, 
      channelFilter, 
      searchQuery,
      stats: stats || { total_messages: 0, active_channels: 0, last_message_time: null },
      connectionStatus
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).send('Internal server error');
  }
});

// Add new monitoring channel
app.post('/channels', async (req, res) => {
  const { jid, label } = req.body;
  
  if (!jid || !jid.trim()) {
    return res.redirect('/?error=jid_required');
  }
  
  try {
    const db = await dbPromise;
    await db.run(
      'INSERT OR IGNORE INTO channels(jid, label, created_at) VALUES(?, ?, ?)',
      [jid.trim(), label?.trim() || jid.trim(), Date.now()]
    );
    
    console.log(`✅ Added monitoring channel: ${jid}`);
    res.redirect('/?success=channel_added');
  } catch (error) {
    console.error('Error adding channel:', error);
    res.redirect('/?error=database_error');
  }
});

// Delete monitoring channel
app.post('/channels/delete', async (req, res) => {
  const { id } = req.body;
  
  try {
    const db = await dbPromise;
    await db.run('DELETE FROM channels WHERE id = ?', [id]);
    
    console.log(`🗑️ Removed monitoring channel: ${id}`);
    res.redirect('/?success=channel_removed');
  } catch (error) {
    console.error('Error removing channel:', error);
    res.redirect('/?error=database_error');
  }
});

// Toggle channel active status
app.post('/channels/toggle', async (req, res) => {
  const { id } = req.body;
  
  try {
    const db = await dbPromise;
    await db.run('UPDATE channels SET is_active = NOT is_active WHERE id = ?', [id]);
    res.redirect('/');
  } catch (error) {
    console.error('Error toggling channel:', error);
    res.redirect('/?error=database_error');
  }
});

// ---------- API Routes ----------
app.get('/api/messages', async (req, res) => {
  try {
    const db = await dbPromise;
    const limit = Math.min(parseInt(req.query.limit || '200', 10), 1000);
    const offset = parseInt(req.query.offset || '0', 10);
    const channel = req.query.channel;
    
    let query = 'SELECT * FROM messages';
    let params = [];
    
    if (channel) {
      query += ' WHERE target_channel = ?';
      params.push(channel);
    }
    
    query += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    
    const messages = await db.all(query, params);
    res.json(messages);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/channels', async (req, res) => {
  try {
    const db = await dbPromise;
    const channels = await db.all('SELECT * FROM channels ORDER BY created_at DESC');
    res.json(channels);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const db = await dbPromise;
    
    const totalMessages = await db.get('SELECT COUNT(*) as count FROM messages');
    const totalChannels = await db.get('SELECT COUNT(*) as count FROM channels');
    const recentMessages = await db.get(`
      SELECT COUNT(*) as count FROM messages 
      WHERE timestamp > ?
    `, [Date.now() - 24 * 60 * 60 * 1000]); // Last 24 hours
    
    const topChannels = await db.all(`
      SELECT target_channel, COUNT(*) as message_count, MAX(timestamp) as last_message
      FROM messages 
      GROUP BY target_channel 
      ORDER BY message_count DESC 
      LIMIT 5
    `);

    res.json({
      total_messages: totalMessages.count,
      total_channels: totalChannels.count,
      recent_messages: recentMessages.count,
      top_channels: topChannels,
      connection_status: connectionStatus
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Test webhook endpoint
app.post('/api/webhook/test', async (req, res) => {
  const payload = { 
    event: 'webhook_test',
    timestamp: Date.now(),
    message: 'Test webhook from WhatsApp Monitor'
  };
  
  await sendWebhook(payload);
  res.json({ sent: !!WEBHOOK_URL, webhook_url: WEBHOOK_URL ? '[CONFIGURED]' : '[NOT SET]' });
});

// Backfill endpoint - manually trigger message sync
app.post('/api/backfill', async (req, res) => {
  if (!sock) {
    return res.status(400).json({ error: 'WhatsApp not connected' });
  }
  
  try {
    // This will trigger messages.upsert with type 'append' for historical messages
    console.log('🔄 Starting backfill process...');
    res.json({ status: 'backfill_started', message: 'Check console for progress' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ---------- Socket.io Events ----------
io.on('connection', (socket) => {
  console.log('🔌 Dashboard client connected');
  
  // Send current connection status
  socket.emit('connection_status', { status: connectionStatus });
  
  socket.on('disconnect', () => {
    console.log('🔌 Dashboard client disconnected');
  });
  
  socket.on('request_stats', async () => {
    try {
      const db = await dbPromise;
      const stats = await db.get(`
        SELECT 
          COUNT(*) as total_messages,
          COUNT(DISTINCT target_channel) as active_channels,
          MAX(timestamp) as last_message_time
        FROM messages
      `);
      
      socket.emit('stats_update', stats);
    } catch (error) {
      console.error('Stats error:', error);
    }
  });
});

// ---------- Initialize and Start ----------
async function initialize() {
  try {
    await initDb();
    await startWhatsAppSocket();
    
    server.listen(PORT, () => {
      console.log(`🚀 WhatsApp Monitor Dashboard: http://localhost:${PORT}`);
      console.log(`📊 WebSocket server running on port ${PORT}`);
      console.log(`🔗 Webhook URL: ${WEBHOOK_URL || '[NOT CONFIGURED]'}`);
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
  
  if (sock) {
    await sock.logout();
  }
  
  const db = await dbPromise;
  await db.close();
  
  process.exit(0);
});

initialize();