import './config'; // valida env vars antes de todo
import { config } from './config';
import express from 'express';
import { logger } from './shared/logger';
import { RedisClient } from './infrastructure/redis.client';
import { SupabaseRepo } from './infrastructure/supabase.client';
import { GeminiVisionClient } from './ocr/gemini-vision.client';
import { OcrValidator } from './ocr/validator';
import { OcrPipeline } from './ocr/pipeline';
import { WhatsAppProviderFactory } from './whatsapp/factory';
import { MessageGatewayService } from './gateway/message-gateway.service';
import { GeminiClient } from './ai/gemini.client';
import { ChatService } from './ai/chat.service';
import { DraftService } from './ocr/draft.service';

// ─── HTTP server (health check + Twilio webhook) ──────────────────────────────

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', provider: config.WHATSAPP_PROVIDER, ts: new Date().toISOString() });
});

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  // @ai-sdk/google lee GOOGLE_GENERATIVE_AI_API_KEY; si no está definida, la
  // derivamos de GEMINI_API_KEY para que el usuario solo necesite una clave.
  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = config.GEMINI_API_KEY;
  }

  logger.info({ env: config.NODE_ENV, provider: config.WHATSAPP_PROVIDER }, 'AquaBot starting...');

  // Infrastructure
  const redis = new RedisClient(config.REDIS_URL);
  await redis.connect();

  const db = new SupabaseRepo(
    config.SUPABASE_URL,
    config.SUPABASE_SERVICE_ROLE_KEY,
    config.SUPABASE_STORAGE_BUCKET,
  );

  // OCR pipeline (Gemini Vision)
  const vision    = new GeminiVisionClient();
  const validator = new OcrValidator();
  const ocr       = new OcrPipeline(vision, validator);

  // WhatsApp provider (via Factory)
  const provider = WhatsAppProviderFactory.create(
    config.WHATSAPP_PROVIDER === 'baileys'
      ? { type: 'baileys', config: { authFolder: config.BAILEYS_AUTH_FOLDER } }
      : {
          type: 'twilio',
          config: {
            accountSid:  config.TWILIO_ACCOUNT_SID ?? '',
            authToken:   config.TWILIO_AUTH_TOKEN   ?? '',
            fromNumber:  config.TWILIO_FROM_NUMBER  ?? '',
          },
        },
  );

  // AI services
  const gemini   = new GeminiClient(config.GEMINI_API_KEY, config.GEMINI_CHAT_MODEL);
  const chatSvc  = new ChatService(gemini, redis);
  const draftSvc = new DraftService(redis);

  // Gateway — wires everything together
  new MessageGatewayService(provider, ocr, draftSvc, chatSvc, redis, db);

  // Start HTTP server
  app.listen(config.PORT, () => {
    logger.info({ port: config.PORT }, 'HTTP server listening');
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down...');
    await provider.disconnect();
    await redis.disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT',  () => void shutdown('SIGINT'));
}

bootstrap().catch((err) => {
  logger.fatal({ err }, 'Fatal error during bootstrap');
  process.exit(1);
});
