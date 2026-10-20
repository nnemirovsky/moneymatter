/**
 * The setup code of the card-payment shortcut: everything the shortcut needs to reach this
 * instance, in one pasteable or scannable string.
 *
 * Wire format: `v1.` + standard base64 (with padding) of the UTF-8 JSON
 * `{"v":1,"url":"…","token":"…","cfAccessId":"…","cfAccessSecret":"…","gate":"…"}`. The Cloudflare
 * Access fields are present only when set. `gate` is the amount-gate regex of a non-default
 * strictness; a code without it uses the standard pattern the shortcut carries. The Shortcuts
 * "Base64 Encode" action reads standard base64, not base64url, and `.` is not a base64 character,
 * so the shortcut strips the `v1.` prefix with a Replace Text step before decoding. The prefix
 * stays so a person and the server can tell the format apart; `v` versions the payload itself.
 *
 * A code carries a live credential: callers must neither log it nor store it.
 */

export const SETUP_CODE_PREFIX = 'v1.';
export const SETUP_CODE_VERSION = 1;
/**
 * Longest code (prefix included) that is built or accepted. A code without a `gate` stays under
 * `SETUP_CODE_QR_MAX_LENGTH`; one that carries a gate regex is longer and is pasted, not scanned.
 */
export const SETUP_CODE_MAX_LENGTH = 6144;
/** Longest code a QR code can carry and still scan on a phone. */
export const SETUP_CODE_QR_MAX_LENGTH = 2048;
/** Longest `gate` regex a code accepts. */
const SETUP_CODE_GATE_MAX_LENGTH = 4096;

export type SetupCodeErrorReason =
  | 'tooLarge'
  | 'badPrefix'
  | 'badEncoding'
  | 'badJson'
  | 'unsupportedVersion'
  | 'missingUrl'
  | 'invalidUrl'
  | 'missingToken'
  | 'invalidAccessHeaders'
  | 'invalidGate';

/** Carries a reason code only: the message never repeats any part of the code. */
export class SetupCodeError extends Error {
  reason: SetupCodeErrorReason;

  constructor({ reason }: { reason: SetupCodeErrorReason }) {
    super(`Invalid setup code: ${reason}`);
    this.name = 'SetupCodeError';
    this.reason = reason;
  }
}

export interface CardPaymentSetupCodePayload {
  url: string;
  token: string;
  cfAccessId?: string;
  cfAccessSecret?: string;
  /** The amount-gate regex (ICU syntax) the shortcut applies on the device; absent means the standard pattern. */
  gate?: string;
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/** Whether `value` parses as an absolute http(s) URL. */
export const isHttpUrl = ({ value }: { value: string }): boolean => {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
};

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

const toBase64 = ({ text }: { text: string }): string => {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);

  return btoa(binary);
};

const fromBase64 = ({ encoded }: { encoded: string }): string => {
  if (encoded.length % 4 !== 0 || !BASE64_PATTERN.test(encoded)) throw new SetupCodeError({ reason: 'badEncoding' });

  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));

    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new SetupCodeError({ reason: 'badEncoding' });
  }
};

/** Checks the fields a code needs, throwing the matching `SetupCodeError`. */
const assertPayload = ({ payload }: { payload: Record<string, unknown> }): CardPaymentSetupCodePayload => {
  const { url, token, cfAccessId, cfAccessSecret, gate } = payload;

  if (!isNonEmptyString(url)) throw new SetupCodeError({ reason: 'missingUrl' });
  if (!isHttpUrl({ value: url })) throw new SetupCodeError({ reason: 'invalidUrl' });
  if (!isNonEmptyString(token)) throw new SetupCodeError({ reason: 'missingToken' });

  const hasId = cfAccessId !== undefined;
  const hasSecret = cfAccessSecret !== undefined;

  if (hasId !== hasSecret) throw new SetupCodeError({ reason: 'invalidAccessHeaders' });
  if (hasId && (!isNonEmptyString(cfAccessId) || !isNonEmptyString(cfAccessSecret))) {
    throw new SetupCodeError({ reason: 'invalidAccessHeaders' });
  }

  if (gate !== undefined && (!isNonEmptyString(gate) || gate.length > SETUP_CODE_GATE_MAX_LENGTH)) {
    throw new SetupCodeError({ reason: 'invalidGate' });
  }

  return {
    url,
    token,
    ...(hasId && { cfAccessId: cfAccessId as string, cfAccessSecret: cfAccessSecret as string }),
    ...(gate !== undefined && { gate }),
  };
};

/** Builds the setup code, or throws `SetupCodeError` for an unusable payload or an oversize result. */
export const encodeSetupCode = (params: CardPaymentSetupCodePayload): string => {
  const { url, token, cfAccessId, cfAccessSecret, gate } = assertPayload({ payload: { ...params } });

  const json = JSON.stringify({
    v: SETUP_CODE_VERSION,
    url,
    token,
    ...(cfAccessId !== undefined && { cfAccessId, cfAccessSecret }),
    ...(gate !== undefined && { gate }),
  });
  const code = `${SETUP_CODE_PREFIX}${toBase64({ text: json })}`;

  if (code.length > SETUP_CODE_MAX_LENGTH) throw new SetupCodeError({ reason: 'tooLarge' });

  return code;
};

/** Reads a setup code, or throws `SetupCodeError` naming why it is unusable. */
export const decodeSetupCode = ({ code }: { code: string }): CardPaymentSetupCodePayload => {
  if (code.length > SETUP_CODE_MAX_LENGTH) throw new SetupCodeError({ reason: 'tooLarge' });
  if (!code.startsWith(SETUP_CODE_PREFIX)) throw new SetupCodeError({ reason: 'badPrefix' });

  const text = fromBase64({ encoded: code.slice(SETUP_CODE_PREFIX.length) });

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SetupCodeError({ reason: 'badJson' });
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SetupCodeError({ reason: 'badJson' });
  }

  const payload = parsed as Record<string, unknown>;
  if (payload.v !== SETUP_CODE_VERSION) throw new SetupCodeError({ reason: 'unsupportedVersion' });

  return assertPayload({ payload });
};
