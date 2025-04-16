const os = require('os');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const axios = require('axios');
const { performance } = require('perf_hooks');
const { app } = require('electron');
const logger = require('./logger'); // Usa logger global

class SystemRequirementsChecker {

  static async checkDictaphoneSupport() {
    try {
      logger.info('Verificando soporte para dictáfonos...');
      let HID;
      try {
        HID = require('node-hid'); // Intenta cargar node-hid
        logger.debug('Módulo node-hid cargado correctamente.');
      } catch (error) {
        logger.warn('No se pudo cargar node-hid:', error.message);
        return {
          supported: false,
          error: `node-hid no cargado: ${error.message}`,
          details: 'Verifique instalación y ejecute "npm run rebuild".'
        };
      }
      // Si cargó, intenta listar dispositivos
      try {
        const devices = HID.devices();
        logger.debug(`Encontrados ${devices.length} dispositivos HID.`);
        const knownVendors = new Set([0x0911, 0x0471, 0x07B4]); // Philips, Grundig, Olympus (Ejemplo)
        const dictaphoneDevices = devices.filter(d => d.path && knownVendors.has(d.vendorId)); // Filtrar por vendor y asegurar que tengan path

        return {
          supported: true, // node-hid funciona
          devicesFound: dictaphoneDevices.length,
          list: dictaphoneDevices.map(d => ({
            manufacturer: d.manufacturer || 'Desconocido',
            product: d.product || 'Dispositivo',
            vendorId: d.vendorId, productId: d.productId, path: d.path
          }))
        };
      } catch (error) {
        logger.warn('Error listando dispositivos HID:', error);
        return {
          supported: false, // Considerar no soportado si falla la enumeración
          error: `Error listando dispositivos HID: ${error.message}`,
          details: 'Verifique permisos USB/HID o drivers.'
        };
      }
    } catch (error) { // Error inesperado en el proceso
      logger.error('Error fatal verificando soporte dictáfono:', error);
      return { supported: false, error: `Error general: ${error.message}` };
    }
  }

  static async checkDatabaseSupport() {
     try {
        logger.info('Verificando soporte para base de datos SQLite...');
        let sqlite3;
        try { sqlite3 = require('sqlite3'); logger.debug(`Módulo sqlite3 cargado. V: ${sqlite3.VERSION}`); }
        catch (error) { logger.warn('No se pudo cargar sqlite3:', error.message); return { supported: false, error: `sqlite3 no cargado: ${error.message}` }; }
        let featureSupport = { json1: false }; let dbVersion = 'N/A';
        const tempDbPath = path.join(os.tmpdir(), `temp_check_${Date.now()}.sqlite`); let db = null;
        try {
            // Helpers promisificados
            const openDb = () => new Promise((resolve, reject) => { db = new sqlite3.Database(tempDbPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => { if(err) reject(err); else resolve(); }); });
            const closeDb = () => new Promise((resolve) => { if (db) db.close((err) => resolve()); else resolve(); }); // Resolver siempre al cerrar
            const getQuery = (sql) => new Promise((resolve, reject) => db.get(sql, (err, row) => err ? reject(err) : resolve(row)));
            const runQuery = (sql) => new Promise((resolve, reject) => db.run(sql, err => err ? reject(err) : resolve()));

            await openDb();
            const versionRow = await getQuery("SELECT sqlite_version() as version");
            dbVersion = versionRow?.version || 'Error';
            logger.debug(`Versión SQLite detectada: ${dbVersion}`);
            try { await runQuery("SELECT json_extract('{}', '$')"); featureSupport.json1 = true; } catch { logger.warn("Función JSON1 SQLite no soportada."); }
            // Añadir aquí checks para otras features como FTS5 si son necesarias
            return { supported: true, node_module_version: sqlite3.VERSION, sqlite_version: dbVersion, features: featureSupport };
        } catch (error) { logger.error('Error verificando características SQLite:', error); return { supported: false, node_module_version: sqlite3?.VERSION || 'N/A', error: `Error verificando: ${error.message}` }; }
        finally { await closeDb(); try { if(await fs.pathExists(tempDbPath)) await fs.unlink(tempDbPath); } catch(e) { logger.warn(`No se pudo eliminar DB temporal ${tempDbPath}: ${e.message}`); } }
     } catch (error) { logger.error('Error fatal verificando soporte DB:', error); return { supported: false, error: `Error general: ${error.message}` }; }
  }

  static async checkSystemSpecs() {
    try {
      logger.info('Verificando especificaciones del sistema...');
      const cpuInfo = os.cpus(); const totalMemory = os.totalmem(); const freeMemory = os.freemem();
      const platform = os.platform(); const release = os.release(); const arch = os.arch();
      const diskSpace = await this._checkDiskSpace(); // Llama a la función interna
      return {
        cpu: { model: cpuInfo[0]?.model || 'N/A', cores: cpuInfo.length, speed: cpuInfo[0]?.speed || 0 },
        memory: { total: totalMemory, free: freeMemory, totalGB: (totalMemory / (1024**3)).toFixed(2), freeGB: (freeMemory / (1024**3)).toFixed(2) },
        os: { platform, release, arch }, disk: diskSpace
      };
    } catch (error) { logger.error('Error verificando specs:', error); return { error: `Error verificando specs: ${error.message}` }; }
  }

