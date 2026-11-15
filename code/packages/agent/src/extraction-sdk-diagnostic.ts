const MESSAGE_LIMIT = 512;
const WORKING_LIMIT = 8192;
const REDACTED = '[REDACTED]';

/** Error-message diagnostics only: never pass a prompt or a response body here. */
export function sdkErrorDiagnostic(message: string, knownSecrets: readonly string[] = []) {
  let safe = message;
  // Replace the complete configured secret before bounding the working string,
  // so a secret crossing either truncation boundary cannot leave a prefix.
  for (const secret of knownSecrets.filter(Boolean)) {
    safe = safe.split(secret).join(REDACTED);
    safe = safe.split(encodeURIComponent(secret)).join(REDACTED);
  }
  const workingTruncated = [...safe].length > WORKING_LIMIT;
  safe = [...safe].slice(0, WORKING_LIMIT).join('')
    .replace(/\b(?:https?|wss?):\/\/[^\s<>"']+/giu, '[URL_REDACTED]')
    .replace(/\b(?:proxy-)?authorization["']?\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n,;}]+)/giu, 'Authorization: [REDACTED]')
    .replace(/\b(?:bearer|basic)\s+[^\s"',;]+/giu, REDACTED)
    .replace(/\b(api[\s_-]?key|access[\s_-]?token|refresh[\s_-]?token|client[\s_-]?secret|token|secret|password|credential|signature|sig)["']?\s*(?:[:=]\s*|\s+(?:is\s+)?)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}&\]]+)/giu, '$1=[REDACTED]')
    .replace(/\b(?:sk|rk|pk|sess|key)-[A-Za-z0-9_-]{8,}/gu, REDACTED)
    .replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, REDACTED)
    .replace(/[A-Za-z0-9_+./=-]{32,}/gu, REDACTED)
    .replace(/\b(?:prompt|messages|input|output|response)["']?\s*[:=][\s\S]*/iu, '[REQUEST_OR_RESPONSE_CONTENT_OMITTED]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '');
  const points = [...safe], prefix = /^(TypeError|SyntaxError|RangeError|AbortError|TimeoutError|APIError|Error):\s/u.exec(safe)?.[1];
  return {
    sdk_error_message: points.slice(0, MESSAGE_LIMIT).join(''),
    sdk_error_message_truncated: workingTruncated || points.length > MESSAGE_LIMIT,
    sdk_error_message_redacted: true,
    sdk_error_type_hint: prefix ?? 'unknown',
    sdk_error_type_scope: 'explicit_message_prefix_only; Pi does not expose the underlying exception type or stack',
  };
}
