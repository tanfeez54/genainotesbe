import { spawn } from 'child_process';
import path from 'path';

export interface CropTarget {
  id: string;
  docIndex: number;
  page: number;
  box: [number, number, number, number]; // [ymin, xmin, ymax, xmax] normalized 0-1000
}

export interface CropPdfDocument {
  index: number;
  buffer: Buffer;
}

/**
 * High-performance PDF diagram cropper powered by PyMuPDF.
 * Crops targeted bounding boxes from PDF pages and returns base64 PNG Data URLs.
 */
export async function cropPdfDiagrams(
  docs: CropPdfDocument[],
  crops: CropTarget[]
): Promise<Record<string, string>> {
  if (!docs.length || !crops.length) {
    return {};
  }

  return new Promise((resolve) => {
    try {
      const scriptPath = path.resolve(__dirname, '../scripts/pdfCropper.py');

      const payload = {
        docs: docs.map((d) => ({
          index: d.index,
          pdf_base64: d.buffer.toString('base64'),
        })),
        crops: crops.map((c) => ({
          id: c.id,
          doc_index: c.docIndex,
          page: c.page,
          box: c.box,
        })),
      };

      const proc = spawn('python', [scriptPath]);
      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code !== 0) {
          console.warn('[pdfCropService] Python process exited with code', code, stderr);
          resolve({});
          return;
        }

        try {
          const resp = JSON.parse(stdout);
          if (resp && resp.images && typeof resp.images === 'object') {
            resolve(resp.images);
          } else {
            resolve({});
          }
        } catch (parseErr) {
          console.warn('[pdfCropService] Failed to parse python cropper response:', parseErr, stdout);
          resolve({});
        }
      });

      proc.on('error', (err) => {
        console.warn('[pdfCropService] Error launching python cropper:', err.message);
        resolve({});
      });

      proc.stdin.write(JSON.stringify(payload));
      proc.stdin.end();
    } catch (err: any) {
      console.warn('[pdfCropService] Unexpected error during cropping:', err?.message || err);
      resolve({});
    }
  });
}
