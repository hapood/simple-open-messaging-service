export function otpKey(node, account) {
  return JSON.stringify([node, account]);
}

export function redactSecrets(value, secrets) {
  let text = String(value);
  for (const secret of [...secrets]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)) {
    for (const variant of new Set([
      secret,
      JSON.stringify(secret).slice(1, -1),
      encodeURIComponent(secret),
    ]))
      text = text.split(variant).join('[REDACTED]');
  }
  return text;
}
