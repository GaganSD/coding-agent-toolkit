/** Conservative disclosure eligibility, not a proof of safety. Hosted review is
 * opt-in and sends exact command text. Compositions, expansions and known secret
 * spellings stay local; arbitrary text can still contain unrecognized secrets.
 */
export function reviewableCommand(command: string): boolean {
  return command.length > 0 && command.length <= 8000
    && !/[\x00-\x1f\x7f-\x9f~$`;&|><()\\*?]/.test(command)
    && !/^(?:sort|date|diff)(?:\s|$)/.test(command.trim())
    && !/(?:\.env\b|\.ssh\b|\.pi\b|\.git\b|id_rsa|id_ed25519|\.(?:pem|key)\b|token|password|secret|api[-_]?key|credential|authorization)/i.test(command);
}
