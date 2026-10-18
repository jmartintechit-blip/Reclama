// Just enough PDF reading for the tests of the letter: the page count, the page sizes and the
// text that pdfkit wrote. pdfkit compresses every content stream with Flate, so the streams are
// inflated here instead of weakening the compression of the real output.
import { inflateSync } from 'node:zlib';

const WIN_ANSI = new TextDecoder('windows-1252');

export interface PdfSummary {
  startsWithMagic: boolean;
  endsWithEof: boolean;
  pageCount: number;
  mediaBoxes: string[]; // one per page, as written ("[0 0 595.28 841.89]")
}

export function summarizePdf(bytes: Uint8Array): PdfSummary {
  const raw = Buffer.from(bytes).toString('latin1');
  return {
    startsWithMagic: raw.startsWith('%PDF-'),
    endsWithEof: raw.trimEnd().endsWith('%%EOF'),
    pageCount: (raw.match(/\/Type \/Page\b(?!s)/g) ?? []).length,
    mediaBoxes: raw.match(/\/MediaBox \[[^\]]*\]/g) ?? [],
  };
}

// Every inflated stream of the file, in file order (as Latin-1 text, so one character is one byte).
export function inflatedStreams(bytes: Uint8Array): string[] {
  const raw = Buffer.from(bytes).toString('latin1');
  const streams: string[] = [];
  for (const match of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    try {
      streams.push(
        inflateSync(Buffer.from(match[1] ?? '', 'latin1')).toString('latin1'),
      );
    } catch {
      // not a Flate stream: nothing the tests read
    }
  }
  return streams;
}

// The text of one content stream, one line per drawing operation. pdfkit writes standard-font
// text as hex strings of Windows-1252 bytes inside `[<...> kerning <...>] TJ`.
function textOf(stream: string): string[] {
  const lines: string[] = [];
  for (const operation of stream.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
    let line = '';
    for (const hex of (operation[1] ?? '').matchAll(/<([0-9a-fA-F]*)>/g)) {
      line += WIN_ANSI.decode(Buffer.from(hex[1] ?? '', 'hex'));
    }
    lines.push(line);
  }
  return lines;
}

// The content streams that draw text: with pdfkit, one per page and in page order.
const pageStreams = (bytes: Uint8Array): string[] =>
  inflatedStreams(bytes).filter((stream) => /\sTJ/.test(stream));

// The text drawn on every page.
export function extractPdfText(bytes: Uint8Array): string {
  return pageStreams(bytes).flatMap(textOf).join('\n');
}

// The lines of text of one page (1-based).
export function extractPdfPageLines(bytes: Uint8Array, page: number): string[] {
  return textOf(pageStreams(bytes)[page - 1] ?? '');
}
