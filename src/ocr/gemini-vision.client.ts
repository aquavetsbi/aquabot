import { generateObject } from 'ai';
import { google } from '@ai-sdk/google';
import { productionDataSchema, type OcrData } from './types';
import type { VisionClient } from './vision-client.interface';
import { BotError } from '../shared/errors';
import { logger } from '../shared/logger';

export class GeminiVisionClient implements VisionClient {
  private static readonly OCR_MODELS = [
    'gemini-2.5-flash',
    'gemini-3-flash-preview',
    'gemini-2.5-flash-lite',
  ] as const;

  private static readonly ATTEMPTS_PER_MODEL = 2;

  async extract(imageBuffer: Buffer, mimeType: string): Promise<OcrData> {
    if (!mimeType.startsWith('image/')) {
      throw new BotError('INVALID_IMAGE', `Formato no soportado: ${mimeType}. Envía JPG, PNG o WEBP.`);
    }

    logger.debug({ mimeType, sizeKb: Math.round(imageBuffer.length / 1024) }, 'Sending image to Gemini Vision');

    let lastError: unknown;

    for (const modelName of GeminiVisionClient.OCR_MODELS) {
      for (let attempt = 1; attempt <= GeminiVisionClient.ATTEMPTS_PER_MODEL; attempt += 1) {
        try {
          // generateObject infiere tipos desde el schema Zod; con schemas muy anidados
          // TypeScript da TS2589 "type instantiation excessively deep". El cast rompe el ciclo.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { object } = await (generateObject as any)({
            model: google(modelName),
            schema: productionDataSchema,
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: `Analiza esta imagen de un reporte acuícola de campo. Extrae los siguientes datos de producción:

- Fecha del registro
- Tipo de reporte (daily/weekly)
- Fecha final de la semana si es un reporte semanal
- Número de peces (cantidad total en el estanque)
- Alimento suministrado (kg)
- Peso promedio del animal (gramos)
- Peso de muestreo si aparece como un dato separado
- Mortalidad (cantidad de animales muertos)
- Temperatura del agua (grados Celsius)
- Oxígeno disuelto (mg/L)
- Amonio NH3/NH4+ (mg/L)
- Nitritos NO2 (mg/L)
- Nitratos NO3 (mg/L)
- pH del agua
- Fosfatos PO4 (mg/L)
- Dureza total (mg/L como CaCO3) — campo opcional
- Alcalinidad total (mg/L como CaCO3) — campo opcional
- Turbidez (NTU) — campo opcional
- Biomasa total del estanque (kg) — solo si aparece explícitamente en la imagen
- Notas u observaciones

La imagen puede ser un formulario manuscrito, una tabla impresa, o una hoja de registro.
Si un campo no es visible o no puedes leerlo con certeza, devuelve null para ese campo.
Para cada campo, asigna un nivel de confianza de 0 a 100.
NO intentes extraer el nombre del estanque desde la imagen: devuelve siempre pond_name = null y confidence.pond_name = 0.
Los campos de dureza y alcalinidad son opcionales; si no aparecen, devuelve null y confianza 0.
Si el reporte no indica explícitamente si es semanal, usa report_type = "daily".
Solo devuelve week_end_date cuando veas una fecha final de semana; de lo contrario devuelve null.
Si ves palabras como "reporte semanal", "semana", "week", o un rango/cierre semanal, usa report_type = "weekly".

IMPORTANTE: Si la fecha está en formato DD/MM/YYYY, conviértela a YYYY-MM-DD.`,
                  },
                  {
                    type: 'image',
                    image: imageBuffer,
                  },
                ],
              },
            ],
          });

          logger.info(
            { model: modelName, attempt, record_date: object.record_date, pond_name: object.pond_name },
            'Gemini Vision extraction complete',
          );

          return object;
        } catch (err) {
          lastError = err;
          logger.warn(
            {
              err,
              model: modelName,
              attempt,
              attemptsPerModel: GeminiVisionClient.ATTEMPTS_PER_MODEL,
            },
            'Gemini Vision extraction attempt failed',
          );
        }
      }
    }

    throw new BotError(
      'OCR_FAILED',
      'No pude leer el reporte. Por favor envía una foto más clara.',
      lastError instanceof Error ? lastError : undefined,
    );
  }
}
