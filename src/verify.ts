import crypto from 'crypto';

const TOLERANCE_SEC = 300;

export function verifySignature(
  headers: Record<string, string | string[] | undefined>,
  rawBody: Buffer,
): boolean {
  const secret = process.env.RECALL_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('[verify] RECALL_WEBHOOK_SECRET non impostato — verifica saltata');
    return true;
  }

  const msgId        = (headers['webhook-id']        ?? headers['svix-id'])        as string | undefined;
  const msgTimestamp = (headers['webhook-timestamp']  ?? headers['svix-timestamp']) as string | undefined;
  const msgSignature = (headers['webhook-signature']  ?? headers['svix-signature']) as string | undefined;

  if (!msgId || !msgTimestamp || !msgSignature) {
    console.warn('[verify] header Svix mancanti');
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(msgTimestamp, 10)) > TOLERANCE_SEC) {
    console.warn('[verify] timestamp fuori tolleranza');
    return false;
  }

  const keyBytes    = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const toSign      = `${msgId}.${msgTimestamp}.${rawBody.toString('utf8')}`;
  const expectedB64 = crypto.createHmac('sha256', keyBytes).update(toSign).digest('base64');
  const expectedBuf = Buffer.from(expectedB64, 'base64');

  for (const versionedSig of msgSignature.split(' ')) {
    const [version, signature] = versionedSig.split(',');
    if (version !== 'v1' || !signature) continue;
    const sigBuf = Buffer.from(signature, 'base64');
    if (sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      return true;
    }
  }
  return false;
}
