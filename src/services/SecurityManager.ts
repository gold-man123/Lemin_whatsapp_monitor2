export class SecurityManager {
  private readonly maxMessageLength: number = 4096;
  private readonly maxUrlsPerMessage: number = 3;
  private readonly suspiciousKeywords: Set<string>;
  private readonly blockedDomains: Set<string>;
  private readonly rateLimitMap: Map<string, { count: number; resetTime: number }> = new Map();
  private readonly RATE_LIMIT_WINDOW = 60000; // 1 minute
  private readonly RATE_LIMIT_MAX = 20; // requests per minute

  constructor() {
    this.suspiciousKeywords = new Set([
      'password', 'login', 'verify', 'confirm', 'click here', 'download',
      'install', 'update required', 'security alert', 'account suspended'
    ]);

    this.blockedDomains = new Set([
      'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly',
      'short.link', 'tiny.cc', 'is.gd', 'buff.ly'
    ]);
  }

  validateMessageContent(content: string): boolean {
    try {
      // Length validation
      if (content.length > this.maxMessageLength) {
        console.warn('⚠️ Message content exceeds maximum length');
        return false;
      }

      // URL count validation
      const urls = content.match(/https?:\/\/[^\s]+/gi) || [];
      if (urls.length > this.maxUrlsPerMessage) {
        console.warn('⚠️ Message contains too many URLs');
        return false;
      }

      // Blocked domain check
      for (const url of urls) {
        try {
          const domain = new URL(url).hostname;
          if (this.blockedDomains.has(domain)) {
            console.warn(`⚠️ Message contains blocked domain: ${domain}`);
            return false;
          }
        } catch (error) {
          // Invalid URL format
          console.warn('⚠️ Message contains invalid URL format');
          return false;
        }
      }

      // Suspicious keyword density check
      const words = content.toLowerCase().split(/\s+/);
      const suspiciousWords = words.filter(word => this.suspiciousKeywords.has(word));
      const suspiciousRatio = suspiciousWords.length / Math.max(words.length, 1);
      
      if (suspiciousRatio > 0.3) {
        console.warn('⚠️ Message contains high density of suspicious keywords');
        return false;
      }

      return true;
    } catch (error) {
      console.error('❌ Content validation error:', error);
      return false;
    }
  }

  validateJid(jid: string): boolean {
    try {
      // Basic JID format validation
      const jidPattern = /^[\w\d.-]+@(s\.whatsapp\.net|g\.us)$/;
      return jidPattern.test(jid);
    } catch (error) {
      return false;
    }
  }

  sanitizeInput(input: string): string {
    return input
      .replace(/[<>]/g, '') // Remove potential HTML tags
      .replace(/javascript:/gi, '') // Remove javascript: protocols
      .replace(/data:/gi, '') // Remove data: protocols
      .trim();
  }

  checkRateLimit(identifier: string): { allowed: boolean; remaining: number; resetTime: number } {
    const now = Date.now();
    const entry = this.rateLimitMap.get(identifier);

    if (!entry || now > entry.resetTime) {
      // Reset or create new entry
      this.rateLimitMap.set(identifier, {
        count: 1,
        resetTime: now + this.RATE_LIMIT_WINDOW
      });
      return {
        allowed: true,
        remaining: this.RATE_LIMIT_MAX - 1,
        resetTime: now + this.RATE_LIMIT_WINDOW
      };
    }

    entry.count++;
    const allowed = entry.count <= this.RATE_LIMIT_MAX;
    const remaining = Math.max(0, this.RATE_LIMIT_MAX - entry.count);

    return {
      allowed,
      remaining,
      resetTime: entry.resetTime
    };
  }

  validateChannelData(data: any): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!data.jid || typeof data.jid !== 'string') {
      errors.push('JID is required and must be a string');
    } else if (!this.validateJid(data.jid)) {
      errors.push('Invalid JID format');
    }

    if (data.label && typeof data.label !== 'string') {
      errors.push('Label must be a string');
    }

    if (data.label && data.label.length > 100) {
      errors.push('Label must be less than 100 characters');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  detectSuspiciousActivity(messages: any[]): {
    suspicious: boolean;
    reasons: string[];
    riskScore: number;
  } {
    const reasons: string[] = [];
    let riskScore = 0;

    // Check for rapid message sending
    if (messages.length > 10) {
      const timeSpan = messages[0].timestamp - messages[messages.length - 1].timestamp;
      if (timeSpan < 60000) { // Less than 1 minute
        reasons.push('rapid_messaging');
        riskScore += 0.3;
      }
    }

    // Check for identical content
    const contentMap = new Map<string, number>();
    for (const msg of messages) {
      const count = contentMap.get(msg.content) || 0;
      contentMap.set(msg.content, count + 1);
    }

    for (const [content, count] of contentMap.entries()) {
      if (count > 3) {
        reasons.push('repeated_content');
        riskScore += 0.2;
        break;
      }
    }

    // Check for suspicious timing patterns
    const hours = messages.map(msg => new Date(msg.timestamp).getHours());
    const nightMessages = hours.filter(hour => hour < 6 || hour > 23).length;
    if (nightMessages / messages.length > 0.5) {
      reasons.push('unusual_timing');
      riskScore += 0.1;
    }

    return {
      suspicious: riskScore > 0.3,
      reasons,
      riskScore: Math.min(riskScore, 1)
    };
  }

  cleanup(): void {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [identifier, entry] of this.rateLimitMap.entries()) {
      if (now > entry.resetTime) {
        this.rateLimitMap.delete(identifier);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      console.log(`🧹 Cleaned ${cleanedCount} expired rate limit entries`);
    }
  }

  getSecurityStats(): {
    rate_limit_entries: number;
    blocked_domains: number;
    suspicious_keywords: number;
    validation_errors: number;
  } {
    return {
      rate_limit_entries: this.rateLimitMap.size,
      blocked_domains: this.blockedDomains.size,
      suspicious_keywords: this.suspiciousKeywords.size,
      validation_errors: 0 // This would be tracked separately in a real implementation
    };
  }
}