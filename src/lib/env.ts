/**
 * Environment variable access with real validation.
 *
 * The naive version of this — `if (!value) throw` — has a hole that cost real
 * debugging time: `.env.local` copied from `.env.example` contains
 * `https://<your-project-ref>.supabase.co`, which is a perfectly non-empty
 * string. The check passes, and the failure surfaces much later as
 * `Invalid supabaseUrl: Provided URL is malformed.` from deep inside
 * supabase-js, with no hint that the cause is an unedited config file.
 *
 * So these check the *shape* of the value, not just its presence, and say
 * exactly what to do about it.
 */

/**
 * Thrown when configuration is missing or still holds a template placeholder.
 *
 * Distinct from a runtime error on purpose: the route turns it into a 500 with
 * `code: "configuration_error"` and the full message, because "you did not fill
 * in .env.local" is safe to state plainly and is the single most useful thing a
 * developer can be told. Real internal errors stay redacted in production.
 */
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

const SETUP_HINT =
  "Copy .env.example to .env.local and fill in the real values from " +
  "Supabase Dashboard → Settings → API, then restart the dev server " +
  "(Next.js only reads .env files at startup).";

/**
 * Read a required environment variable.
 *
 * Never echoes the value — some of these are secrets, and an error message is
 * exactly the kind of thing that ends up in a log aggregator.
 */
export function requireEnv(name: string): string {
  const raw = process.env[name];

  if (raw === undefined || raw.trim() === "") {
    throw new ConfigurationError(`${name} is not set. ${SETUP_HINT}`);
  }

  const value = raw.trim();

  // Every placeholder in .env.example is wrapped in angle brackets, and no
  // legitimate Supabase URL or JWT contains one.
  if (value.includes("<") || value.includes(">")) {
    throw new ConfigurationError(
      `${name} still contains the placeholder text from .env.example. ${SETUP_HINT}`,
    );
  }

  return value;
}

/**
 * Read a required environment variable that must be a URL.
 *
 * The URL is not a secret, so malformed values are echoed back — seeing the
 * actual string is usually enough to spot a trailing slash, a missing https://,
 * or a copied-but-not-edited placeholder.
 */
export function requireUrlEnv(name: string): string {
  const value = requireEnv(name);

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigurationError(
      `${name} is not a valid URL: "${value}". ` +
        `Expected something like https://abcdefghijklm.supabase.co`,
    );
  }

  const isLocal =
    parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";

  if (parsed.protocol !== "https:" && !isLocal) {
    throw new ConfigurationError(
      `${name} must use https. Got "${value}".`,
    );
  }

  return value;
}
