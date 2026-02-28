import type { RawOcrResult, NormalizedOcrResult } from './types';

/** Umbral mínimo de confianza para aceptar un campo crítico. */
const MIN_CONFIDENCE_CRITICAL = 0.4;

/** Campos que DEBEN existir para que el registro sea válido. */
const CRITICAL_FIELDS: Array<keyof RawOcrResult> = ['fecha', 'estanque'];

export class OcrValidator {
  validate(raw: RawOcrResult): NormalizedOcrResult {
    const rejectionReasons: string[] = [];

    for (const field of CRITICAL_FIELDS) {
      const f = raw[field] as { value: unknown; confidence: number };
      if (f.value === null || f.confidence < MIN_CONFIDENCE_CRITICAL) {
        rejectionReasons.push(`missing_${field}`);
      }
    }

    return {
      fields: raw,
      isValid: rejectionReasons.length === 0,
      rejectionReasons,
      overallConfidence: this.calculateOverallConfidence(raw),
    };
  }

  private calculateOverallConfidence(raw: RawOcrResult): number {
    const fields = Object.values(raw) as Array<{ value: unknown; confidence: number }>;
    const detected = fields.filter((f) => f.value !== null);

    if (detected.length === 0) return 0;

    const sum = detected.reduce((acc, f) => acc + (f.confidence ?? 0), 0);
    return Math.round((sum / detected.length) * 1000) / 1000;
  }
}
