import { z } from 'zod';

// ─── Schema Zod (mismo que portal AquaData) ───────────────────────────────────
// Añadimos pond_name al schema del bot (el portal no lo necesita porque el usuario
// selecciona el estanque en la UI; el bot lo extrae de la imagen).

export const productionDataSchema = z.object({
  pond_name:       z.string().nullable().describe('Nombre o código del estanque (ej: E-3, Estanque 3, P-07)'),
  record_date:     z.string().nullable().describe('Fecha del registro en formato YYYY-MM-DD'),
  fish_count:      z.number().nullable().describe('Número total de peces en el estanque'),
  feed_kg:         z.number().nullable().describe('Alimento suministrado en kg'),
  avg_weight_g:    z.number().nullable().describe('Peso promedio del animal en gramos'),
  mortality_count: z.number().nullable().describe('Cantidad de mortalidad del día'),
  temperature_c:   z.number().nullable().describe('Temperatura del agua en grados Celsius'),
  oxygen_mg_l:     z.number().nullable().describe('Oxígeno disuelto en mg/L'),
  ammonia_mg_l:    z.number().nullable().describe('Amonio (NH3/NH4+) en mg/L'),
  nitrite_mg_l:    z.number().nullable().describe('Nitritos (NO2) en mg/L'),
  nitrate_mg_l:    z.number().nullable().describe('Nitratos (NO3) en mg/L'),
  ph:              z.number().nullable().describe('pH del agua'),
  phosphate_mg_l:  z.number().nullable().describe('Fosfatos (PO4) en mg/L'),
  hardness_mg_l:   z.number().nullable().describe('Dureza total del agua en mg/L como CaCO3 (opcional)'),
  alkalinity_mg_l: z.number().nullable().describe('Alcalinidad total del agua en mg/L como CaCO3 (opcional)'),
  notes:           z.string().nullable().describe('Notas o observaciones adicionales del reporte'),
  confidence: z.object({
    pond_name:       z.number().describe('Confianza de 0 a 100 para nombre del estanque'),
    record_date:     z.number().describe('Confianza de 0 a 100 para la fecha'),
    fish_count:      z.number().describe('Confianza de 0 a 100 para número de peces'),
    feed_kg:         z.number().describe('Confianza de 0 a 100 para alimento'),
    avg_weight_g:    z.number().describe('Confianza de 0 a 100 para peso promedio en gramos'),
    mortality_count: z.number().describe('Confianza de 0 a 100 para mortalidad'),
    temperature_c:   z.number().describe('Confianza de 0 a 100 para temperatura'),
    oxygen_mg_l:     z.number().describe('Confianza de 0 a 100 para oxígeno'),
    ammonia_mg_l:    z.number().describe('Confianza de 0 a 100 para amonio'),
    nitrite_mg_l:    z.number().describe('Confianza de 0 a 100 para nitritos'),
    nitrate_mg_l:    z.number().describe('Confianza de 0 a 100 para nitratos'),
    ph:              z.number().describe('Confianza de 0 a 100 para pH'),
    phosphate_mg_l:  z.number().describe('Confianza de 0 a 100 para fosfatos'),
    hardness_mg_l:   z.number().describe('Confianza de 0 a 100 para dureza'),
    alkalinity_mg_l: z.number().describe('Confianza de 0 a 100 para alcalinidad'),
  }).describe('Nivel de confianza para cada campo extraído, de 0 a 100'),
});

/** Tipo inferido del schema Zod — es el output directo de Gemini. */
export type OcrData = z.infer<typeof productionDataSchema>;

/** Resultado final del pipeline OCR. */
export interface NormalizedOcrResult {
  data: OcrData;
  isValid: boolean;
  /** Ej: ['missing_record_date', 'missing_pond_name'] */
  rejectionReasons: string[];
  /** Confianza global en escala 0–1 (promedio de campos detectados / 100). */
  overallConfidence: number;
}

export interface OcrPipelineInput {
  jobId: string;
  imageBuffer: Buffer;
  mimeType: string;
}
