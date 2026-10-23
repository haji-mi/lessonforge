export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // TS5.7+ 的 Uint8Array 泛型与 BufferSource 不兼容，边界胶水处显式断言（运行时即 ArrayBuffer 视图）
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
