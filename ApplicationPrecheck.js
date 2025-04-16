const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { app } = require('electron');
const logger = require('./logger');
const ERROR_TYPES = require('./error-types');

class ApplicationPrecheck {

  /**
   * Ejecuta todas las verificaciones de pre-requisitos críticos.
   * Lanza un error estructurado si alguna verificación falla.
   * @throws {Error} Error estructurado con type = ERROR_TYPES.PRECHECK_ERROR
   */
  static async runFullCheck() {
    logger.info('Iniciando verificaciones previas de la aplicación...');

    const checks = [
      { name: 'userData Directory Writable', fn: this.checkUserDataPermissions },
      { name: 'Temp Directory Writable', fn: this.checkTempPermissions },
      // Podrían añadirse más checks críticos si son necesarios para tu app específica
    ];

    const errors = [];

    for (const check of checks) {
      try {
        logger.debug(`Ejecutando precheck: ${check.name}...`);
        await check.fn(); // Ejecutar la función de verificación estática
        logger.debug(`Precheck '${check.name}' superado.`);
      } catch (error) {
        logger.error(`Fallo en precheck '${check.name}': ${error.message}`);
        // Guardar solo el mensaje del error para el reporte final
        errors.push(`[${check.name}]: ${error.message}`);
        // Detenerse en el primer error crítico para evitar errores en cascada
        break;
      }
    }

    if (errors.length > 0) {
      // Crear un mensaje de error combinado (usando solo el primer error que ocurrió)
      const errorMessage = `Fallo verificación previa crítica: ${errors[0]}`;
      logger.fatal(errorMessage); // Usar fatal para indicar criticidad
      // Lanzar un único error estructurado
      throw this._createPrecheckError(errorMessage);
    }

    logger.info('Todas las verificaciones previas críticas superadas.');
  }

  /**
   * Verifica permisos de escritura en el directorio userData.
   * @throws {Error} Si no se puede escribir en el directorio.
   */
  static async checkUserDataPermissions() {
    let userDataPath;
    try {
      userDataPath = app.getPath('userData');
      if (!userDataPath) {
          throw new Error("No se pudo obtener la ruta userData desde Electron.");
      }
      logger.debug(`Verificando permisos de escritura en userData: ${userDataPath}`);
      await fs.ensureDir(userDataPath); // Asegurar que existe
      const testFile = path.join(userDataPath, `.precheck_write_test_${Date.now()}`);
      await fs.writeFile(testFile, 'test_write'); // Escribir algo
      await fs.access(testFile, fs.constants.W_OK); // Verificar permiso de escritura explícitamente
      await fs.unlink(testFile); // Limpiar
      logger.debug(`Permisos de escritura OK en userData.`);
    } catch (error) {
      // Proveer más detalles si es posible (ej. error.code)
      throw new Error(`No se puede escribir en directorio de datos (${userDataPath || 'ruta desconocida'}): ${error.message} (Code: ${error.code || 'N/A'})`);
    }
  }

  /**
   * Verifica permisos de escritura en el directorio temporal del sistema.
   * @throws {Error} Si no se puede escribir en el directorio.
   */
  static async checkTempPermissions() {
    let tempPath;
    try {
      tempPath = os.tmpdir();
       if (!tempPath) {
          throw new Error("No se pudo obtener la ruta del directorio temporal del sistema operativo.");
      }
      logger.debug(`Verificando permisos de escritura en temp: ${tempPath}`);
      await fs.ensureDir(tempPath);
      const testFile = path.join(tempPath, `.precheck_write_test_${Date.now()}`);
      await fs.writeFile(testFile, 'test_write');
      await fs.access(testFile, fs.constants.W_OK);
      await fs.unlink(testFile);
      logger.debug(`Permisos de escritura OK en temp.`);
    } catch (error) {
      throw new Error(`No se puede escribir en directorio temporal (${tempPath || 'ruta desconocida'}): ${error.message} (Code: ${error.code || 'N/A'})`);
    }
  }

  /**
   * Helper para crear un error estructurado de precheck.
   * @param {string} message - Mensaje de error.
   * @param {object} details - Detalles adicionales.
   * @returns {Error} Objeto Error estructurado.
   */
  static _createPrecheckError(message, details = {}) {
    const error = new Error(message);
    error.type = ERROR_TYPES.PRECHECK_ERROR;
    error.timestamp = Date.now();
    error.id = `${ERROR_TYPES.PRECHECK_ERROR}_${Date.now()}`;
    error.critical = true; // Errores de precheck siempre son críticos
    error.details = details;
    return error;
  }
}

module.exports = ApplicationPrecheck;