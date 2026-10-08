/**
 * Fields whose contents Steplight never reads, whatever the capture level or settings.
 * These rules are always on and cannot be switched off.
 *
 * The same test is repeated inline in the self-contained page scripts (`collectPageScan` and the
 * Playwright SDK's page listeners), because those are serialised into the page and cannot import
 * this module. A unit test keeps the copies in sync with {@link NEVER_CAPTURE_NAME_PATTERN}.
 */

/** Field names / ids / labels that mean "secret or payment data". Applied after splitting camelCase. */
export const NEVER_CAPTURE_NAME_PATTERN =
  /(^|[^a-z0-9])(card|cc|cvv|cvc|csc|otp|pin|ssn|aadhaar|aadhar|pan|passcode|password|passwd|pwd|iban|secret|token|csrf)\d{0,2}([^a-z0-9]|$)|cardnum|creditcard|ccnum|cvv2|cardno|panno|aadhaarno/i;

/** `autocomplete` tokens that mark payment or credential fields. */
export const NEVER_CAPTURE_AUTOCOMPLETE = /(^|\s)(cc-[a-z-]+|one-time-code|current-password|new-password)(\s|$)/i;

/** Payment providers whose embedded frames hold card entry; anything editable inside them is off limits. */
export const PAYMENT_FRAME_HOSTS: readonly string[] = [
  "stripe.com", "js.stripe.com", "paypal.com", "braintreegateway.com", "adyen.com", "checkout.com",
  "razorpay.com", "paytm.com", "payu.in", "payu.com", "squareup.com", "squarecdn.com", "worldpay.com",
  "authorize.net", "cybersource.com", "klarna.com", "mollie.com", "recurly.com", "bluesnap.com",
];

/** What we know about a form control or editable element. */
export interface FieldDescriptor {
  /** Element tag, lowercase (`input`, `textarea`, `select`, `div`). */
  tag?: string;
  type?: string;
  name?: string;
  id?: string;
  autocomplete?: string;
  ariaLabel?: string;
  placeholder?: string;
  label?: string;
  contentEditable?: boolean;
  /** The element lives inside a frame served by a payment provider. */
  inPaymentFrame?: boolean;
}

/** Split camelCase / PascalCase so `userPin` is tested as `user_Pin`. */
const splitWords = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2");

/**
 * True when the field must never be read: password inputs, payment / one-time-code
 * `autocomplete` values, names that look like card / CVV / OTP / PIN / SSN / Aadhaar / PAN /
 * password / token fields, and anything editable inside a known payment frame.
 * @example isNeverCaptureField({ tag: "input", type: "password" }) // true
 * @example isNeverCaptureField({ tag: "input", name: "cardNumber" }) // true
 * @example isNeverCaptureField({ tag: "input", name: "email" }) // false
 */
export function isNeverCaptureField(field: FieldDescriptor): boolean {
  if (field.inPaymentFrame && (field.contentEditable || ["input", "textarea", "select"].includes(field.tag ?? ""))) return true;
  if ((field.type ?? "").toLowerCase() === "password") return true;
  if (field.autocomplete && NEVER_CAPTURE_AUTOCOMPLETE.test(field.autocomplete)) return true;
  const text = [field.name, field.id, field.ariaLabel, field.placeholder, field.label].filter(Boolean).map((v) => splitWords(String(v))).join(" ");
  return text.length > 0 && NEVER_CAPTURE_NAME_PATTERN.test(text);
}

/** Is this URL served by a known payment provider? */
export function isPaymentFrameUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return PAYMENT_FRAME_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}
