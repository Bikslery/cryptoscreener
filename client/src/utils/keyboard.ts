export function getEnglishLetterFromKeyCode(code: string): string | null {
  if (!code.startsWith('Key')) return null
  return code.replace('Key', '')
}
