import type { OcrData } from './types';

export interface VisionClient {
  extract(imageBuffer: Buffer, mimeType: string): Promise<OcrData>;
}
