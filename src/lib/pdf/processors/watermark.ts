/**
 * PDF Watermark Processor
 * Requirements: 5.1
 * 
 * Supports both text and image watermarks.
 * Text watermarks support any Unicode text including Chinese, Japanese, Korean,
 * Arabic, and emojis using high-resolution Canvas supersampling with native system fonts.
 */

import type { ProcessInput, ProcessOutput, ProgressCallback } from '@/types/pdf';
import { PDFErrorCode } from '@/types/pdf';
import { BasePDFProcessor } from '../processor';
import { loadPdfLib } from '../loader';

export interface WatermarkOptions {
  type: 'text' | 'image';
  text?: string;
  imageData?: ArrayBuffer;
  imageType?: 'png' | 'jpg';
  position?: 'center' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'diagonal';
  opacity?: number;
  rotation?: number;
  fontSize?: number;
  color?: { r: number; g: number; b: number } | string;
  pages?: number[] | 'all' | 'odd' | 'even';
}

/**
 * Parse color from hex string or RGB object
 */
function parseColor(color: unknown): { r: number; g: number; b: number } {
  if (typeof color === 'string') {
    let hex = color.trim();
    if (hex.startsWith('#')) hex = hex.slice(1);
    if (hex.length === 3) {
      hex = hex.split('').map(c => c + c).join('');
    }
    if (hex.length === 6) {
      const r = parseInt(hex.slice(0, 2), 16) / 255;
      const g = parseInt(hex.slice(2, 4), 16) / 255;
      const b = parseInt(hex.slice(4, 6), 16) / 255;
      if (!isNaN(r) && !isNaN(g) && !isNaN(b)) {
        return { r, g, b };
      }
    }
  } else if (color && typeof color === 'object') {
    const c = color as { r?: number; g?: number; b?: number };
    const r = typeof c.r === 'number' ? (c.r > 1 ? c.r / 255 : c.r) : 0.5;
    const g = typeof c.g === 'number' ? (c.g > 1 ? c.g / 255 : c.g) : 0.5;
    const b = typeof c.b === 'number' ? (c.b > 1 ? c.b / 255 : c.b) : 0.5;
    return { r, g, b };
  }
  return { r: 0.5, g: 0.5, b: 0.5 };
}

/**
 * Render text to a high-resolution PNG image using HTML5 Canvas.
 * This supports all Unicode characters including Chinese, Japanese, Korean, Arabic, Emoji, etc.,
 * using native system fonts without downloading external font files.
 */
