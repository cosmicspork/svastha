// Base64 <-> bytes, shared by anything that packs raw bytes into a JSON
// payload sealed under the vault key (the provenance codec's document
// envelope in sync.ts, and the encrypted export container in export.ts).

/** Chunked to avoid blowing the call stack on `String.fromCharCode(...bytes)`
 * for a multi-megabyte C-CDA document. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
