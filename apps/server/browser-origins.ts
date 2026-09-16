/** The Expo development server; deployments supply their exact web origins. */
export function browserOrigins(value = process.env.CORS_ORIGIN): string[] {
  return (value ?? "http://localhost:8081,http://127.0.0.1:8081")
    .split(",").map((origin) => origin.trim()).filter(Boolean);
}
