import makeWASocket, { 
  fetchLatestBaileysVersion, 
  useMultiFileAuthState, 
  WASocket,
  proto,
  DisconnectReason
} from '@adiwajshing/baileys';
import { Boom } from '@hapi/boom';
import { Message } from '../types/index.js';
import { DatabaseManager } from './DatabaseManager.js';
import { MessageAnalyzer } from './MessageAnalyzer.js';
import { WebhookManager } from './WebhookManager.js';
import { PerformanceMonitor } from './PerformanceMonitor.js';
import { SecurityManager } from './SecurityManager.js';

export class WhatsAppManager {
  private sock: WASocket | null = null;
  private connectionStatus: string = 'disconnected';
  private readonly authDir: string;
  private readonly db: DatabaseManager;
  private readonly analyzer: MessageAnalyzer;
  private readonly webhook: WebhookManager;
  private readonly performanceMonitor: PerformanceMonitor;
  private readonly securityManager: SecurityManager;
  private readonly connectionStatusEmitter: (status: string) => void;
  
  private reconnectAttempts: number = 0;
  private readonly maxReconnectAttempts: number = 5;
  private monitoredChannels: Set<string> = new Set();
  private messageQueue: any[] = [];
  private isProcessingQueue: boolean = false;
  private readonly BATCH_SIZE = 50;
  private readonly QUEUE_PROCESS_INTERVAL = 1000; // 1 second
  private queueProcessor: NodeJS.Timer | null = null;

  constructor(
    authDir: string,
    db: DatabaseManager,
    analyzer: MessageAnalyzer,
    webhook: WebhookManager,
    performanceMonitor: PerformanceMonitor,
    securityManager: SecurityManager,
    connectionStatusEmitter: (status: string) => void
  ) {
    this.authDir = authDir;
    this.db = db;
    this.analyzer = analyzer;
    this.webhook = webhook;
    this.performanceMonitor = performanceMonitor;
    this.securityManager = securityManager;
    this.connectionStatusEmitter = connectionStatusEmitter;
  }

  async initialize(): Promise<void> {
    try {
      await this.loadMonitoredChannels();
      await this.startSocket();
      this.startQueueProcessor();
      console.log('✅ WhatsApp Manager initialized successfully');
    } catch (error) {
      console.error('❌ WhatsApp Manager initialization failed:', error);
      throw error;
    }
  }

  private async loadMonitoredChannels(): Promise<void> {
    try {
      const channels = await this.db.getChannels();
      this.monitoredChannels = new Set(
        channels.filter(c => c.is_active).map(c => c.jid)
      );
      console.log(`📋 Loaded ${this.monitoredChannels.size} monitored channels`);
    } catch (error) {
      console.error('❌ Failed to load monitored channels:', error);
      throw error;
    }
  }

  private async startSocket(): Promise<void> {
    try {
      const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
      const { version } = await fetchLatestBaileysVersion();

      this.sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true,
        logger: {
          level: 'warn',
          log: (level, ...args) => console.log('[Baileys]', level, ...args)
        },
        markOnlineOnConnect: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        getMessage: async (key) => {
          // Return undefined to avoid fetching old messages
          return undefined;
        }
      });

