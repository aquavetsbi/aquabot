import type { OcrPipelineInput, NormalizedOcrResult } from './types';
import { ClaudeVisionClient } from './claude-vision.client';
import { OcrNormalizer } from './normalizer';
import { OcrValidator } from './validator';
import { BotError } from '../shared/errors';
import { logger } from '../shared/logger';

export class OcrPipeline {
  constructor(
    private readonly vision: ClaudeVisionClient,
    private readonly normalizer: OcrNormalizer,
    private readonly validator: OcrValidator,
  ) {}

  async run(input: OcrPipelineInput): Promise<NormalizedOcrResult> {
    const startMs = Date.now();
    logger.info({ jobId: input.jobId }, 'OCR pipeline started');

    // 1. Validar tipo de archivo
    if (!input.mimeType.startsWith('image/')) {
      throw new BotError(
        'INVALID_IMAGE',
        'Solo puedo procesar imágenes. Por favor envía una foto del formulario de campo.',
      );
    }

    // 2. Extraer con Claude Vision
    const raw = await this.vision.extract(input.imageBuffer, input.mimeType);

    // 3. Normalizar fechas, unidades y strings
    const normalized = this.normalizer.normalize(raw);

    // 4. Validar campos críticos
    const result = this.validator.validate(normalized);

    const elapsedMs = Date.now() - startMs;

    logger.info(
      {
        jobId: input.jobId,
        isValid: result.isValid,
        confidence: result.overallConfidence,
        rejections: result.rejectionReasons,
        elapsedMs,
      },
      'OCR pipeline completed',
    );

    return result;
  }
}
