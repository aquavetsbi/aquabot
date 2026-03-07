import type { GeminiClient, ChatMessage } from './gemini.client';
import type { RedisClient } from '../infrastructure/redis.client';
import { logger } from '../shared/logger';

const HISTORY_TTL_SEC = 30 * 60; // 30 minutos sin actividad → limpia historial
const MAX_HISTORY_TURNS = 10;     // máximo 10 turnos (20 mensajes) en contexto

export class ChatService {
  constructor(
    private readonly gemini: GeminiClient,
    private readonly redis: RedisClient,
  ) {}

  async respond(phone: string, userMessage: string): Promise<string> {
    const historyKey = `chat:history:${phone}`;

    // Cargar historial previo
    const raw = await this.redis.get(historyKey);
    const history: ChatMessage[] = raw
      ? (JSON.parse(raw) as Array<{ role: string; text: string }>).map((m) => ({
          role: m.role as ChatMessage['role'],
          text: m.text,
        }))
      : [];

    // Llamar a Gemini con el historial
    const reply = await this.gemini.chat(userMessage, history);

    // Actualizar historial con el nuevo turno
    const updated: ChatMessage[] = [
      ...history,
      { role: 'user' as const, text: userMessage },
      { role: 'model' as const, text: reply },
    ].slice(-MAX_HISTORY_TURNS * 2);

    await this.redis.set(historyKey, JSON.stringify(updated), { ttlSeconds: HISTORY_TTL_SEC });

    logger.info({ phone, turns: updated.length / 2 }, 'Chat response sent');
    return reply;
  }

  /** Limpia el historial de un usuario (por ejemplo al registrar un reporte). */
  async clearHistory(phone: string): Promise<void> {
    await this.redis.del(`chat:history:${phone}`);
  }
}
