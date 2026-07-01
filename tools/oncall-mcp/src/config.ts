function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = Object.freeze({
  baseUrl: requireEnv("ONCALL_BASE_URL"),
  adminPhone: requireEnv("ONCALL_ADMIN_PHONE"),
});
