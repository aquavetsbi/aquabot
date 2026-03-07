import type { OcrData, NormalizedOcrResult } from './types';

/** Umbral mínimo de confianza (0-100) para aceptar un campo crítico. */
const MIN_CONFIDENCE_CRITICAL = 40;

/** Campos que DEBEN existir para que el registro sea válido. */
const CRITICAL_FIELDS: Array<keyof OcrData['confidence']> = ['record_date'];

export class OcrValidator {
  validate(data: OcrData): NormalizedOcrResult {
    const rejectionReasons: string[] = [];

    for (const field of CRITICAL_FIELDS) {
      const value = data[field as keyof OcrData];
      const conf  = data.confidence[field];
      if (value === null || conf < MIN_CONFIDENCE_CRITICAL) {
        rejectionReasons.push(`missing_${field}`);
      }
    }

    return {
      data,
      isValid: rejectionReasons.length === 0,
      rejectionReasons,
      overallConfidence: this.calculateOverallConfidence(data),
    };
  }

  /** Promedio de confianza de campos detectados (no-null), en escala 0–1. */
  private calculateOverallConfidence(data: OcrData): number {
    const dataFields = Object.keys(data.confidence) as Array<keyof typeof data.confidence>;
    const detected = dataFields.filter((k) => data[k as keyof OcrData] !== null);
    if (detected.length === 0) return 0;
    const sum = detected.reduce((acc, k) => acc + data.confidence[k], 0);
    return Math.round((sum / detected.length) / 100 * 1000) / 1000; // 0–1
  }
}
