import { LoggerModule } from 'nestjs-pino';

/**
 * Pino logging — mirrors the fantasy-pro-league backend setup.
 *
 * Local/dev gets pretty, colourised, human-readable logs via `pino-pretty`;
 * production (and tests) emit structured JSON. Tests deliberately skip the
 * pretty transport too: pino-pretty runs in a worker thread, which would
 * otherwise keep Jest from exiting cleanly.
 */
const nodeEnv = process.env.NODE_ENV ?? 'development';
const isProduction = nodeEnv === 'production';
const isTest = nodeEnv === 'test';
const usePretty = !isProduction && !isTest;

const prettyPrint = {
  sync: true,
  levelFirst: true,
  translateTime: 'mmm dd, HH:MM:ss',
  ignore: 'pid,hostname',
  customColors: Object.entries({
    trace: 'magentaBright',
    debug: 'whiteBright',
    info: 'greenBright',
    warn: 'yellowBright',
    error: 'redBright',
    fatal: 'red',
  })
    .map(([level, color]) => `${level}:${color}`)
    .join(','),
};

const prettyTransport = {
  target: 'pino-pretty',
  options: prettyPrint,
};

const formatters = {
  level(label: string): { level: string } {
    return { level: label };
  },
};

export const PinoModule = LoggerModule.forRoot({
  pinoHttp: {
    // LOG_LEVEL wins if set; otherwise verbose in dev, lean in prod.
    level: process.env.LOG_LEVEL ?? (usePretty ? 'debug' : 'info'),
    autoLogging: false,
    transport: usePretty ? prettyTransport : undefined,
    formatters,
    serializers: { req: () => undefined },
  },
});
