import { Message, Alert } from '../types/index.js';

export class MessageAnalyzer {
  private spamKeywords: Set<string>;
  private suspiciousPatterns: RegExp[];
  private rateLimitMap: Map<string, number[]>;
  private readonly RATE_LIMIT_WINDOW = 60000; // 1 minute
  private readonly RATE_LIMIT_THRESHOLD = 10; // messages per minute

  constructor() {
    this.spamKeywords = new Set([
      'spam', 'scam', 'fake', 'fraud', 'phishing', 'virus', 'malware',
      'click here', 'urgent', 'limited time', 'act now', 'free money',
      'congratulations', 'winner', 'lottery', 'prize'
    ]);

    this.suspiciousPatterns = [
      /https?:\/\/[^\s]+/gi, // URLs
      /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, // Credit card patterns
      /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, // Phone numbers
      /[A-Z]{3,}\s+[A-Z]{3,}/g, // All caps words
      /(.)\1{4,}/g // Repeated characters
    ];

    this.rateLimitMap = new Map();
  }

  analyzeMessage(message: Message): Alert[] {
    const alerts: Alert[] = [];
    const now = Date.now();

    // 1. Spam keyword detection
    const spamScore = this.detectSpamKeywords(message.content);
    if (spamScore > 0.3) {
      alerts.push({
        id: `spam_${message.id}_${now}`,
        type: 'spam_detected',
        severity: spamScore > 0.7 ? 'high' : 'medium',
        channel_jid: message.target_channel,
        message_id: message.id,
        description: `Spam detected with confidence ${(spamScore * 100).toFixed(1)}%`,
        timestamp: now,
        is_resolved: false
      });
    }

    // 2. Rate limit detection
    if (this.checkRateLimit(message.sender)) {
      alerts.push({
        id: `rate_${message.sender}_${now}`,
        type: 'rate_limit_exceeded',
        severity: 'medium',
        channel_jid: message.target_channel,
        message_id: message.id,
        description: `Rate limit exceeded: ${this.RATE_LIMIT_THRESHOLD} messages/minute`,
        timestamp: now,
        is_resolved: false
      });
    }

    // 3. Suspicious pattern detection
    const suspiciousPatterns = this.detectSuspiciousPatterns(message.content);
    if (suspiciousPatterns.length > 0) {
      alerts.push({
        id: `pattern_${message.id}_${now}`,
        type: 'suspicious_pattern',
        severity: 'medium',
        channel_jid: message.target_channel,
        message_id: message.id,
        description: `Suspicious patterns detected: ${suspiciousPatterns.join(', ')}`,
        timestamp: now,
        is_resolved: false
      });
    }

    return alerts;
  }

  private detectSpamKeywords(content: string): number {
    const words = content.toLowerCase().split(/\s+/);
    const spamWords = words.filter(word => this.spamKeywords.has(word));
    return spamWords.length / Math.max(words.length, 1);
  }

  private checkRateLimit(sender: string): boolean {
    const now = Date.now();
    const timestamps = this.rateLimitMap.get(sender) || [];
    
    // Remove old timestamps outside the window
    const recentTimestamps = timestamps.filter(ts => now - ts < this.RATE_LIMIT_WINDOW);
    recentTimestamps.push(now);
    
    this.rateLimitMap.set(sender, recentTimestamps);
    
    return recentTimestamps.length > this.RATE_LIMIT_THRESHOLD;
  }

  private detectSuspiciousPatterns(content: string): string[] {
    const patterns: string[] = [];
    
    for (const pattern of this.suspiciousPatterns) {
      if (pattern.test(content)) {
        patterns.push(pattern.source);
      }
    }
    
    return patterns;
  }

  // Clean up old rate limit data
  cleanupRateLimitData(): void {
    const now = Date.now();
    for (const [sender, timestamps] of this.rateLimitMap.entries()) {
      const recentTimestamps = timestamps.filter(ts => now - ts < this.RATE_LIMIT_WINDOW);
      if (recentTimestamps.length === 0) {
        this.rateLimitMap.delete(sender);
      } else {
        this.rateLimitMap.set(sender, recentTimestamps);
      }
    }
  }
}