  // Helper interno para espacio en disco
  static async _checkDiskSpace() {
    let userDataPath = ''; try { userDataPath = app.getPath('userData'); } catch { userDataPath = process.cwd(); } // Fallback si app no está lista
    try {
        let freeSpace = 0, totalSpace = 0, checkPath = userDataPath;
        try { // Intenta usar 'diskusage' primero
            const diskusage = require('diskusage');
            // En Windows, es mejor chequear la raíz de la unidad donde está userData
            checkPath = process.platform === 'win32' ? path.parse(userDataPath).root : userDataPath;
            const info = await diskusage.check(checkPath);
            freeSpace = info.available; // Espacio disponible para usuario normal
            totalSpace = info.total;
            logger.debug(`diskusage [${checkPath}]: Disponible=${(freeSpace / (1024**3)).toFixed(2)}GB, Total=${(totalSpace / (1024**3)).toFixed(2)}GB`);
        } catch (diskUsageError) {
            logger.warn(`diskusage no disponible/falló (${diskUsageError.message}). Usando fallback con exec...`);
            try { // Fallback con comandos del sistema
                if (process.platform === 'win32') {
                    const drive = path.parse(userDataPath).root.charAt(0);
                    const { stdout } = await exec(`wmic logicaldisk where DeviceID="${drive}:" get FreeSpace,Size /VALUE`);
                    const freeMatch = stdout.match(/FreeSpace=(\d+)/);
                    const totalMatch = stdout.match(/Size=(\d+)/);
                    if (freeMatch) freeSpace = parseInt(freeMatch[1], 10);
                    if (totalMatch) totalSpace = parseInt(totalMatch[1], 10);
                } else { // Mac/Linux
                    const { stdout } = await exec(`df -k "${userDataPath}"`);
                    const lines = stdout.trim().split('\n');
                    if (lines.length >= 2) {
                        const values = lines[1].trim().split(/\s+/);
                        if (values.length >= 4) {
                            totalSpace = parseInt(values[1], 10) * 1024; // Size (col 2) * 1k block
                            freeSpace = parseInt(values[3], 10) * 1024; // Available (col 4) * 1k block
                        }
                    }
                }
                 logger.debug(`Fallback exec: Disponible=${(freeSpace / (1024**3)).toFixed(2)}GB, Total=${(totalSpace / (1024**3)).toFixed(2)}GB`);
            } catch (execError) {
                 logger.error(`Fallback exec para espacio en disco falló: ${execError.message}`);
                 // Último recurso: fs.statfs (menos preciso a veces)
                 try {
                     const stats = await fs.statfs(userDataPath);
                     freeSpace = stats.bavail * stats.bsize; totalSpace = stats.blocks * stats.bsize;
                     logger.debug(`Fallback fs.statfs: Disponible=${(freeSpace / (1024**3)).toFixed(2)}GB, Total=${(totalSpace / (1024**3)).toFixed(2)}GB`);
                 } catch (statfsError) {
                     logger.error(`fs.statfs también falló: ${statfsError.message}`);
                     throw new Error(`No se pudo determinar espacio en disco: ${execError.message}; ${statfsError.message}`); // Relanzar error combinado
                 }
            }
        }
        // Devolver resultado exitoso
        return { path: checkPath, free: freeSpace, total: totalSpace, freeGB: (freeSpace / (1024**3)).toFixed(2), totalGB: (totalSpace / (1024**3)).toFixed(2), userData: userDataPath };
    } catch (error) { // Capturar error si todos los métodos fallan
        logger.error('Error fatal verificando espacio en disco:', error);
        return { error: `No se pudo verificar espacio: ${error.message}`, path: userDataPath, freeGB: 'N/A', totalGB: 'N/A' };
    }
  }

  static async checkOllamaCompatibility(ollamaEndpoint = 'http://localhost:11434') {
    try {
      logger.info(`Verificando Ollama en ${ollamaEndpoint}...`);
      const apiUrl = `${ollamaEndpoint.replace(/\/$/, '')}/api/tags`; // Endpoint para listar modelos
      try {
        const response = await axios.get(apiUrl, { timeout: 5000 }); // Timeout corto para verificar
        if (response.status === 200 && response.data?.models && Array.isArray(response.data.models)) {
          const models = response.data.models.map(m => ({ name: m.name, modified_at: m.modified_at, size: m.size }));
          logger.info(`Ollama disponible. ${models.length} modelos locales encontrados.`);
          return { available: true, models: models, endpoint: ollamaEndpoint };
        } else {
          logger.warn(`Respuesta inesperada de Ollama API (Status: ${response.status})`);
          return { available: false, error: `Respuesta inesperada de API (Status: ${response.status})`, endpoint: ollamaEndpoint };
        }
      } catch (error) {
        let errorMessage = 'Error desconocido';
        if (error.code === 'ECONNREFUSED') errorMessage = `No se pudo conectar a Ollama en ${ollamaEndpoint}. ¿Está en ejecución?`;
        else if (error.code === 'ECONNABORTED' || error.message.toLowerCase().includes('timeout')) errorMessage = `Timeout esperando respuesta de ${ollamaEndpoint}.`;
        else if (error.response) errorMessage = `Error de API Ollama (${error.config?.url}): ${error.response.status} ${error.response.statusText}.`;
        else errorMessage = `Error conectando a Ollama: ${error.message}`;
        logger.warn(`Error verificando Ollama: ${errorMessage}`);
        return { available: false, error: errorMessage, endpoint: ollamaEndpoint };
      }
    } catch (error) { logger.error('Error fatal verificando Ollama:', error); return { available: false, error: `Error general: ${error.message}`, endpoint: ollamaEndpoint }; }
  }