      this.setupEventHandlers();
      console.log('🔄 WhatsApp socket initialized');
    } catch (error) {
      console.error('❌ Failed to start WhatsApp socket:', error);
      await this.handleReconnection();
    }
  }

  private setupEventHandlers(): void {
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
        const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log('❌ Connection closed. Reconnecting:', shouldReconnect);
        this.connectionStatus = 'disconnected';
        this.connectionStatusEmitter('disconnected');

        if (shouldReconnect) {
          await this.handleReconnection();
        } else {
          console.log('🚫 Authentication failed. Please delete auth_info and restart.');
          await this.webhook.sendSystemAlert('authentication_failed', 'WhatsApp authentication failed', 'high');
        }
      } else if (connection === 'open') {
        console.log('✅ WhatsApp connected successfully');
        this.connectionStatus = 'connected';
        this.reconnectAttempts = 0;
        this.connectionStatusEmitter('connected');
        await this.db.recordMetric('connection_established', 1);
        await this.webhook.sendSystemAlert('connection_established', 'WhatsApp connection established', 'low');
      }
    });

    this.sock.ev.on('messages.upsert', async (messageUpdate) => {
      // Add messages to queue for batch processing
      this.messageQueue.push(...messageUpdate.messages);
      
      // Process immediately if queue is getting large
      if (this.messageQueue.length >= this.BATCH_SIZE) {
        await this.processMessageQueue();
      }
    });

    this.sock.ev.on('group-participants.update', async (update) => {
      try {
        console.log('👥 Group participants update:', update);
        await this.webhook.sendGroupUpdate(update);
        await this.db.recordMetric('group_updates', 1);
      } catch (error) {
        console.error('❌ Failed to handle group update:', error);
      }
    });
  }

  private startQueueProcessor(): void {
    this.queueProcessor = setInterval(async () => {
      if (this.messageQueue.length > 0 && !this.isProcessingQueue) {
        await this.processMessageQueue();
      }
    }, this.QUEUE_PROCESS_INTERVAL);
  }

  private async processMessageQueue(): Promise<void> {
    if (this.isProcessingQueue || this.messageQueue.length === 0) return;

    this.isProcessingQueue = true;
    const startTime = Date.now();
    
    try {
      const batch = this.messageQueue.splice(0, this.BATCH_SIZE);
      const processedMessages: Message[] = [];
      const alerts: any[] = [];

      // Process messages in parallel batches
      const batchPromises = batch.map(async (message) => {
        try {
          const messageData = this.extractMessageData(message);
          if (!messageData || !this.monitoredChannels.has(messageData.target_channel)) {
            return null;
          }

          // Analyze message for security threats
          const messageAlerts = await this.analyzer.analyzeMessage(messageData);
          
          return { messageData, alerts: messageAlerts };
        } catch (error) {
          console.error('❌ Failed to process individual message:', error);
          return null;
        }
      });

      const results = await Promise.allSettled(batchPromises);
      
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          processedMessages.push(result.value.messageData);
          alerts.push(...result.value.alerts);
        }
      }

      // Batch database operations
      if (processedMessages.length > 0) {
        await Promise.all([
          ...processedMessages.map(msg => this.db.saveMessage(msg)),
          ...alerts.map(alert => this.db.saveAlert(alert))
        ]);

        // Send webhooks for alerts
        for (const alert of alerts) {
          await this.webhook.sendAlert(alert);
        }

        // Send real-time updates (throttled)
        for (const message of processedMessages.slice(0, 10)) { // Limit real-time updates
          await this.webhook.sendMessage(message);
        }
      }

      // Record performance metrics
      const processingTime = Date.now() - startTime;
      await this.db.recordPerformance('message_batch_processing', processingTime, true);
      this.performanceMonitor.recordMetric('messages_processed', processedMessages.length);
      this.performanceMonitor.recordMetric('alerts_generated', alerts.length);

      if (processedMessages.length > 0) {
        console.log(`📨 Processed ${processedMessages.length} messages, generated ${alerts.length} alerts in ${processingTime}ms`);
      }
    } catch (error) {
      console.error('❌ Message queue processing error:', error);
      await this.db.recordPerformance('message_batch_processing', Date.now() - startTime, false);
      this.performanceMonitor.recordMetric('processing_errors', 1);
    } finally {
      this.isProcessingQueue = false;
    }
  }

  private extractMessageData(message: any): Message | null {
    try {
      if (!message.message || !message.key) return null;

      const messageId = message.key.id || `generated-${Date.now()}-${Math.random()}`;
      const remoteJid = message.key.remoteJid;
      const participant = message.key.participant;
      const isFromMe = message.key.fromMe;
      const isGroup = remoteJid?.endsWith('@g.us');

      // Determine target channel and sender
      const targetChannel = isGroup ? remoteJid : (participant || remoteJid);
      const sender = isFromMe ? 'You' : (participant || remoteJid || 'unknown');

      // Extract content and determine message type
      const content = this.extractMessageContent(message);
      const messageType = this.getMessageType(message);

      // Determine message category
      let type = 'message';
      if (isFromMe) type = 'outgoing';
      else if (isGroup) type = 'group';
      else type = 'direct';

      // Extract metadata
      const metadata = this.extractMessageMetadata(message);

      return {
        id: messageId,
        sender,
        target_channel: targetChannel,
        type: messageType,
        content,
        timestamp: message.messageTimestamp ? parseInt(message.messageTimestamp) * 1000 : Date.now(),
        is_from_me: isFromMe,
        message_type: type,
        metadata
      };
    } catch (error) {
      console.error('❌ Failed to extract message data:', error);
      return null;
    }
  }

  private extractMessageContent(message: any): string {
    if (!message.message) return '';

    try {
      return (
        message.message.conversation ||
        message.message.extendedTextMessage?.text ||
        message.message.imageMessage?.caption ||
        message.message.videoMessage?.caption ||
        message.message.documentMessage?.fileName ||
        message.message.audioMessage?.caption ||
        '[Media message]'
      ).toString();
    } catch (error) {
      return '[Error extracting content]';
    }
  }

  private getMessageType(message: any): Message['type'] {
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

  private extractMessageMetadata(message: any): Message['metadata'] | undefined {
    const metadata: any = {};

    try {
      if (message.message?.imageMessage) {
        metadata.file_size = message.message.imageMessage.fileLength;
        metadata.media_url = message.message.imageMessage.url;
        metadata.mime_type = message.message.imageMessage.mimetype;
      }

      if (message.message?.videoMessage) {
        metadata.file_size = message.message.videoMessage.fileLength;
        metadata.duration = message.message.videoMessage.seconds;
        metadata.media_url = message.message.videoMessage.url;
        metadata.mime_type = message.message.videoMessage.mimetype;
      }

      if (message.message?.audioMessage) {
        metadata.duration = message.message.audioMessage.seconds;
        metadata.file_size = message.message.audioMessage.fileLength;
        metadata.mime_type = message.message.audioMessage.mimetype;
      }

      if (message.message?.documentMessage) {
        metadata.file_size = message.message.documentMessage.fileLength;
        metadata.file_name = message.message.documentMessage.fileName;
        metadata.mime_type = message.message.documentMessage.mimetype;
      }

      if (message.message?.locationMessage) {
        metadata.location = {
          lat: message.message.locationMessage.degreesLatitude,
          lng: message.message.locationMessage.degreesLongitude
        };
      }

      return Object.keys(metadata).length > 0 ? metadata : undefined;
    } catch (error) {
      console.error('❌ Failed to extract metadata:', error);
      return undefined;
    }
  }

  private async handleReconnection(): Promise<void> {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('🚫 Max reconnection attempts reached. Manual intervention required.');
      await this.webhook.sendSystemAlert(
        'max_reconnection_attempts',
        'Maximum reconnection attempts reached',
        'high'
      );
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000); // Exponential backoff
    
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

  async addMonitoredChannel(jid: string): Promise<void> {
    try {
      this.monitoredChannels.add(jid);
      await this.db.recordMetric('channels_added', 1);
      console.log(`➕ Added channel to monitoring: ${jid}`);
    } catch (error) {
      console.error('❌ Failed to add monitored channel:', error);
      throw error;
    }
  }

  async removeMonitoredChannel(jid: string): Promise<void> {
    try {
      this.monitoredChannels.delete(jid);
      await this.db.recordMetric('channels_removed', 1);
      console.log(`➖ Removed channel from monitoring: ${jid}`);
    } catch (error) {
      console.error('❌ Failed to remove monitored channel:', error);
      throw error;
    }
  }

  getConnectionStatus(): string {
    return this.connectionStatus;
  }

  async sendMessage(jid: string, content: string): Promise<boolean> {
    if (!this.sock || this.connectionStatus !== 'connected') {
      console.error('❌ Cannot send message: WhatsApp not connected');
      return false;
    }

    // Security check
    if (!this.securityManager.validateMessageContent(content)) {
      console.error('❌ Message content failed security validation');
      return false;
    }

    try {
      const startTime = Date.now();
      await this.sock.sendMessage(jid, { text: content });
      
      await this.db.recordPerformance('send_message', Date.now() - startTime, true);
      console.log(`📤 Message sent to ${jid}`);
      return true;
    } catch (error) {
      console.error('❌ Failed to send message:', error);
      await this.db.recordPerformance('send_message', 0, false);
      return false;
    }
  }

  getQueueStats(): { pending: number; processing: boolean } {
    return {
      pending: this.messageQueue.length,
      processing: this.isProcessingQueue
    };
  }

  async cleanup(): Promise<void> {
    try {
      console.log('🧹 Cleaning up WhatsApp Manager...');
      
      if (this.queueProcessor) {
        clearInterval(this.queueProcessor);
        this.queueProcessor = null;
      }
      
      if (this.sock) {
        try {
          await this.sock.logout();
          console.log('✅ WhatsApp logged out successfully');
        } catch (error) {
          console.warn('⚠️ Error during logout:', error);
        }
      }
      
      this.analyzer.cleanupRateLimitData();
      this.messageQueue = [];
      this.monitoredChannels.clear();
      
      console.log('✅ WhatsApp Manager cleanup completed');
    } catch (error) {
      console.error('❌ WhatsApp Manager cleanup failed:', error);
    }
  }

  getManagerStats(): {
    connection_status: string;
    monitored_channels: number;
    queue_size: number;
    reconnect_attempts: number;
  } {
    return {
      connection_status: this.connectionStatus,
      monitored_channels: this.monitoredChannels.size,
      queue_size: this.messageQueue.length,
      reconnect_attempts: this.reconnectAttempts
    };
  }
}