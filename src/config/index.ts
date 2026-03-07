import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.string().default('info'),
  PORT: z.coerce.number().default(3000),

  // WhatsApp
  WHATSAPP_PROVIDER: z.enum(['baileys', 'twilio']).default('baileys'),
  BAILEYS_AUTH_FOLDER: z.string().default('./baileys-auth'),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM_NUMBER: z.string().optional(),

  // Google Gemini (OCR + chat)
  // GEMINI_API_KEY → @google/generative-ai (chat)
  // GOOGLE_GENERATIVE_AI_API_KEY → @ai-sdk/google (OCR). Si no se define,
  //   src/index.ts lo copia de GEMINI_API_KEY automáticamente.
  GEMINI_API_KEY: z.string().min(1),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().optional(),
  GEMINI_CHAT_MODEL: z.string().default('gemini-2.5-flash'),

  // Supabase
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_STORAGE_BUCKET: z.string().default('aquabot-images'),
  /**
   * Si está definido, cualquier número desconocido se auto-registra
   * en profiles con esta organización. Útil para desarrollo/testing.
   * En producción: deja vacío para bloquear números no registrados.
   */
  SUPABASE_DEFAULT_ORG_ID: z.string().uuid().optional(),

  // Redis
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

// Guardrail: este backend necesita la service role key para inserts/server-side ops.
const maybeJwt = parsed.data.SUPABASE_SERVICE_ROLE_KEY;
if (maybeJwt.includes('.')) {
  try {
    const payloadRaw = maybeJwt.split('.')[1] ?? '';
    const payloadJson = Buffer.from(payloadRaw, 'base64url').toString('utf8');
    const payload = JSON.parse(payloadJson) as { role?: string };

    if (payload.role === 'anon') {
      console.error('❌ SUPABASE_SERVICE_ROLE_KEY is using role=anon. Use the service_role key from Supabase settings.');
      process.exit(1);
    }
  } catch {
    // Non-JWT format (e.g. sb_secret_...) or decode error: ignore here.
  }
}

export const config = parsed.data;