  static async checkEnvironment() {
    try {
      logger.info('Verificando entorno de ejecución...');
      const nodeVersion = process.versions.node; const electronVersion = process.versions.electron;
      const chromeVersion = process.versions.chrome; const v8Version = process.versions.v8;
      let tempAccess = false; let tempPath = 'N/A'; let userDataAccess = false; let userDataPath = 'N/A';
      try { tempPath = os.tmpdir(); await fs.access(tempPath, fs.constants.W_OK); tempAccess = true; } catch {}
      try { userDataPath = app.getPath('userData'); await fs.access(userDataPath, fs.constants.W_OK); userDataAccess = true; } catch {}
      return {
        node: { version: nodeVersion, arch: process.arch, platform: process.platform },
        electron: { version: electronVersion, chrome: chromeVersion, v8: v8Version },
        permissions: { tempAccess, userDataAccess }, paths: { temp: tempPath, userData: userDataPath }
      };
    } catch (error) { logger.error('Error verificando entorno:', error); return { error: `Error: ${error.message}` }; }
  }

  // Ejecuta todos los checks y devuelve un resumen
  static async runAllChecks(options = {}) {
    logger.info('Ejecutando todas las verificaciones del sistema...');
    const { minRamGB = 4, minDiskGB = 2, ollamaEndpoint = 'http://localhost:11434' } = options;
    const results = { meetsRequirements: true, issues: [], recommendations: [], checkTimeMs: 0, specs: {}, database: {}, dictaphone: {}, ollama: {}, environment: {} };
    const startTime = performance.now();
    try {
        const [ specs, db, dictaphone, ollama, env ] = await Promise.all([
            this.checkSystemSpecs(), this.checkDatabaseSupport(), this.checkDictaphoneSupport(),
            this.checkOllamaCompatibility(ollamaEndpoint), this.checkEnvironment()
        ]);
        results.specs = specs; results.database = db; results.dictaphone = dictaphone; results.ollama = ollama; results.environment = env;
        // Evaluación
        if(specs.error) results.issues.push(`Especificaciones: ${specs.error}`);
        if(!db.supported) results.issues.push(`Base de datos: ${db.error}`);
        if(env.error) results.issues.push(`Entorno: ${env.error}`);
        if(!env.permissions?.userDataAccess) results.issues.push(`Permisos: Sin escritura en userData (${env.paths?.userData})`);
        if(!env.permissions?.tempAccess) results.issues.push(`Permisos: Sin escritura en temp (${env.paths?.temp})`);

        if(!specs.error && specs.memory?.totalGB < minRamGB) results.recommendations.push(`RAM: ${specs.memory?.totalGB}GB (< ${minRamGB}GB rec.).`);
        if(!specs.error && !specs.disk?.error && specs.disk?.freeGB < minDiskGB) results.recommendations.push(`Disco: ${specs.disk?.freeGB}GB libres (< ${minDiskGB}GB rec.).`);
        if(specs.disk?.error) results.recommendations.push(`Disco: ${specs.disk.error}`);
        if(!dictaphone.supported) results.recommendations.push(`Dictáfono: ${dictaphone.error}`);
        if(!ollama.available) results.recommendations.push(`Ollama: ${ollama.error}`);
        if(!db.supported || !db.features?.json1) results.recommendations.push(`SQLite: Funciones JSON no disponibles (v${db.sqlite_version || '?'}).`);

        results.meetsRequirements = results.issues.length === 0;
    } catch (error) { results.meetsRequirements = false; results.issues.push(`Error ejecución checks: ${error.message}`); }
    finally { results.checkTimeMs = parseFloat((performance.now() - startTime).toFixed(2)); }
    logger.info(`Verificaciones completadas (${results.checkTimeMs}ms). OK: ${results.meetsRequirements}. Issues: ${results.issues.length}. Recom: ${results.recommendations.length}`);
    if(results.issues.length > 0) logger.error("Problemas críticos:", results.issues);
    if(results.recommendations.length > 0) logger.warn("Recomendaciones:", results.recommendations);
    return results;
  }
}
module.exports = SystemRequirementsChecker;