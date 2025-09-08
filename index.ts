import makeWASocket, { fetchLatestBaileysVersion, useMultiFileAuthState, DisconnectReason } from '@adiwajshing/baileys';
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

// Import our services
import { DatabaseManager } from './src/services/DatabaseManager.js';
import { MessageAnalyzer } from './src/services/MessageAnalyzer.js';
import { WebhookManager } from './src/services/WebhookManager.js';
import { WhatsAppManager } from './src/services/WhatsAppManager.js';
import { PerformanceMonitor } from './src/services/PerformanceMonitor.js';
import { SecurityManager } from './src/services/SecurityManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- Configuration ----------
const CONFIG = {
  AUTH_DIR: './auth_info',
  DB_FILE: './whatsapp_data.db',
  PORT: parseInt(process.env.PORT || '3000'),
  WEBHOOK_URL: process.env.WEBHOOK_URL || '',
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  MAX_MESSAGE_BATCH_SIZE: 100,
  CLEANUP_INTERVAL: 60 * 60 * 1000, // 1 hour
  RATE_LIMIT_WINDOW: 15 * 60 * 1000, // 15 minutes
  RATE_LIMIT_MAX: 100 // requests per window
};

// ---------- Express + Socket.io Setup ----------
const app = express();
const server = http.createServer(app);
const io = new IOServer(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling']
});

// ---------- Security Middleware ----------
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
  windowMs: CONFIG.RATE_LIMIT_WINDOW,
  max: CONFIG.RATE_LIMIT_MAX,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/', limiter);

// Body parsing with size limits
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Static files and view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Service Initialization ----------
const dbManager = new DatabaseManager(CONFIG.DB_FILE);
const performanceMonitor = new PerformanceMonitor();
const messageAnalyzer = new MessageAnalyzer(performanceMonitor);
const webhookManager = new WebhookManager(CONFIG.WEBHOOK_URL);
const securityManager = new SecurityManager();

let whatsappManager: WhatsAppManager;

// Global connection status emitter
let connectionStatusEmitter: (status: string) => void;

// ---------- Validation Middleware ----------
const validateChannelInput = [
  body('jid')
    .trim()
    .isLength({ min: 10, max: 100 })
    .matches(/^[\w\d@.-]+$/)
    .withMessage('Invalid JID format'),
  body('label')
    .optional()
    .trim()
    .isLength({ max: 100 })
    .escape()
];

const validateMessageInput = [
  body('jid')
    .trim()
    .isLength({ min: 10, max: 100 })
    .matches(/^[\w\d@.-]+$/),
  body('message')
    .trim()
    .isLength({ min: 1, max: 4096 })
    .escape()
];

// ---------- Error Handling Middleware ----------
const asyncHandler = (fn: Function) => (req: any, res: any, next: any) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

const errorHandler = (err: any, req: any, res: any, next: any) => {
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

// ---------- Dashboard Routes ----------
app.get('/', asyncHandler(async (req: any, res: any) => {
  const startTime = Date.now();
  
  try {
    const [channels, messages, stats, alerts] = await Promise.all([
      dbManager.getChannels(),
      dbManager.getMessages({
        channel: req.query.channel as string,
        search: req.query.search as string,
        limit: 200
      }),
      dbManager.getSystemStats(),
      dbManager.getAlerts({ resolved: false, limit: 10 })
    ]);

    const enhancedStats = {
      ...stats,
      connection_status: whatsappManager?.getConnectionStatus() || 'disconnected',
      uptime: performanceMonitor.getUptime(),
      memory_usage: performanceMonitor.getMemoryUsage(),
      processing_rate: performanceMonitor.getProcessingRate()
    };

    res.render('dashboard', { 
      channels, 
      messages, 
      alerts,
      channelFilter: req.query.channel || '', 
      searchQuery: req.query.search || '',
      stats: enhancedStats,
      connectionStatus: whatsappManager?.getConnectionStatus() || 'disconnected'
    });

    performanceMonitor.recordMetric('dashboard_render_time', Date.now() - startTime);
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).render('error', { 
      error: 'Dashboard Error',
      message: 'Failed to load dashboard data'
    });
  }
}));

