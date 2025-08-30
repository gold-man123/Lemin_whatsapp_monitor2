# WhatsApp Monitor Dashboard

A comprehensive, production-ready WhatsApp monitoring system built with Baileys, featuring real-time message tracking, web dashboard, and webhook notifications.

## ⚠️ Legal & Security Notice

**IMPORTANT**: This system should only be used to monitor WhatsApp accounts you own or have explicit permission to monitor. Unauthorized monitoring may violate WhatsApp's Terms of Service and local privacy laws. Use responsibly and ethically.

## Features

- 🔄 Real-time WhatsApp message monitoring via Baileys
- 💾 SQLite database for persistent message storage
- 🌐 Modern web dashboard for channel management
- ⚡ Live notifications via WebSocket
- 🔗 Webhook integration for external alerts
- 📊 Message statistics and filtering
- 🔍 Search and filter capabilities
- 📱 Mobile-responsive design

## Prerequisites

- Node.js 16+ 
- WhatsApp account for linking
- Network access for WhatsApp Web protocol

## Quick Start

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Start the application**:
   ```bash
   npm start
   ```

3. **Connect WhatsApp**:
   - Open terminal output and scan the QR code with WhatsApp
   - Go to WhatsApp > Settings > Linked Devices > Link a Device
   - Scan the QR code displayed in terminal

4. **Access Dashboard**:
   - Open browser to `http://localhost:3000`
   - Add channels to monitor using their JID
   - Start receiving real-time message updates

## Configuration

### Environment Variables

Create a `.env` file (optional):

```env
PORT=3000
WEBHOOK_URL=https://your-webhook-endpoint.com/whatsapp-alerts
```

### Finding Channel JIDs

- **Group chats**: Usually end with `@g.us` (e.g., `120363123456@g.us`)
- **Individual chats**: Phone number + `@s.whatsapp.net` (e.g., `1234567890@s.whatsapp.net`)
- **Use WhatsApp Web developer tools** to inspect network requests for exact JIDs

## API Endpoints

### Messages
- `GET /api/messages` - Retrieve messages (supports limit, offset, channel filters)
- `GET /api/stats` - Get system statistics

### Channels
- `GET /api/channels` - List all monitored channels
- `POST /channels` - Add new monitoring channel
- `POST /channels/delete` - Remove monitoring channel

### Webhooks
- `POST /api/webhook/test` - Test webhook configuration

## Database Schema

### Channels Table
```sql
CREATE TABLE channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jid TEXT UNIQUE NOT NULL,
  label TEXT NOT NULL,
  is_active INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_message_at INTEGER
);
```

### Messages Table
```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  sender TEXT NOT NULL,
  target_channel TEXT NOT NULL,
  type TEXT NOT NULL,
  content TEXT,
  timestamp INTEGER NOT NULL,
  is_from_me INTEGER DEFAULT 0,
  message_type TEXT DEFAULT 'text'
);
```

## Advanced Features (Roadmap)

### 1. ML-Based Message Classification
- Implement TF-IDF + Logistic Regression for spam detection
- Train models on labeled datasets for report classification
- Real-time message scoring and alerting

### 2. Anomaly Detection
- Rate-limit detection for unusual message volumes
- Spike detection for coordinated attacks
- Integration with Elastic ML or custom algorithms

### 3. Network Analysis
- Social network analysis of message patterns
- Identification of coordinated behavior
- Graph-based relationship mapping

### 4. Enhanced Analytics
- Time-series analysis with Grafana
- Custom dashboards for different stakeholders
- Automated reporting and insights

### 5. Multi-Platform Integration
- Cross-platform monitoring (Telegram, Twitter)
- Unified threat intelligence
- Coordinated response capabilities

## Security Considerations

- All authentication data is stored locally in `auth_info/`
- Database contains only message metadata and content you have access to
- No password storage or credential harvesting
- Respects WhatsApp's E2E encryption (only monitors accessible content)

## Troubleshooting

### Connection Issues
- Ensure stable internet connection
- Check if WhatsApp Web is accessible
- Verify QR code scanning was successful
- Check terminal output for error messages

### Database Issues
- Ensure write permissions in project directory
- Check SQLite installation and compatibility
- Monitor disk space for database growth

### Performance
- Consider database cleanup for large message volumes
- Implement message archiving for long-term storage
- Monitor memory usage with many active channels

## Contributing

This project is designed for legitimate monitoring use cases. Contributions should maintain ethical standards and respect privacy laws.

## License

Use at your own risk. Ensure compliance with local laws and WhatsApp Terms of Service.