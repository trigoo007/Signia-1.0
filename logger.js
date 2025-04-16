const { app } = require('electron');
const winston = require('winston');
const path = require('path');
const fs = require('fs-extra');
const { format } = winston;

// Determinar el directorio para los logs
let logDirectory;
try {
  // Usar getPath solo si la app está lista
  logDirectory = app.isReady()
    ? path.join(app.getPath('userData'), 'logs')
    : path.join(process.cwd(), 'logs'); // Fallback inicial
} catch (error) {
  // Fallback si no podemos obtener la ruta de app
  console.error("Error obteniendo ruta userData para logs, usando directorio actual:", error);
  logDirectory = path.join(process.cwd(), 'logs');
}

// Asegurar que el directorio de logs existe
try {
  fs.ensureDirSync(logDirectory); // Síncrono al inicio está bien aquí
} catch (error) {
  console.error(`Error crítico: No se pudo crear el directorio de logs en ${logDirectory}`, error);
  // No podemos usar el logger aquí porque aún no existe
}

// Añadir nivel personalizado 'fatal' a Winston
const customLevels = {
  levels: {
    fatal: 0, // Más severo
    error: 1,
    warn: 2,
    info: 3,
    debug: 4, // Menos severo
  },
  colors: {
    fatal: 'bold red', // Hacerlo más visible
    error: 'red',
    warn: 'yellow',
    info: 'green',
    debug: 'blue',
  }
};

// Formato base para los logs (usado por File y Console)
const baseLogFormat = format.combine(
  format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  format.errors({ stack: true }), // Incluir stack trace
  format.splat(), // Para formato tipo printf (%s, %d)
  format.printf(({ level, message, timestamp, stack, service, error, ...meta }) => {
    const levelString = level.toUpperCase(); // Nivel en mayúsculas

    // Formatear metadata adicional
    const metaToLog = { ...meta };
    if(error && meta.error) delete metaToLog.error; // Evitar duplicar
    const metaString = Object.keys(metaToLog).length ? JSON.stringify(metaToLog) : '';

    let logEntry = `${timestamp} [${levelString}]${service ? ` [${service}]` : ''}: ${message}`;

    // Incluir detalles del Error si se pasó
    if (error instanceof Error) {
        if (!message.includes(error.message)) logEntry += ` | Error: ${error.message}`;
        if (error.stack) logEntry += `\nStack: ${error.stack}`;
    } else if (stack) { // Stack trace de format.errors()
        logEntry += `\nStack: ${stack}`;
    }

    if (metaString) logEntry += ` | Meta: ${metaString}`;
    return logEntry;
  })
);

// Aplicar colores para la consola
winston.addColors(customLevels.colors);
const consoleLogFormat = format.combine(
    format.colorize(), // Aplicar colores
    baseLogFormat      // Usar la estructura base
);

// Configurar el logger
const loggerInstance = winston.createLogger({
  levels: customLevels.levels,
  level: process.env.NODE_ENV === 'development' ? 'debug' : 'info',
  format: baseLogFormat, // Formato por defecto (para archivos)
  defaultMeta: { service: 'signia-app' }, // Nombre actualizado
  transports: [
    new winston.transports.File({
      filename: path.join(logDirectory, 'error.log'),
      level: 'error', // Captura 'error' y 'fatal'
      maxsize: 5 * 1024 * 1024, // 5MB
      maxFiles: 5,
      tailable: true,
      handleExceptions: true, // Capturar excepciones no manejadas
      handleRejections: true  // Capturar promesas rechazadas no manejadas
    }),
    new winston.transports.File({
      filename: path.join(logDirectory, 'combined.log'),
      level: process.env.NODE_ENV === 'development' ? 'debug' : 'info', // Nivel según entorno
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 10,
      tailable: true,
      handleExceptions: true, // También aquí por robustez
      handleRejections: true
    }),
  ],
  exitOnError: false // Importante: NO salir automáticamente al encontrar un error
});

// Añadir transporte de consola solo si no es producción
if (process.env.NODE_ENV !== 'production') {
  loggerInstance.add(new winston.transports.Console({
    level: 'debug', // Mostrar todo en consola dev
    format: consoleLogFormat, // Usar formato con color para consola
    handleExceptions: true,
    handleRejections: true
  }));
}

// Wrapper para desacoplar de Winston y añadir utilidades
const loggerWrapper = {
  _loggedOnceKeys: new Set(), // Para logOnce

  // Métodos de logging básicos
  debug: (message, ...meta) => loggerInstance.debug(message, ...meta),
  info: (message, ...meta) => loggerInstance.info(message, ...meta),
  warn: (message, ...meta) => loggerInstance.warn(message, ...meta),
  error: (message, errorOrMeta, ...meta) => {
    if (errorOrMeta instanceof Error) {
      loggerInstance.error(message, { error: errorOrMeta, ...meta });
    } else {
      loggerInstance.error(message, errorOrMeta, ...meta);
    }
  },
  fatal: (message, errorOrMeta, ...meta) => {
    if (errorOrMeta instanceof Error) {
      loggerInstance.log('fatal', message, { error: errorOrMeta, ...meta });
    } else {
      loggerInstance.log('fatal', message, errorOrMeta, ...meta);
    }
  },

  // Cambiar nivel de log dinámicamente
  setLevel: (level) => {
    if (!customLevels.levels[level]) {
      loggerInstance.warn(`Intento de establecer nivel de log inválido: ${level}`);
      return;
    }
    loggerInstance.level = level; // Cambiar nivel general
    // Cambiar nivel de transportes relevantes
    loggerInstance.transports.forEach((transport) => {
       // Solo cambiar nivel de consola y combined.log
       if (transport.name === 'console' || (transport.filename && transport.filename.includes('combined.log'))) {
            transport.level = level;
       }
    });
    loggerInstance.info(`Nivel de log cambiado a: ${level}`);
  },

  // Obtener ruta de logs
  getLogPath: () => logDirectory,

  // Obtener logs recientes (simplificado)
  getRecentLogs: async (level = 'info', lines = 100) => {
    try {
      const logFile = path.join(logDirectory, 'combined.log');
      if (!(await fs.pathExists(logFile))) return [];
      const content = await fs.readFile(logFile, 'utf8');
      // Devolver las últimas 'lines' líneas no vacías
      return content.split(/\r?\n/).filter(Boolean).slice(-lines);
    } catch (error) {
      console.error('Error leyendo logs:', error);
      // Devolver un array con el mensaje de error en lugar de lanzar
      return [`Error leyendo logs: ${error.message}`];
    }
  },

  // Loguear solo una vez por clave
  logOnce: (level, key, message, ...meta) => {
       if (!loggerWrapper._loggedOnceKeys.has(key)) {
           loggerWrapper._loggedOnceKeys.add(key);
           // Llama al método de log correspondiente (debug, info, warn, error, fatal)
           if (typeof loggerWrapper[level] === 'function') {
                loggerWrapper[level](message, ...meta);
           } else {
               loggerInstance.log(level, message, ...meta); // Fallback a loggerInstance.log
           }
       }
   },
  warnOnce: (key, message, ...meta) => loggerWrapper.logOnce('warn', key, message, ...meta),
  errorOnce: (key, message, ...meta) => loggerWrapper.logOnce('error', key, message, ...meta)
};

module.exports = loggerWrapper;
