import { parse, parseISO, isValid, format } from 'date-fns';
import type { RawOcrResult } from './types';
import { logger } from '../shared/logger';

/** Formatos de fecha comunes en reportes de campo latinoamericanos. */
const DATE_FORMATS = [
  'dd/MM/yyyy',
  'dd-MM-yyyy',
  'dd/MM/yy',
  'dd-MM-yy',
  'MM/dd/yyyy',
  'd/M/yyyy',
  'd/M/yy',
];

export class OcrNormalizer {
  normalize(raw: RawOcrResult): RawOcrResult {
    return {
      ...raw,
      fecha: this.normalizeDate(raw.fecha),
      estanque: this.normalizeText(raw.estanque),
      lote: this.normalizeText(raw.lote),
      observaciones: this.normalizeText(raw.observaciones),
    };
  }

  private normalizeDate(field: RawOcrResult['fecha']): RawOcrResult['fecha'] {
    if (!field.value) return field;

    const v = field.value.trim();

    // Ya es ISO 8601
    const isoDate = parseISO(v);
    if (isValid(isoDate)) {
      return { ...field, value: format(isoDate, 'yyyy-MM-dd') };
    }

    // Intentar formatos comunes
    for (const fmt of DATE_FORMATS) {
      const parsed = parse(v, fmt, new Date());
      if (isValid(parsed)) {
        return { ...field, value: format(parsed, 'yyyy-MM-dd') };
      }
    }

    // No se pudo normalizar
    logger.warn({ raw: v }, 'Could not normalize date — setting to null');
    return { ...field, value: null, confidence: 0 };
  }

  private normalizeText<T extends { value: string | null; confidence: number }>(
    field: T,
  ): T {
    if (!field.value) return field;
    return { ...field, value: field.value.trim() };
  }
}
