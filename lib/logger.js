/**
 * Structured logger for video-transcoder (Better Stack / Pino).
 *
 * This module is VENDORED per-service -- do NOT try to share from /shared.
 * The Railway Dockerfile only COPY's the service directory, so anything
 * outside is invisible to the build. Keep this file self-contained.
 *
 * Behavior:
 *   - NODE_ENV === 'test' -> sync console transport (no worker thread).
 *     Pino's worker-thread transports cause Jest to hang on detectOpenHandles,
 *     so tests get a minimal sync logger.
 *   - BETTERSTACK_SOURCE_TOKEN + BETTERSTACK_INGESTING_HOST set ->
 *     multi-target: stdout (for Railway's native log capture) AND
 *     @logtail/pino (ships to Better Stack).
 *   - Otherwise -> plain JSON to stdout (dev mode without BetterStack env vars).
 *
 * Base context fields are attached to every log:
 *   service, env, commit, component
 */

const pino = require('pino');

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  '*.password',
  '*.token',
  '*.apiKey',
  '*.accessToken',
  '*.refreshToken',
];

const BASE_CONTEXT = {
  service: 'video-transcoder',
  env: process.env.RAILWAY_ENVIRONMENT || 'local',
  commit: (process.env.RAILWAY_GIT_COMMIT_SHA || 'local').slice(0, 7),
};

/**
 * Build the root Pino instance based on the current environment.
 * Called once at module load; child loggers branch off of this.
 */
function buildRootLogger() {
  // Test mode: sync logger so Jest doesn't hang on worker-thread transports.
  if (process.env.NODE_ENV === 'test') {
    return pino({
      level: 'silent', // keep test output clean; flip to 'info' to debug
      base: BASE_CONTEXT,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    });
  }

  const hasBetterStack =
    !!process.env.BETTERSTACK_SOURCE_TOKEN &&
    !!process.env.BETTERSTACK_INGESTING_HOST;

  if (hasBetterStack) {
    // Production / UAT: ship to Better Stack AND stdout in parallel.
    const transport = pino.transport({
      targets: [
        {
          target: 'pino/file',
          level: LOG_LEVEL,
          options: { destination: 1 }, // stdout for Railway log capture
        },
        {
          target: '@logtail/pino',
          level: LOG_LEVEL,
          options: {
            sourceToken: process.env.BETTERSTACK_SOURCE_TOKEN,
            options: {
              endpoint: `https://${process.env.BETTERSTACK_INGESTING_HOST}`,
            },
          },
        },
      ],
    });

    return pino(
      {
        level: LOG_LEVEL,
        base: BASE_CONTEXT,
        redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      },
      transport
    );
  }

  // Local dev without Better Stack creds: plain JSON to stdout.
  return pino({
    level: LOG_LEVEL,
    base: BASE_CONTEXT,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  });
}

const rootLogger = buildRootLogger();

/**
 * Create a child logger tagged with a component name.
 * Use one per subsystem so Better Stack dashboards can filter by component.
 *
 * @param {{ component: string }} opts
 * @returns {pino.Logger}
 */
function createLogger({ component } = {}) {
  if (!component) {
    throw new Error('createLogger requires a component name');
  }
  return rootLogger.child({ component });
}

module.exports = {
  createLogger,
  logger: rootLogger,
};
