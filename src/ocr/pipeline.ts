import type { OcrPipelineInput, NormalizedOcrResult } from './types';
import type { VisionClient } from './vision-client.interface';
import { OcrValidator } from './validator';
import { BotError } from '../shared/errors';
import { logger } from '../shared/logger';

export class OcrPipeline {
  constructor(
    private readonly vision: VisionClient,
    private readonly validator: OcrValidator,
  ) {}

  async run(input: OcrPipelineInput): Promise<NormalizedOcrResult> {
    const startMs = Date.now();
    logger.info({ jobId: input.jobId }, 'OCR pipeline started');

    if (!input.mimeType.startsWith('image/')) {
      throw new BotError('INVALID_IMAGE', 'Solo puedo procesar imágenes. Por favor envía una foto del formulario de campo.');
    }

    // 1. Extraer con Gemini Vision (output estructurado via Zod)
    const data = await this.vision.extract(input.imageBuffer, input.mimeType);

    // 2. Validar campos críticos y calcular confianza global
    const result = this.validator.validate(data);

    logger.info(
      { jobId: input.jobId, isValid: result.isValid, confidence: result.overallConfidence, elapsedMs: Date.now() - startMs },
      'OCR pipeline completed',
    );

    return result;
  }
}
