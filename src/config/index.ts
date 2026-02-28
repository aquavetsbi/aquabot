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

  // Anthropic
  ANTHROPIC_API_KEY: z.string().min(1),

  // Supabase
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_STORAGE_BUCKET: z.string().default('aquabot-images'),

  // Redis
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
