/**
 * [SECURITY_CHECKLIST #65] Secrets come from `NAME_FILE` (a Docker secret file)
 * rather than the `NAME` environment variable: environment variables leak
 * through `docker inspect`, `/proc/<pid>/environ`, crash dumps and careless
 * logging. Production refuses the environment-variable form outright.
 */
import fs from "fs";

export function readSecret(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  isProduction = env.NODE_ENV === "production",
): string | undefined {
  const direct = env[name];
  const file = env[`${name}_FILE`];
  if (direct && file) throw new Error(`${name} and ${name}_FILE are both set: keep only ${name}_FILE`);
  if (direct) {
    if (isProduction) {
      throw new Error(
        `${name} must not be passed as an environment variable in production: ` +
          `mount it as a Docker secret and set ${name}_FILE [SECURITY_CHECKLIST #65]`,
      );
    }
    return direct.trim();
  }
  if (file) {
    const value = fs.readFileSync(file, "utf8").trim();
    if (!value) throw new Error(`${name}_FILE points to an empty file`);
    return value;
  }
  return undefined;
}
