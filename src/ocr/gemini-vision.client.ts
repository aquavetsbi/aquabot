import { generateObject } from 'ai';
import { google } from '@ai-sdk/google';
import { productionDataSchema, type OcrData } from './types';
import type { VisionClient } from './vision-client.interface';
import { BotError } from '../shared/errors';
import { logger } from '../shared/logger';

export class GeminiVisionClient implements VisionClient {
  async extract(imageBuffer: Buffer, mimeType: string): Promise<OcrData> {
    if (!mimeType.startsWith('image/')) {
      throw new BotError('INVALID_IMAGE', `Formato no soportado: ${mimeType}. Envía JPG, PNG o WEBP.`);
    }

    logger.debug({ mimeType, sizeKb: Math.round(imageBuffer.length / 1024) }, 'Sending image to Gemini Vision');

    try {
      // generateObject infiere tipos desde el schema Zod; con schemas muy anidados
      // TypeScript da TS2589 "type instantiation excessively deep". El cast rompe el ciclo.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { object } = await (generateObject as any)({
        model: google('gemini-2.5-flash'),
        schema: productionDataSchema,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Analiza esta imagen de un reporte acuícola de campo. Extrae los siguientes datos de producción:

- Fecha del registro
- Número de peces (cantidad total en el estanque)
- Alimento suministrado (kg)
- Peso promedio del animal (gramos)
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
- Notas u observaciones

La imagen puede ser un formulario manuscrito, una tabla impresa, o una hoja de registro.
Si un campo no es visible o no puedes leerlo con certeza, devuelve null para ese campo.
Para cada campo, asigna un nivel de confianza de 0 a 100.
NO intentes extraer el nombre del estanque desde la imagen: devuelve siempre pond_name = null y confidence.pond_name = 0.
Los campos de dureza y alcalinidad son opcionales; si no aparecen, devuelve null y confianza 0.

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

      logger.debug(
        { record_date: object.record_date, pond_name: object.pond_name },
        'Gemini Vision extraction complete',
      );

      return object;
    } catch (err) {
      if (err instanceof BotError) throw err;
      throw new BotError(
        'OCR_FAILED',
        'No pude leer el reporte. Por favor envía una foto más clara.',
        err instanceof Error ? err : undefined,
      );
    }
  }
}
