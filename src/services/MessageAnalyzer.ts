import { Message, Alert } from '../types/index';
import { PerformanceMonitor } from './PerformanceMonitor';

export class MessageAnalyzer {
  private spamKeywords: Set<string>;
  private suspiciousPatterns: RegExp[];
  private rateLimitMap: Map<string, number[]>;
  private contentCache: Map<string, number>;
  private performanceMonitor: PerformanceMonitor;
  
  private readonly RATE_LIMIT_WINDOW = 60000; // 1 minute
  private readonly RATE_LIMIT_THRESHOLD = 10; // messages per minute
  private readonly SPAM_THRESHOLD = 0.3;
  private readonly HIGH_RISK_THRESHOLD = 0.7;
  private readonly CACHE_SIZE_LIMIT = 10000;

  constructor(performanceMonitor?: PerformanceMonitor) {
    this.performanceMonitor = performanceMonitor || new PerformanceMonitor();
    this.initializeDetectionSystems();
    this.rateLimitMap = new Map();
    this.contentCache = new Map();
  }

  private initializeDetectionSystems(): void {
    // Enhanced spam keyword detection
    this.spamKeywords = new Set([
      // Financial scams
      'free money', 'easy money', 'get rich quick', 'investment opportunity',
      'guaranteed profit', 'no risk', 'double your money', 'financial freedom',
      
      // Phishing attempts
      'verify account', 'suspended account', 'click here now', 'urgent action required',
      'confirm identity', 'update payment', 'security alert', 'account locked',
      
      // General spam
      'congratulations', 'winner', 'lottery', 'prize', 'claim now', 'limited time',
      'act fast', 'exclusive offer', 'special deal', 'once in lifetime',
      
      // Malicious content
      'download now', 'install app', 'click link', 'visit site', 'open attachment',
      'virus', 'malware', 'hack', 'crack', 'illegal', 'pirated',
      
      // Social engineering
      'help me', 'emergency', 'urgent help', 'send money', 'transfer funds',
      'family emergency', 'hospital bills', 'stranded abroad'
    ]);

    // Advanced suspicious patterns
    this.suspiciousPatterns = [
      // URLs and links
      /https?:\/\/[^\s]+/gi,
      /bit\.ly\/[^\s]+/gi,
      /tinyurl\.com\/[^\s]+/gi,
      /t\.co\/[^\s]+/gi,
      
      // Financial patterns
      /\$\d+(?:,\d{3})*(?:\.\d{2})?/g, // Money amounts
      /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, // Credit card patterns
      /\b\d{3}[-.]?\d{2}[-.]?\d{4}\b/g, // SSN patterns
      
      // Communication patterns
      /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, // Phone numbers
      /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, // Email addresses
      
      // Suspicious formatting
      /[A-Z]{5,}/g, // Excessive caps
      /(.)\1{4,}/g, // Repeated characters
      /[!]{3,}/g, // Multiple exclamation marks
      /[\$€£¥₹]{2,}/g, // Multiple currency symbols
      
      // Cryptocurrency patterns
      /\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b/g, // Bitcoin addresses
      /\b0x[a-fA-F0-9]{40}\b/g, // Ethereum addresses
      
      // Social media handles
      /@[a-zA-Z0-9_]+/g,
      /#[a-zA-Z0-9_]+/g
    ];
  }

