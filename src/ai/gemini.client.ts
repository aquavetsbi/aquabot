import { GoogleGenerativeAI } from '@google/generative-ai';
import type { Content } from '@google/generative-ai';
import { logger } from '../shared/logger';

const SYSTEM_PROMPT = `Eres AquaBot, el asistente de AquaData para monitoreo de cultivos acuícolas en Colombia.

Ayudas a operarios de estanques con:
- Interpretación de parámetros de calidad de agua: oxígeno disuelto, pH, temperatura, amonio (NH₃), nitritos, nitratos
- Alertas y recomendaciones cuando los parámetros están fuera de rango
- Manejo de mortalidades, alimentación y peso promedio
- Cálculo del Factor de Conversión Alimenticia (FCA) y biomasa
- Buenas prácticas de acuicultura para tilapia, trucha y otras especies

Rangos óptimos de referencia:
- Oxígeno: 6–9 mg/L (crítico < 4 mg/L)
- pH: 7.0–8.5
- Temperatura: 25–30 °C (tilapia), 12–18 °C (trucha)
- Amonio (NH₃): < 0.05 mg/L
- Nitritos: < 0.1 mg/L
- Nitratos: < 20 mg/L

Para registrar un reporte de producción, el operario debe enviar una FOTO del formulario de campo.

Instrucciones:
- Responde SIEMPRE en español
- Sé conciso y práctico — los operarios están en campo
- Si preguntan algo fuera del ámbito acuícola, redirígelos amablemente
- Usa emojis con moderación para hacer el chat más amigable`;

export type ChatMessage = { role: 'user' | 'model'; text: string };

export class GeminiClient {
  private readonly genAI;
  private readonly primaryModel: string;
  private static readonly FALLBACK_MODELS = ['gemini-2.0-flash', 'gemini-1.5-flash'];

  constructor(apiKey: string, modelName = 'gemini-2.5-flash') {
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.primaryModel = modelName;
  }

  /**
   * Envía un mensaje con historial de conversación previo.
   * El historial se gestiona externamente (Redis) y se pasa en cada llamada.
   */
  async chat(userMessage: string, history: ChatMessage[] = []): Promise<string> {
    try {
      const geminiHistory: Content[] = history.map((m) => ({
        role: m.role,
        parts: [{ text: m.text }],
      }));

      const modelCandidates = [
        this.primaryModel,
        ...GeminiClient.FALLBACK_MODELS.filter((name) => name !== this.primaryModel),
      ];

      let lastError: unknown;
      for (const modelName of modelCandidates) {
        try {
          const model = this.genAI.getGenerativeModel({
            model: modelName,
            systemInstruction: SYSTEM_PROMPT,
          });

          const chat = model.startChat({ history: geminiHistory });
          const result = await chat.sendMessage(userMessage);

          if (modelName !== this.primaryModel) {
            logger.warn({ requested: this.primaryModel, resolved: modelName }, 'Gemini fallback model used');
          }

          return result.response.text();
        } catch (err) {
          lastError = err;
          if (this.isModelNotFoundError(err)) {
            logger.warn({ model: modelName }, 'Gemini model not found, trying fallback');
            continue;
          }
          throw err;
        }
      }

      throw lastError instanceof Error ? lastError : new Error('Gemini chat failed without detailed error');
    } catch (err) {
      logger.error({ err }, 'Gemini chat error');
      throw err;
    }
  }

  private isModelNotFoundError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;

    const maybeStatus = 'status' in err ? (err as { status?: unknown }).status : undefined;
    const maybeMessage = 'message' in err ? (err as { message?: unknown }).message : undefined;

    return (
      maybeStatus === 404 ||
      (typeof maybeMessage === 'string' && maybeMessage.toLowerCase().includes('is not found'))
    );
  }
}
