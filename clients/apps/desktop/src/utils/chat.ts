// Strip action narration (*action text*) from TTS input, preserving **bold**
export function stripNarration(text: string): string {
  return text.replace(/(?<!\*)\*(?!\*)([^*]+)\*(?!\*)/g, '').replace(/\s{2,}/g, ' ').trim();
}

// Helper function to convert File to base64
export async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => {
      const result = reader.result as string;
      // Remove the data URL prefix (e.g., "data:image/png;base64,")
      const base64 = result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
  });
}