  async analyzeMessage(message: Message): Promise<Alert[]> {
    const startTime = Date.now();
    const alerts: Alert[] = [];
    
    try {
      // 1. Content deduplication check
      const contentHash = this.generateContentHash(message.content);
      if (this.isDuplicateContent(contentHash)) {
        alerts.push(this.createAlert(
          'duplicate_content',
          'medium',
          message,
          'Duplicate content detected - possible spam campaign'
        ));
      }

      // 2. Advanced spam detection
      const spamAnalysis = this.performSpamAnalysis(message.content);
      if (spamAnalysis.score > this.SPAM_THRESHOLD) {
        alerts.push(this.createAlert(
          'spam_detected',
          spamAnalysis.score > this.HIGH_RISK_THRESHOLD ? 'high' : 'medium',
          message,
          `Spam detected (${(spamAnalysis.score * 100).toFixed(1)}%): ${spamAnalysis.reasons.join(', ')}`,
          { spam_score: spamAnalysis.score, reasons: spamAnalysis.reasons }
        ));
      }

      // 3. Rate limit detection with sender profiling
      const rateLimitResult = this.checkAdvancedRateLimit(message.sender, message.timestamp);
      if (rateLimitResult.exceeded) {
        alerts.push(this.createAlert(
          'rate_limit_exceeded',
          rateLimitResult.severity,
          message,
          `Rate limit exceeded: ${rateLimitResult.count} messages in ${rateLimitResult.window}ms`,
          { message_count: rateLimitResult.count, window: rateLimitResult.window }
        ));
      }

      // 4. Suspicious pattern detection
      const patternAnalysis = this.detectAdvancedPatterns(message.content);
      if (patternAnalysis.patterns.length > 0) {
        alerts.push(this.createAlert(
          'suspicious_pattern',
          patternAnalysis.severity,
          message,
          `Suspicious patterns: ${patternAnalysis.patterns.join(', ')}`,
          { patterns: patternAnalysis.patterns, confidence: patternAnalysis.confidence }
        ));
      }

      // 5. Behavioral anomaly detection
      const behaviorAnalysis = this.analyzeBehavior(message);
      if (behaviorAnalysis.anomalies.length > 0) {
        alerts.push(this.createAlert(
          'behavioral_anomaly',
          behaviorAnalysis.severity,
          message,
          `Behavioral anomalies: ${behaviorAnalysis.anomalies.join(', ')}`,
          { anomalies: behaviorAnalysis.anomalies }
        ));
      }

      // 6. Content risk scoring
      message.risk_score = this.calculateRiskScore(message, alerts);

      // Record performance metrics
      this.performanceMonitor.recordMetric('message_analysis_time', Date.now() - startTime);
      this.performanceMonitor.recordMetric('alerts_generated', alerts.length);

      return alerts;
    } catch (error) {
      console.error('❌ Message analysis failed:', error);
      this.performanceMonitor.recordMetric('analysis_errors', 1);
      return [];
    }
  }

  private performSpamAnalysis(content: string): { score: number; reasons: string[] } {
    const reasons: string[] = [];
    let score = 0;

    // Keyword analysis
    const words = content.toLowerCase().split(/\s+/);
    const spamWords = words.filter(word => this.spamKeywords.has(word));
    if (spamWords.length > 0) {
      const keywordScore = spamWords.length / Math.max(words.length, 1);
      score += keywordScore * 0.4;
      reasons.push(`spam keywords: ${spamWords.join(', ')}`);
    }

    // Length analysis
    if (content.length > 1000) {
      score += 0.2;
      reasons.push('excessive length');
    }

    // Repetition analysis
    const repetitionScore = this.analyzeRepetition(content);
    if (repetitionScore > 0.3) {
      score += repetitionScore * 0.3;
      reasons.push('repetitive content');
    }

    // URL density
    const urlMatches = content.match(/https?:\/\/[^\s]+/gi) || [];
    if (urlMatches.length > 2) {
      score += Math.min(urlMatches.length * 0.1, 0.3);
      reasons.push('multiple URLs');
    }

    // Caps lock abuse
    const capsRatio = (content.match(/[A-Z]/g) || []).length / content.length;
    if (capsRatio > 0.5 && content.length > 20) {
      score += 0.2;
      reasons.push('excessive caps');
    }

    return { score: Math.min(score, 1), reasons };
  }

  private checkAdvancedRateLimit(sender: string, timestamp: number): {
    exceeded: boolean;
    count: number;
    window: number;
    severity: 'low' | 'medium' | 'high';
  } {
    const now = timestamp;
    const timestamps = this.rateLimitMap.get(sender) || [];
    
    // Remove old timestamps outside the window
    const recentTimestamps = timestamps.filter(ts => now - ts < this.RATE_LIMIT_WINDOW);
    recentTimestamps.push(now);
    
    this.rateLimitMap.set(sender, recentTimestamps);
    
    const count = recentTimestamps.length;
    const exceeded = count > this.RATE_LIMIT_THRESHOLD;
    
    let severity: 'low' | 'medium' | 'high' = 'low';
    if (count > this.RATE_LIMIT_THRESHOLD * 3) severity = 'high';
    else if (count > this.RATE_LIMIT_THRESHOLD * 2) severity = 'medium';
    
    return {
      exceeded,
      count,
      window: this.RATE_LIMIT_WINDOW,
      severity
    };
  }

  private detectAdvancedPatterns(content: string): {
    patterns: string[];
    confidence: number;
    severity: 'low' | 'medium' | 'high';
  } {
    const detectedPatterns: string[] = [];
    let confidence = 0;

    for (const pattern of this.suspiciousPatterns) {
      const matches = content.match(pattern);
      if (matches) {
        detectedPatterns.push(this.getPatternDescription(pattern));
        confidence += matches.length * 0.1;
      }
    }

    const severity = confidence > 0.7 ? 'high' : confidence > 0.3 ? 'medium' : 'low';
    
    return {
      patterns: detectedPatterns,
      confidence: Math.min(confidence, 1),
      severity
    };
  }

