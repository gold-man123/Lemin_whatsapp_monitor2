export class PerformanceMonitor {
  private metrics: Map<string, number[]> = new Map();
  private startTime: number = Date.now();
  private isMonitoring: boolean = false;
  private monitoringInterval: NodeJS.Timeout | null = null;
  private readonly METRIC_RETENTION_TIME = 60 * 60 * 1000; // 1 hour
  private readonly MONITORING_INTERVAL = 5000; // 5 seconds

  startMonitoring(): void {
    if (this.isMonitoring) return;

    this.isMonitoring = true;
    this.monitoringInterval = setInterval(() => {
      this.collectSystemMetrics();
    }, this.MONITORING_INTERVAL);

    console.log('📊 Performance monitoring started');
  }

  stop(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
    this.isMonitoring = false;
    console.log('📊 Performance monitoring stopped');
  }

  recordMetric(name: string, value: number): void {
    const now = Date.now();
    const values = this.metrics.get(name) || [];
    
    // Add new value with timestamp
    values.push(value);
    
    // Keep only recent values
    const cutoff = now - this.METRIC_RETENTION_TIME;
    const recentValues = values.filter((_, index) => {
      const timestamp = now - (values.length - index - 1) * 1000;
      return timestamp > cutoff;
    });
    
    this.metrics.set(name, recentValues);
  }

  private collectSystemMetrics(): void {
    try {
      const memUsage = process.memoryUsage();
      const cpuUsage = process.cpuUsage();
      
      this.recordMetric('memory_heap_used', memUsage.heapUsed);
      this.recordMetric('memory_heap_total', memUsage.heapTotal);
      this.recordMetric('memory_rss', memUsage.rss);
      this.recordMetric('cpu_user', cpuUsage.user);
      this.recordMetric('cpu_system', cpuUsage.system);
      
      // Event loop lag detection
      const start = process.hrtime.bigint();
      setImmediate(() => {
        const lag = Number(process.hrtime.bigint() - start) / 1000000; // Convert to ms
        this.recordMetric('event_loop_lag', lag);
      });
    } catch (error) {
      console.error('❌ Failed to collect system metrics:', error);
    }
  }

  getMetric(name: string): { current: number; average: number; max: number; min: number } | null {
    const values = this.metrics.get(name);
    if (!values || values.length === 0) return null;

    const current = values[values.length - 1];
    const average = values.reduce((sum, val) => sum + val, 0) / values.length;
    const max = Math.max(...values);
    const min = Math.min(...values);

    return { current, average, max, min };
  }

  getUptime(): number {
    return Date.now() - this.startTime;
  }

  getMemoryUsage(): { used: number; total: number; percentage: number } {
    const memUsage = process.memoryUsage();
    const used = memUsage.heapUsed;
    const total = memUsage.heapTotal;
    const percentage = (used / total) * 100;

    return { used, total, percentage };
  }

  getProcessingRate(): number {
    const processedMetrics = this.metrics.get('messages_processed') || [];
    if (processedMetrics.length < 2) return 0;

    // Calculate messages per minute based on recent data
    const recentMessages = processedMetrics.slice(-12); // Last 12 data points (1 minute at 5s intervals)
    const totalMessages = recentMessages.reduce((sum, val) => sum + val, 0);
    
    return totalMessages;
  }

  getAllMetrics(): Record<string, any> {
    const result: Record<string, any> = {};
    
    for (const [name, values] of this.metrics.entries()) {
      if (values.length > 0) {
        result[name] = this.getMetric(name);
      }
    }
    
    return result;
  }

  cleanup(): void {
    const now = Date.now();
    const cutoff = now - this.METRIC_RETENTION_TIME;
    
    for (const [name, values] of this.metrics.entries()) {
      const recentValues = values.filter((_, index) => {
        const timestamp = now - (values.length - index - 1) * 1000;
        return timestamp > cutoff;
      });
      
      if (recentValues.length === 0) {
        this.metrics.delete(name);
      } else {
        this.metrics.set(name, recentValues);
      }
    }
  }

  getHealthStatus(): {
    status: 'healthy' | 'degraded' | 'unhealthy';
    details: Record<string, any>;
  } {
    const memUsage = this.getMemoryUsage();
    const eventLoopLag = this.getMetric('event_loop_lag');
    
    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    const details: Record<string, any> = {
      memory_percentage: memUsage.percentage,
      event_loop_lag: eventLoopLag?.current || 0,
      uptime: this.getUptime(),
      metrics_count: this.metrics.size
    };

    // Determine health status
    if (memUsage.percentage > 90 || (eventLoopLag?.current || 0) > 100) {
      status = 'unhealthy';
    } else if (memUsage.percentage > 70 || (eventLoopLag?.current || 0) > 50) {
      status = 'degraded';
    }

    return { status, details };
  }
}