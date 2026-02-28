import Anthropic from '@anthropic-ai/sdk';
import type { RawOcrResult } from './types';
import { OCR_EXTRACTION_PROMPT } from './prompts/extraction.prompt';
import { BotError } from '../shared/errors';
import { logger } from '../shared/logger';

const SUPPORTED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
type SupportedMime = (typeof SUPPORTED_MIME_TYPES)[number];

function isSupportedMime(mime: string): mime is SupportedMime {
  return SUPPORTED_MIME_TYPES.includes(mime as SupportedMime);
}

export class ClaudeVisionClient {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async extract(imageBuffer: Buffer, mimeType: string): Promise<RawOcrResult> {
    if (!isSupportedMime(mimeType)) {
      throw new BotError(
        'INVALID_IMAGE',
        `Formato de imagen no soportado: ${mimeType}. Envía JPG, PNG o WEBP.`,
      );
    }

    const base64 = imageBuffer.toString('base64');

    logger.debug({ mimeType, sizeKb: Math.round(imageBuffer.length / 1024) }, 'Sending image to Claude Vision');

    const response = await this.client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mimeType,
                data: base64,
              },
            },
            {
              type: 'text',
              text: OCR_EXTRACTION_PROMPT,
            },
          ],
        },
      ],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    logger.debug({ responseText: text.slice(0, 300) }, 'Claude Vision raw response');

    try {
      return JSON.parse(text) as RawOcrResult;
    } catch {
      throw new BotError(
        'OCR_FAILED',
        'No pude leer el reporte. Por favor envía una foto más clara.',
        new Error(`Claude returned non-JSON: ${text.slice(0, 200)}`),
      );
    }
  }
}