// Add new monitoring channel
app.post('/channels', validateChannelInput, asyncHandler(async (req: any, res: any) => {
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
app.post('/channels/delete', asyncHandler(async (req: any, res: any) => {
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

// ---------- API Routes ----------
app.get('/api/messages', asyncHandler(async (req: any, res: any) => {
  const limit = Math.min(parseInt(req.query.limit || '200', 10), 1000);
  const offset = parseInt(req.query.offset || '0', 10);
  const channel = req.query.channel;
  
  const messages = await dbManager.getMessages({
    channel: channel as string,
    limit,
    offset
  });
  
  res.json(messages);
}));

app.get('/api/channels', asyncHandler(async (req: any, res: any) => {
  const channels = await dbManager.getChannels();
  res.json(channels);
}));

app.get('/api/stats', asyncHandler(async (req: any, res: any) => {
  const stats = await dbManager.getSystemStats();
  const enhancedStats = {
    ...stats,
    connection_status: whatsappManager?.getConnectionStatus() || 'disconnected',
    uptime: performanceMonitor.getUptime(),
    memory_usage: performanceMonitor.getMemoryUsage(),
    processing_rate: performanceMonitor.getProcessingRate()
  };
  res.json(enhancedStats);
}));

app.get('/api/alerts', asyncHandler(async (req: any, res: any) => {
  const resolved = req.query.resolved === 'true';
  const severity = req.query.severity as string;
  const limit = parseInt(req.query.limit || '50', 10);
  
  const alerts = await dbManager.getAlerts({ resolved, severity, limit });
  res.json(alerts);
}));

app.post('/api/webhook/test', asyncHandler(async (req: any, res: any) => {
  const result = await webhookManager.testWebhook();
  res.json(result);
}));

app.post('/api/send', validateMessageInput, asyncHandler(async (req: any, res: any) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Invalid input', details: errors.array() });
  }

  const { jid, message } = req.body;
  
  try {
    const success = await whatsappManager?.sendMessage(jid, message);
    res.json({ success, message: success ? 'Message sent' : 'Failed to send message' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to send message' });
  }
}));

// Health check endpoint
app.get('/health', asyncHandler(async (req: any, res: any) => {
  const health = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: performanceMonitor.getUptime(),
    memory: performanceMonitor.getMemoryUsage(),
    connection: whatsappManager?.getConnectionStatus() || 'disconnected',
    database: 'connected'
  };
  
  res.json(health);
}));

// ---------- Socket.io Events ----------
io.on('connection', (socket) => {
  console.log('🔌 Dashboard client connected');
  
  // Send current connection status
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
        connection_status: whatsappManager?.getConnectionStatus() || 'disconnected',
        uptime: performanceMonitor.getUptime(),
        memory_usage: performanceMonitor.getMemoryUsage(),
        processing_rate: performanceMonitor.getProcessingRate()
      };
      socket.emit('stats_update', enhancedStats);
    } catch (error) {
      console.error('Stats error:', error);
    }
  }));
});

// Set up connection status emitter
connectionStatusEmitter = (status: string) => {
  io.emit('connection_status', { status });
};

// Error handling middleware
app.use(errorHandler);

// ---------- Initialize and Start ----------
async function initialize() {
  try {
    console.log('🚀 Initializing WhatsApp Monitor System...');
    
    // Initialize services in correct order
    await dbManager.initialize();
    console.log('✅ Database initialized');
    
    // Initialize WhatsApp manager with all dependencies
    whatsappManager = new WhatsAppManager(
      CONFIG.AUTH_DIR,
      dbManager,
      messageAnalyzer,
      webhookManager,
      performanceMonitor,
      securityManager,
      connectionStatusEmitter
    );
    
    await whatsappManager.initialize();
    console.log('✅ WhatsApp manager initialized');
    
    // Start performance monitoring
    performanceMonitor.startMonitoring();
    console.log('✅ Performance monitoring started');
    
    // Set up periodic cleanup
    setInterval(async () => {
      try {
        await dbManager.cleanup();
        messageAnalyzer.cleanupRateLimitData();
        performanceMonitor.cleanup();
        console.log('🧹 Periodic cleanup completed');
      } catch (error) {
        console.error('❌ Cleanup error:', error);
      }
    }, CONFIG.CLEANUP_INTERVAL);
    
    server.listen(CONFIG.PORT, () => {
      console.log(`🚀 WhatsApp Monitor Dashboard: http://localhost:${CONFIG.PORT}`);
      console.log(`📊 WebSocket server running on port ${CONFIG.PORT}`);
      console.log(`🔗 Webhook URL: ${CONFIG.WEBHOOK_URL || '[NOT CONFIGURED]'}`);
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
    performanceMonitor.stop();
    
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