  private analyzeBehavior(message: Message): {
    anomalies: string[];
    severity: 'low' | 'medium' | 'high';
  } {
    const anomalies: string[] = [];

    // Time-based anomalies
    const hour = new Date(message.timestamp).getHours();
    if (hour < 6 || hour > 23) {
      anomalies.push('unusual_time');
    }

    // Content length anomalies
    if (message.content.length > 2000) {
      anomalies.push('excessive_length');
    }

    // Media type anomalies
    if (message.type !== 'text' && message.content.includes('http')) {
      anomalies.push('media_with_links');
    }

    const severity = anomalies.length > 2 ? 'high' : anomalies.length > 0 ? 'medium' : 'low';
    
    return { anomalies, severity };
  }

  private calculateRiskScore(message: Message, alerts: Alert[]): number {
    let riskScore = 0;

    // Base risk from alerts
    for (const alert of alerts) {
      switch (alert.severity) {
        case 'critical': riskScore += 0.4; break;
        case 'high': riskScore += 0.3; break;
        case 'medium': riskScore += 0.2; break;
        case 'low': riskScore += 0.1; break;
      }
    }

    // Content-based risk factors
    if (message.content.length > 1000) riskScore += 0.1;
    if (message.type !== 'text') riskScore += 0.05;
    if (!message.is_from_me && message.content.includes('http')) riskScore += 0.15;

    return Math.min(riskScore, 1);
  }

  private analyzeRepetition(content: string): number {
    const words = content.toLowerCase().split(/\s+/);
    const wordCount = new Map<string, number>();
    
    for (const word of words) {
      wordCount.set(word, (wordCount.get(word) || 0) + 1);
    }
    
    let repetitionScore = 0;
    for (const count of wordCount.values()) {
      if (count > 3) {
        repetitionScore += (count - 3) * 0.1;
      }
    }
    
    return Math.min(repetitionScore, 1);
  }

  private isDuplicateContent(contentHash: string): boolean {
    const count = this.contentCache.get(contentHash) || 0;
    this.contentCache.set(contentHash, count + 1);
    
    // Cleanup cache if it gets too large
    if (this.contentCache.size > this.CACHE_SIZE_LIMIT) {
      const entries = Array.from(this.contentCache.entries());
      entries.sort((a, b) => b[1] - a[1]); // Sort by count descending
      this.contentCache.clear();
      
      // Keep top half
      for (let i = 0; i < entries.length / 2; i++) {
        this.contentCache.set(entries[i][0], entries[i][1]);
      }
    }
    
    return count > 2; // Consider duplicate if seen more than 2 times
  }

  private generateContentHash(content: string): string {
    // Normalize content for better duplicate detection
    const normalized = content
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/[^\w\s]/g, '')
      .trim();
    
    let hash = 0;
    for (let i = 0; i < normalized.length; i++) {
      const char = normalized.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString(36);
  }

  private createAlert(
    type: string,
    severity: 'low' | 'medium' | 'high' | 'critical',
    message: Message,
    description: string,
    metadata?: any
  ): Alert {
    return {
      id: `${type}_${message.id}_${Date.now()}`,
      type,
      severity,
      channel_jid: message.target_channel,
      message_id: message.id,
      description,
      timestamp: Date.now(),
      is_resolved: false,
      metadata
    };
  }

  private getPatternDescription(pattern: RegExp): string {
    const source = pattern.source;
    if (source.includes('https?')) return 'URLs';
    if (source.includes('\\d{4}')) return 'credit_card_pattern';
    if (source.includes('\\d{3}')) return 'phone_number';
    if (source.includes('[A-Z]')) return 'excessive_caps';
    if (source.includes('\\1{4,}')) return 'repeated_characters';
    if (source.includes('@')) return 'email_address';
    if (source.includes('0x')) return 'crypto_address';
    return 'unknown_pattern';
  }

  // Clean up old rate limit data
  cleanupRateLimitData(): void {
    const now = Date.now();
    let cleanedCount = 0;
    
    for (const [sender, timestamps] of this.rateLimitMap.entries()) {
      const recentTimestamps = timestamps.filter(ts => now - ts < this.RATE_LIMIT_WINDOW);
      if (recentTimestamps.length === 0) {
        this.rateLimitMap.delete(sender);
        cleanedCount++;
      } else {
        this.rateLimitMap.set(sender, recentTimestamps);
      }
    }
    
    if (cleanedCount > 0) {
      console.log(`🧹 Cleaned ${cleanedCount} expired rate limit entries`);
    }
  }

  getAnalysisStats(): {
    cached_content_hashes: number;
    rate_limit_entries: number;
    spam_keywords: number;
    suspicious_patterns: number;
  } {
    return {
      cached_content_hashes: this.contentCache.size,
      rate_limit_entries: this.rateLimitMap.size,
      spam_keywords: this.spamKeywords.size,
      suspicious_patterns: this.suspiciousPatterns.length
    };
  }
}