function createTextWatermarkImage(
  text: string,
  fontSize: number,
  color: { r: number; g: number; b: number }
): { imageBytes: Uint8Array; width: number; height: number } | null {
  if (typeof document === 'undefined') {
    return null;
  }

  try {
    const canvas = document.createElement('canvas');
    if (!canvas || typeof canvas.getContext !== 'function') {
      return null;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    // 3x supersampling gives 300+ DPI quality in PDF viewers and print
    const scale = 3;
    const scaledFontSize = Math.max(8, fontSize) * scale;

    // Comprehensive font stack prioritizing CJK fonts, then system UI fonts
    const fontStack = `bold ${scaledFontSize}px "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "SimHei", "WenQuanYi Micro Hei", "Noto Sans CJK SC", "Noto Sans SC", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
    ctx.font = fontStack;

    // Handle potential multi-line text
    const lines = text.split('\n');
    let maxLineWidth = 0;
    for (const line of lines) {
      const lineMetrics = ctx.measureText(line);
      if (lineMetrics.width > maxLineWidth) {
        maxLineWidth = lineMetrics.width;
      }
    }

    const lineHeight = scaledFontSize * 1.25;
    const totalTextHeight = lineHeight * lines.length;

    // Padding around text to prevent any glyph edge clipping
    const paddingX = Math.ceil(scaledFontSize * 0.25);
    const paddingY = Math.ceil(scaledFontSize * 0.25);

    canvas.width = Math.ceil(maxLineWidth + paddingX * 2);
    canvas.height = Math.ceil(totalTextHeight + paddingY * 2);

    // Canvas resize resets context state, so reapply font
    ctx.font = fontStack;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';

    // Clear transparent background
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Set text fill color
    const r = Math.min(255, Math.max(0, Math.round((color?.r ?? 0.5) * 255)));
    const g = Math.min(255, Math.max(0, Math.round((color?.g ?? 0.5) * 255)));
    const b = Math.min(255, Math.max(0, Math.round((color?.b ?? 0.5) * 255)));
    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;

    // Draw lines centered
    const centerX = canvas.width / 2;
    const startY = paddingY + lineHeight / 2;
    for (let l = 0; l < lines.length; l++) {
      ctx.fillText(lines[l], centerX, startY + l * lineHeight);
    }

    // Convert to PNG Uint8Array
    const dataUrl = canvas.toDataURL('image/png');
    const commaIndex = dataUrl.indexOf(',');
    if (commaIndex === -1) return null;
    const base64 = dataUrl.slice(commaIndex + 1);
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    return {
      imageBytes: bytes,
      width: canvas.width / scale,
      height: canvas.height / scale,
    };
  } catch (err) {
    console.warn('Canvas watermark rendering failed, falling back:', err);
    return null;
  }
}

export class WatermarkProcessor extends BasePDFProcessor {
  async process(input: ProcessInput, onProgress?: ProgressCallback): Promise<ProcessOutput> {
    this.reset();
    this.onProgress = onProgress;

    const { files, options } = input;
    const inputOptions = options as Partial<WatermarkOptions>;
    const wmOptions: WatermarkOptions = {
      type: inputOptions.type ?? 'text',
      text: inputOptions.text,
      imageData: inputOptions.imageData,
      imageType: inputOptions.imageType,
      position: inputOptions.position ?? 'center',
      opacity: inputOptions.opacity ?? 0.3,
      rotation: inputOptions.rotation ?? -45,
      fontSize: inputOptions.fontSize ?? 48,
      color: inputOptions.color ?? { r: 0.5, g: 0.5, b: 0.5 },
      pages: inputOptions.pages ?? 'all',
    };

    if (files.length !== 1) {
      return this.createErrorOutput(PDFErrorCode.INVALID_OPTIONS, 'Exactly 1 PDF file is required.');
    }

    try {
      this.updateProgress(10, 'Loading PDF library...');
      const pdfLib = await loadPdfLib();

      this.updateProgress(20, 'Loading PDF...');
      const file = files[0];
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfLib.PDFDocument.load(arrayBuffer, { ignoreEncryption: true });

      const totalPages = pdf.getPageCount();
      this.updateProgress(30, 'Preparing watermark...');

      // Prepare watermark assets once before page loop to optimize performance and file size
      let embeddedImage: any = null;
      let imgWidth = 0;
      let imgHeight = 0;
      let font: any = null;
      let isVectorText = false;
      let textWidth = 0;
      let textHeight = 0;

      if (wmOptions.type === 'text' && wmOptions.text) {
        const text = wmOptions.text;
        const fontSize = wmOptions.fontSize || 48;
        const color = parseColor(wmOptions.color);
        const hasNonAscii = /[^\x20-\x7E]/.test(text);

        // In browser environments, Canvas renders Chinese, Japanese, Korean, English,
        // and all Unicode characters flawlessly with native system fonts.
        let textCanvasResult = createTextWatermarkImage(text, fontSize, color);

        if (textCanvasResult) {
          embeddedImage = await pdf.embedPng(textCanvasResult.imageBytes);
          imgWidth = textCanvasResult.width;
          imgHeight = textCanvasResult.height;
        } else if (!hasNonAscii) {
          // Fallback to standard Helvetica font for ASCII text when Canvas is unavailable
          font = await pdf.embedFont(pdfLib.StandardFonts.HelveticaBold);
          isVectorText = true;
          textWidth = font.widthOfTextAtSize(text, fontSize);
          textHeight = font.heightAtSize(fontSize);
        } else {
          return this.createErrorOutput(
            PDFErrorCode.PROCESSING_FAILED,
            'Failed to add watermark. Canvas is required to render Chinese/Unicode characters.'
          );
        }
      } else if (wmOptions.type === 'image' && wmOptions.imageData) {
        if (wmOptions.imageType === 'jpg') {
          embeddedImage = await pdf.embedJpg(wmOptions.imageData);
        } else {
          embeddedImage = await pdf.embedPng(wmOptions.imageData);
        }
        const scale = 0.5;
        imgWidth = embeddedImage.width * scale;
        imgHeight = embeddedImage.height * scale;
      }

      const pagesToProcess = getPageIndices(wmOptions.pages, totalPages);

      for (let i = 0; i < pagesToProcess.length; i++) {
        if (this.checkCancelled()) {
          return this.createErrorOutput(PDFErrorCode.PROCESSING_CANCELLED, 'Processing was cancelled.');
        }

        const pageIndex = pagesToProcess[i];
        const page = pdf.getPage(pageIndex);
        const { width, height } = page.getSize();
        const rotation = wmOptions.position === 'diagonal' ? -45 : (wmOptions.rotation || 0);
        const rad = (rotation * Math.PI) / 180;

        if (embeddedImage) {
          const w = imgWidth;
          const h = imgHeight;
          let cx = width / 2;
          let cy = height / 2;

          switch (wmOptions.position) {
            case 'top-left':
              cx = 50 + w / 2;
              cy = height - 50 - h / 2;
              break;
            case 'top-right':
              cx = width - 50 - w / 2;
              cy = height - 50 - h / 2;
              break;
            case 'bottom-left':
              cx = 50 + w / 2;
              cy = 50 + h / 2;
              break;
            case 'bottom-right':
              cx = width - 50 - w / 2;
              cy = 50 + h / 2;
              break;
            case 'diagonal':
            case 'center':
            default:
              cx = width / 2;
              cy = height / 2;
          }

          // Compute bottom-left coordinate (x, y) so image rotates around its center (cx, cy)
          const x = cx - (w / 2) * Math.cos(rad) + (h / 2) * Math.sin(rad);
          const y = cy - (w / 2) * Math.sin(rad) - (h / 2) * Math.cos(rad);

          page.drawImage(embeddedImage, {
            x,
            y,
            width: w,
            height: h,
            opacity: wmOptions.opacity || 0.3,
            rotate: pdfLib.degrees(rotation),
          });
        } else if (isVectorText && font && wmOptions.text) {
          const text = wmOptions.text;
          const fontSize = wmOptions.fontSize || 48;
          const w = textWidth;
          const h = textHeight;
          let cx = width / 2;
          let cy = height / 2;

          switch (wmOptions.position) {
            case 'top-left':
              cx = 50 + w / 2;
              cy = height - 50 - h / 2;
              break;
            case 'top-right':
              cx = width - 50 - w / 2;
              cy = height - 50 - h / 2;
              break;
            case 'bottom-left':
              cx = 50 + w / 2;
              cy = 50 + h / 2;
              break;
            case 'bottom-right':
              cx = width - 50 - w / 2;
              cy = 50 + h / 2;
              break;
            case 'diagonal':
            case 'center':
            default:
              cx = width / 2;
              cy = height / 2;
          }

          const x = cx - (w / 2) * Math.cos(rad) + (h / 2) * Math.sin(rad);
          const y = cy - (w / 2) * Math.sin(rad) - (h / 2) * Math.cos(rad);

          const parsedCol = parseColor(wmOptions.color);
          page.drawText(text, {
            x,
            y,
            size: fontSize,
            font,
            color: pdfLib.rgb(parsedCol.r, parsedCol.g, parsedCol.b),
            opacity: wmOptions.opacity || 0.3,
            rotate: pdfLib.degrees(rotation),
          });
        }

        this.updateProgress(30 + (60 * (i + 1) / pagesToProcess.length), `Processing page ${pageIndex + 1}...`);
      }

      this.updateProgress(95, 'Saving PDF...');
      const pdfBytes = await pdf.save({ useObjectStreams: true });
      const blob = new Blob([new Uint8Array(pdfBytes)], { type: 'application/pdf' });

      this.updateProgress(100, 'Complete!');
      return this.createSuccessOutput(blob, file.name.replace('.pdf', '_watermarked.pdf'), { pageCount: totalPages });

    } catch (error) {
      return this.createErrorOutput(PDFErrorCode.PROCESSING_FAILED, 'Failed to add watermark.', error instanceof Error ? error.message : 'Unknown error');
    }
  }

  protected getAcceptedTypes(): string[] {
    return ['application/pdf'];
  }
}

function getPageIndices(pages: WatermarkOptions['pages'], totalPages: number): number[] {
  if (Array.isArray(pages)) {
    return pages.map(p => p - 1).filter(p => p >= 0 && p < totalPages);
  }
  switch (pages) {
    case 'odd':
      return Array.from({ length: totalPages }, (_, i) => i).filter(i => i % 2 === 0);
    case 'even':
      return Array.from({ length: totalPages }, (_, i) => i).filter(i => i % 2 === 1);
    default:
      return Array.from({ length: totalPages }, (_, i) => i);
  }
}

export function createWatermarkProcessor(): WatermarkProcessor {
  return new WatermarkProcessor();
}

export async function addWatermark(file: File, options: WatermarkOptions, onProgress?: ProgressCallback): Promise<ProcessOutput> {
  const processor = createWatermarkProcessor();
  return processor.process({ files: [file], options: options as unknown as Record<string, unknown> }, onProgress);
}
