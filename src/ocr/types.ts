export interface OcrField<T> {
  value: T | null;
  confidence: number; // 0.0 – 1.0
}

export interface OcrFieldWithUnit<T> extends OcrField<T> {
  unit_detected: string | null;
}

/** Respuesta cruda de Claude Vision — fiel al prompt. */
export interface RawOcrResult {
  fecha: OcrField<string>;
  estanque: OcrField<string>;
  lote: OcrField<string>;
  alimento_kg: OcrFieldWithUnit<number>;
  peso_promedio_g: OcrFieldWithUnit<number>;
  mortalidad: OcrField<number>;
  temperatura_c: OcrFieldWithUnit<number>;
  oxigeno_mgl: OcrFieldWithUnit<number>;
  amonio_mgl: OcrFieldWithUnit<number>;
  nitritos_mgl: OcrFieldWithUnit<number>;
  nitratos_mgl: OcrFieldWithUnit<number>;
  ph: OcrField<number>;
  observaciones: OcrField<string>;
}

export interface NormalizedOcrResult {
  fields: RawOcrResult;
  isValid: boolean;
  /** Ej: ['missing_fecha', 'missing_estanque'] */
  rejectionReasons: string[];
  overallConfidence: number;
}

export interface OcrPipelineInput {
  jobId: string;
  imageBuffer: Buffer;
  mimeType: string;
}
