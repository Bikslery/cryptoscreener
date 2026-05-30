import client from 'prom-client'

const register = new client.Registry()
client.collectDefaultMetrics({ register, prefix: 'cs_' })

// --- WS Hub ---
export const wsClientsGauge = new client.Gauge({
  name: 'cs_ws_clients_connected',
  help: 'Currently connected WS clients',
  registers: [register]
})

export const wsSubscriptionsGauge = new client.Gauge({
  name: 'cs_ws_subscriptions_total',
  help: 'Total active WS subscriptions across all clients',
  registers: [register]
})

export const wsBufferedMaxGauge = new client.Gauge({
  name: 'cs_ws_buffered_max',
  help: 'Max buffered count among connected clients',
  registers: [register]
})

export const wsDroppedTotal = new client.Counter({
  name: 'cs_ws_messages_dropped_total',
  help: 'Total WS messages dropped due to backpressure',
  registers: [register]
})

export const wsClientKilledTotal = new client.Counter({
  name: 'cs_ws_clients_killed_backpressure_total',
  help: 'Total WS clients killed due to hard backpressure limit',
  registers: [register]
})

export const wsBroadcastLatency = new client.Histogram({
  name: 'cs_ws_broadcast_duration_seconds',
  help: 'Time spent in broadcast()',
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5],
  registers: [register]
})

export const wsBatchFlushLatency = new client.Histogram({
  name: 'cs_ws_batch_flush_duration_seconds',
  help: 'Time spent in flushBatchBuffer()',
  buckets: [0.0005, 0.001, 0.005, 0.01, 0.025, 0.05, 0.1],
  registers: [register]
})

// --- Rate Limiter ---
export const rateLimitWeightGauge = new client.Gauge({
  name: 'cs_ratelimit_weight_current',
  help: 'Current API weight used',
  labelNames: ['market'],
  registers: [register]
})

export const rateLimitWeightMaxGauge = new client.Gauge({
  name: 'cs_ratelimit_weight_limit',
  help: 'API weight limit',
  labelNames: ['market'],
  registers: [register]
})

export const rateLimitThrottledCounter = new client.Counter({
  name: 'cs_ratelimit_throttled_total',
  help: 'Number of times rate limiter throttled requests',
  labelNames: ['market'],
  registers: [register]
})

export const rateLimit429Counter = new client.Counter({
  name: 'cs_ratelimit_429_total',
  help: 'Number of 429 responses received',
  labelNames: ['market'],
  registers: [register]
})

export const rateLimit418Counter = new client.Counter({
  name: 'cs_ratelimit_418_total',
  help: 'Number of 418 (IP ban) responses received',
  labelNames: ['market'],
  registers: [register]
})

export { register }
