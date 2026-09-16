/** Public registration is opt-in. Missing and malformed values fail closed. */
export function isRegistrationEnabled(
  value = process.env.REGISTRATION_ENABLED,
): boolean {
  return value === "true";
}
