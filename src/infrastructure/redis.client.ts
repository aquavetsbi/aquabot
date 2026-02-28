import { createClient, type RedisClientType } from 'redis';
import { logger } from '../shared/logger';

export class RedisClient {
  private client: RedisClientType;
  private connected = false;

  constructor(url: string) {
    this.client = createClient({ url }) as RedisClientType;
    this.client.on('error', (err) => logger.error({ err }, 'Redis error'));
    this.client.on('connect', () => logger.info('Redis connected'));
    this.client.on('reconnecting', () => logger.warn('Redis reconnecting...'));
  }

  async connect(): Promise<void> {
    if (!this.connected) {
      await this.client.connect();
      this.connected = true;
    }
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, options?: { ttlSeconds: number }): Promise<void> {
    if (options?.ttlSeconds) {
      await this.client.setEx(key, options.ttlSeconds, value);
    } else {
      await this.client.set(key, value);
    }
  }

  /**
   * Atomic SET NX — retorna true si adquirió el lock.
   * Patrón: SETNX con TTL para evitar deadlocks.
   */
  async setnx(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.client.set(key, value, { NX: true, EX: ttlSeconds });
    return result === 'OK';
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  /**
   * Incrementa un contador y establece TTL atómicamente.
   * Usado para rate limiting por operario.
   */
  async incrementWithTtl(key: string, ttlSeconds: number): Promise<number> {
    const multi = this.client.multi();
    multi.incr(key);
    multi.expire(key, ttlSeconds);
    const results = await multi.exec();
    return results[0] as number;
  }

  /** Encola un job (LPUSH). */
  async enqueue(queue: string, payload: string): Promise<void> {
    await this.client.lPush(queue, payload);
  }

  /**
   * Desencola bloqueante (BRPOP).
   * El worker llama esto en un loop — espera hasta timeoutSeconds.
   */
  async dequeue(queue: string, timeoutSeconds: number): Promise<string | null> {
    const result = await this.client.brPop(queue, timeoutSeconds);
    return result?.element ?? null;
  }

  async disconnect(): Promise<void> {
    await this.client.quit();
  }
}
