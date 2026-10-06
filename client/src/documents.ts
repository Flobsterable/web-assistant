export type StoredDocument = {
  name: string;
  size: number;
  updatedAt: string;
};

export const documentAccept = '.md,.mdx,.txt,.html,.htm,.json,.js,.jsx,.ts,.tsx,.css,.py,.pdf';

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const block = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += block) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + block));
  }
  return window.btoa(binary);
}

export async function uploadDocument(file: File) {
  if (file.size > 20 * 1024 * 1024) throw new Error(`${file.name}: максимальный размер — 20 МБ.`);
  const response = await fetch('/api/documents/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: file.name, data: arrayBufferToBase64(await file.arrayBuffer()) })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Не удалось загрузить ${file.name}.`);
  return data;
}

export function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}
