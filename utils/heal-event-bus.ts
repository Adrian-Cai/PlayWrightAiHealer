/**
 * Healing Event Bus — Pub/Sub for heal events
 * Minimal event emitter for aiClick/aiAssert to dispatch events
 * Subscribers: feishu-bot, cache-writer, jsonl-logger
 */

import { HealEvent, HealEventType } from '../skills/self-healing-locator/contract';

type HealEventHandler = (event: HealEvent) => Promise<void> | void;

class HealEventBus {
  private handlers: Map<HealEventType | 'all', HealEventHandler[]> = new Map();

  /**
   * Subscribe to heal events
   * @param type Event type, or 'all' for all events
   * @param handler Callback function
   */
  on(type: HealEventType | 'all', handler: HealEventHandler): void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, []);
    }
    this.handlers.get(type)!.push(handler);
  }

  /**
   * Unsubscribe from heal events
   */
  off(type: HealEventType | 'all', handler: HealEventHandler): void {
    const handlers = this.handlers.get(type);
    if (!handlers) return;
    const idx = handlers.indexOf(handler);
    if (idx !== -1) {
      handlers.splice(idx, 1);
    }
  }

  /**
   * Emit a heal event to all subscribers
   * Runs handlers sequentially; logs handler errors but does not re-throw
   */
  async emit(event: HealEvent): Promise<void> {
    const allHandlers = this.handlers.get('all') || [];
    const typeHandlers = this.handlers.get(event.type) || [];
    const handlers = [...allHandlers, ...typeHandlers];

    for (const handler of handlers) {
      try {
        await Promise.resolve(handler(event));
      } catch (error) {
        console.error(`[HealEventBus] Handler error for ${event.type}:`, error);
      }
    }
  }

  /**
   * Clear all subscriptions
   */
  clear(): void {
    this.handlers.clear();
  }

  /**
   * Get subscription count
   */
  count(type?: HealEventType | 'all'): number {
    if (!type) {
      return Array.from(this.handlers.values()).reduce((sum, h) => sum + h.length, 0);
    }
    return this.handlers.get(type)?.length || 0;
  }
}

// Singleton instance
export const healEventBus = new HealEventBus();

export { HealEventBus };
