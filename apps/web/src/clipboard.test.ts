import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText, type CopyDocument, type CopyTextArea } from './clipboard';

function selectionFallback(result = true) {
  const textArea: CopyTextArea = {
    value: '',
    style: { position: '', opacity: '', pointerEvents: '' },
    setAttribute: vi.fn(),
    focus: vi.fn(),
    select: vi.fn(),
    setSelectionRange: vi.fn()
  };
  const document: CopyDocument = {
    body: { appendChild: vi.fn(), removeChild: vi.fn() },
    createElement: vi.fn(() => textArea),
    execCommand: vi.fn(() => result)
  };
  return { document, textArea };
}

describe('copyText', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses browser globals when no environment is injected', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const { document } = selectionFallback();
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    vi.stubGlobal('document', document);

    await expect(copyText('RIVER-ABC')).resolves.toBe(true);

    expect(writeText).toHaveBeenCalledWith('RIVER-ABC');
  });

  it('uses the Clipboard API when permission is available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const { document } = selectionFallback();

    await expect(copyText('RIVER-ABC', { clipboard: { writeText }, document })).resolves.toBe(true);

    expect(writeText).toHaveBeenCalledWith('RIVER-ABC');
    expect(document.createElement).not.toHaveBeenCalled();
  });

  it('falls back to a temporary selection when Clipboard API permission is denied', async () => {
    const { document, textArea } = selectionFallback();

    await expect(copyText('RIVER-ABC', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')) },
      document
    })).resolves.toBe(true);

    expect(textArea.value).toBe('RIVER-ABC');
    expect(textArea.focus).toHaveBeenCalledOnce();
    expect(textArea.select).toHaveBeenCalledOnce();
    expect(document.execCommand).toHaveBeenCalledWith('copy');
    expect(document.body.removeChild).toHaveBeenCalledWith(textArea);
  });

  it('uses the selection fallback when the Clipboard API is unavailable', async () => {
    const { document } = selectionFallback();

    await expect(copyText('http://example.test/join/RIVER-ABC', { document })).resolves.toBe(true);

    expect(document.execCommand).toHaveBeenCalledWith('copy');
  });

  it('cleans up and reports failure when the selection command throws', async () => {
    const { document, textArea } = selectionFallback();
    vi.mocked(document.execCommand).mockImplementation(() => { throw new Error('copy denied'); });

    await expect(copyText('RIVER-ABC', { document })).resolves.toBe(false);

    expect(document.body.removeChild).toHaveBeenCalledWith(textArea);
  });

  it('reports failure when neither browser copy mechanism is available', async () => {
    await expect(copyText('RIVER-ABC', {})).resolves.toBe(false);
  });
});
