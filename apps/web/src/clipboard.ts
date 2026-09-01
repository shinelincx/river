export type CopyTextArea = {
  value: string;
  style: { position: string; opacity: string; pointerEvents: string };
  setAttribute: (name: string, value: string) => void;
  focus: () => void;
  select: () => void;
  setSelectionRange: (start: number, end: number) => void;
};

export type CopyDocument = {
  body: {
    appendChild: (node: CopyTextArea) => void;
    removeChild: (node: CopyTextArea) => void;
  };
  createElement: (tagName: 'textarea') => CopyTextArea;
  execCommand: (command: 'copy') => boolean;
};

export type CopyEnvironment = {
  clipboard?: { writeText: (value: string) => Promise<void> };
  document?: CopyDocument;
};

function browserCopyEnvironment(): CopyEnvironment {
  return {
    clipboard: typeof navigator === 'undefined' ? undefined : navigator.clipboard,
    document: typeof document === 'undefined' ? undefined : document as unknown as CopyDocument
  };
}

export async function copyText(value: string, environment: CopyEnvironment = browserCopyEnvironment()): Promise<boolean> {
  try {
    if (environment.clipboard?.writeText) {
      await environment.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Clipboard API may be unavailable or denied on non-secure HTTP origins.
  }

  const copyDocument = environment.document;
  if (!copyDocument) return false;
  const textArea = copyDocument.createElement('textarea');
  textArea.value = value;
  textArea.setAttribute('readonly', '');
  textArea.setAttribute('aria-hidden', 'true');
  textArea.style.position = 'fixed';
  textArea.style.opacity = '0';
  textArea.style.pointerEvents = 'none';
  copyDocument.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  textArea.setSelectionRange(0, value.length);
  try {
    return copyDocument.execCommand('copy');
  } catch {
    return false;
  } finally {
    copyDocument.body.removeChild(textArea);
  }
}
