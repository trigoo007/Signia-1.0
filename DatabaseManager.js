const { EventEmitter } = require('events');
const sqlite3 = require('sqlite3');
const path = require('path');
const fs = require('fs-extra');
const { app } = require('electron');
const logger = require('../utils/logger');
const ERROR_TYPES = require('../utils/error-types');

// Ubicación de la base de datos
const DEFAULT_DB_PATH = path.join(app.getPath('userData'), 'signia_data.sqlite'); // Nombre de archivo actualizado
const BACKUP_DIR = path.join(app.getPath('userData'), 'db_backups');

class DatabaseManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.dbPath = options.dbPath || DEFAULT_DB_PATH;
    this.db = null; // Objeto de la base de datos SQLite
    this.logger = options.logger || logger;
    this.autoMigrate = options.autoMigrate !== false; // Migrar automáticamente por defecto
    this.backupBeforeMigration = options.backupBeforeMigration !== false; // Hacer backup por defecto
    this.isInitialized = false;

    // Estado de la migración
    this.currentSchemaVersion = 0; // Se leerá de la BD
    // Definir aquí la versión más reciente del esquema que este código soporta
    this.latestSchemaVersion = 2; // Ejemplo: Incrementar al añadir tablas/columnas
  }

  // --- Métodos de Conexión y Inicialización ---

  async initialize() {
    if (this.isInitialized) return true;
    this.logger.info(`Inicializando DatabaseManager (DB: ${this.dbPath})...`);

    try {
      // Asegurar que el directorio de la BD existe
      await fs.ensureDir(path.dirname(this.dbPath));

      // Conectar a la base de datos
      await this._connect();

      // Configurar PRAGMAs iniciales (ej: foreign keys)
      await this.run('PRAGMA foreign_keys = ON;');
      this.logger.debug('Foreign keys enabled.');

      // Inicializar tabla de metadatos/versión si no existe
      await this._initializeMetaTable();

      // Leer versión actual del esquema
      this.currentSchemaVersion = await this._getSchemaVersion();
      this.logger.info(`Versión actual del esquema: ${this.currentSchemaVersion}, Versión esperada: ${this.latestSchemaVersion}`);

      // Ejecutar migraciones si es necesario
      if (this.autoMigrate && this.currentSchemaVersion < this.latestSchemaVersion) {
        this.logger.info("Se requiere migración de base de datos.");
        if (this.backupBeforeMigration) {
          await this._backupDatabase(); // Hacer backup ANTES de migrar
        }
        await this._runMigrations(); // Ejecutar lógica de migración
      } else if (this.currentSchemaVersion > this.latestSchemaVersion) {
         this.logger.warn(`La versión del esquema de la BD (${this.currentSchemaVersion}) es MÁS NUEVA que la soportada por la aplicación (${this.latestSchemaVersion}). Pueden ocurrir errores.`);
         // Podría ser buena idea lanzar un error aquí si la diferencia es grande
      } else {
          this.logger.info("La versión del esquema de la base de datos está actualizada.");
      }

      // Crear tablas iniciales (si no existen - idempotente)
      // Esto asegura que las tablas básicas existen incluso si las migraciones fallan o no se ejecutan.
      await this._initializeSchema();


      this.isInitialized = true;
      this.logger.info('DatabaseManager inicializado correctamente.');
      return true;

    } catch (error) {
      this.logger.fatal('Error fatal inicializando DatabaseManager:', error);
      const structuredError = this._createError(
        ERROR_TYPES.DATABASE_INIT_ERROR,
        `Fallo inicialización BD: ${error.message}`,
        { critical: true, nativeError: error } // Crítico para la app
      );
      this.emit('error', structuredError);
      // Intentar cerrar la conexión si se abrió parcialmente
      if (this.db) {
          await this.close().catch(e => this.logger.error("Error cerrando BD después de fallo de inicialización:", e));
      }
      throw structuredError; // Relanzar para detener la app si es necesario
    }
  }

  async _connect() {
    return new Promise((resolve, reject) => {
      // Usar verbose para obtener más info de errores SQL si es necesario en desarrollo
      // const mode = process.env.NODE_ENV === 'development' ? sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE | sqlite3.OPEN_FULLMUTEX | sqlite3.VERBOSE : sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE | sqlite3.OPEN_FULLMUTEX;
      const mode = sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE | sqlite3.OPEN_FULLMUTEX;

      this.db = new sqlite3.Database(this.dbPath, mode, (err) => {
        if (err) {
          this.logger.error(`Error conectando a SQLite (${this.dbPath}):`, err);
          return reject(this._createError(ERROR_TYPES.DATABASE_CONNECTION_ERROR, err.message, { nativeError: err }));
        }
        this.logger.debug(`Conectado a SQLite: ${this.dbPath}`);
        resolve();
      });

      // Manejar errores inesperados de la conexión una vez establecida
       this.db.on('error', (err) => {
           this.logger.error("Error inesperado en la conexión SQLite:", err);
           // Considerar emitir un evento o intentar una recuperación si es posible
            this.emit('error', this._createError(ERROR_TYPES.DATABASE_ERROR, `Error en conexión DB: ${err.message}`, { nativeError: err, critical: false }));
       });
    });
  }

  async close() {
    if (!this.db) return Promise.resolve(); // Ya cerrada
    this.logger.debug('Cerrando conexión SQLite...');
    return new Promise((resolve) => { // Siempre resuelve, incluso si hay error al cerrar
      this.db.close((err) => {
        if (err) {
          this.logger.error('Error cerrando conexión SQLite:', err);
           this.emit('error', this._createError(ERROR_TYPES.DATABASE_CONNECTION_ERROR, `Error cerrando DB: ${err.message}`, { nativeError: err }));
        } else {
          this.logger.info('Conexión SQLite cerrada.');
        }
        this.db = null;
        this.isInitialized = false;
        resolve();
      });
    });
  }

  // --- Métodos de Schema y Migraciones ---

  async _initializeMetaTable() {
    const sql = `
      CREATE TABLE IF NOT EXISTS app_metadata (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT
      );
    `;
    await this.run(sql);
    // Asegurar que la versión del esquema existe, inicializar a 0 si es la primera vez
    const insertVersionSql = `INSERT OR IGNORE INTO app_metadata (key, value) VALUES ('schema_version', '0');`;
    await this.run(insertVersionSql);
  }

  async _getSchemaVersion() {
    try {
        const row = await this.get("SELECT value FROM app_metadata WHERE key = 'schema_version'");
        // Devolver 0 si la tabla existe pero la clave no (o si el valor no es número)
        return row ? parseInt(row.value, 10) || 0 : 0;
    } catch (error) {
         this.logger.error("Error obteniendo versión del schema, asumiendo 0:", error);
         return 0; // Asumir 0 si hay error al leer
    }
  }

  async _setSchemaVersion(version) {
    const sql = "UPDATE app_metadata SET value = ? WHERE key = 'schema_version'";
    await this.run(sql, [version.toString()]);
    this.currentSchemaVersion = version;
    this.logger.info(`Versión del esquema de la base de datos actualizada a: ${version}`);
  }

  async _initializeSchema() {
    // Crea las tablas básicas si no existen. En un sistema con migraciones robustas,
    // esto se haría en la migración v0 -> v1.
    this.logger.debug('Verificando/Creando esquema inicial de tablas...');
    const queries = [
      // Tabla de Configuración
      `CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT,
        last_modified DATETIME DEFAULT CURRENT_TIMESTAMP
      );`,

      // Tabla de Términos Médicos
      `CREATE TABLE IF NOT EXISTS medical_terms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        heard_term TEXT NOT NULL UNIQUE COLLATE NOCASE, -- Ignorar mayúsculas/minúsculas en unicidad
        correct_term TEXT NOT NULL,
        specialty TEXT,
        modality TEXT,
        frequency INTEGER DEFAULT 1,
        variants TEXT,                   -- JSON array de strings
        context_words TEXT,              -- JSON array de strings
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );`,
      // Índices
      `CREATE INDEX IF NOT EXISTS idx_medical_terms_heard ON medical_terms(heard_term);`,
      `CREATE INDEX IF NOT EXISTS idx_medical_terms_spec_mod ON medical_terms(specialty, modality);`,
      `CREATE INDEX IF NOT EXISTS idx_medical_terms_frequency ON medical_terms(frequency DESC);`, // Para getMostFrequentTerms

      // Tabla de Plantillas
      `CREATE TABLE IF NOT EXISTS templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        content TEXT NOT NULL,
        specialty TEXT,
        modality TEXT,
        tags TEXT, -- JSON array de strings
        priority INTEGER DEFAULT 0, -- Añadido en v2
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );`,
      // Índices
       `CREATE INDEX IF NOT EXISTS idx_templates_name ON templates(name);`,
       `CREATE INDEX IF NOT EXISTS idx_templates_spec_mod ON templates(specialty, modality);`,
       `CREATE INDEX IF NOT EXISTS idx_templates_priority ON templates(priority DESC);`,


       // Trigger para actualizar 'updated_at' en medical_terms
       `CREATE TRIGGER IF NOT EXISTS update_medical_terms_updated_at
        AFTER UPDATE ON medical_terms
        FOR EACH ROW
        BEGIN
            UPDATE medical_terms SET updated_at = CURRENT_TIMESTAMP WHERE id = OLD.id;
        END;`,

       // Trigger para actualizar 'updated_at' en templates
       `CREATE TRIGGER IF NOT EXISTS update_templates_updated_at
        AFTER UPDATE ON templates
        FOR EACH ROW
        BEGIN
            UPDATE templates SET updated_at = CURRENT_TIMESTAMP WHERE id = OLD.id;
        END;`
    ];

    // Ejecutar todas las queries de creación/índice en una transacción
    await this.transaction(async (dbManager) => {
         for (const sql of queries) {
             await dbManager.run(sql);
         }
    });

    this.logger.debug('Esquema inicial verificado/creado.');
  }

  async _runMigrations() {
    this.logger.info(`Iniciando migraciones manuales desde v${this.currentSchemaVersion} a v${this.latestSchemaVersion}... (RECOMENDADO: Usar Knex.js)`);
    try {
        // Ejecutar migraciones secuencialmente
        // Migración v0 -> v1: Crear tablas iniciales (cubierto por _initializeSchema)
        if (this.currentSchemaVersion < 1) {
            this.logger.info("Aplicando migración v0 -> v1...");
            // Las tablas ya se crean en _initializeSchema, solo actualizamos versión
            await this._setSchemaVersion(1);
            this.logger.info("Migración v0 -> v1 completada.");
        }

        // Migración v1 -> v2: Añadir columna 'priority' a templates
        if (this.currentSchemaVersion < 2) {
            this.logger.info("Aplicando migración v1 -> v2...");
            await this.transaction(async (dbm) => {
                // Usar ALTER TABLE con manejo de errores básico
                try {
                    await dbm.run("ALTER TABLE templates ADD COLUMN priority INTEGER DEFAULT 0;");
                } catch (alterError) {
                    // Ignorar error si la columna ya existe (puede pasar si falló antes)
                    if (!alterError.message.includes('duplicate column name')) {
                         throw alterError; // Relanzar otros errores
                    } else {
                        this.logger.warn("Columna 'priority' ya existe en 'templates'.");
                    }
                }
                 // Crear índice para la nueva columna
                await dbm.run("CREATE INDEX IF NOT EXISTS idx_templates_priority ON templates(priority DESC);");
                // Actualizar versión DENTRO de la transacción
                await dbm._setSchemaVersion(2);
            });
            this.logger.info("Migración v1 -> v2 completada.");
        }

        // Añadir futuras migraciones aquí:
        // if (this.currentSchemaVersion < 3) { ... await this._setSchemaVersion(3); }

        this.logger.info('Migraciones completadas exitosamente.');

    } catch (error) {
        this.logger.error(`Error durante la migración (desde v${this.currentSchemaVersion}):`, error);
         throw this._createError(
            ERROR_TYPES.DATABASE_MIGRATION_ERROR,
            `Fallo en migración desde v${this.currentSchemaVersion}: ${error.message}`,
            { nativeError: error, critical: true } // Migración fallida suele ser crítica
        );
    }
  }

  async _backupDatabase() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFilename = `backup_v${this.currentSchemaVersion}_${timestamp}.sqlite`;
    const backupPath = path.join(BACKUP_DIR, backupFilename);

    try {
      this.logger.info(`Creando backup de BD [v${this.currentSchemaVersion}] en: ${backupPath}`);
      await fs.ensureDir(BACKUP_DIR);
      // Cerrar conexión actual para poder copiar el archivo de forma segura
      await this.close();
      // Copiar el archivo
      await fs.copyFile(this.dbPath, backupPath);
      this.logger.info('Backup de base de datos creado exitosamente.');
      // Volver a conectar (importante!)
      await this._connect();
       // Reaplicar PRAGMAs después de reconectar
      await this.run('PRAGMA foreign_keys = ON;');
      // Opcional: Limpiar backups antiguos
      await this._cleanupOldBackups();
    } catch (error) {
      this.logger.error('Error creando backup de la base de datos:', error);
       // Si falla el backup, ¿deberíamos detener la migración? Por ahora, no.
       // Asegurarse de reconectar si el cierre ocurrió pero la copia falló
       if(!this.db) {
           try { await this._connect(); await this.run('PRAGMA foreign_keys = ON;'); }
           catch(e) { this.logger.error("Fallo crítico al reconectar después de error de backup", e); /* Podría ser necesario salir aquí */ }
       }
       // Emitir error no crítico para que el log lo registre
       this.emit('error', this._createError(ERROR_TYPES.DATABASE_ERROR, `Fallo al crear backup: ${error.message}. La migración continuará SIN backup.`, { critical: false, nativeError: error }));
    }
  }

  async _cleanupOldBackups(keepCount = 5) {
      try {
          if (!(await fs.pathExists(BACKUP_DIR))) return; // Nada que limpiar
          const files = await fs.readdir(BACKUP_DIR);
          const backupFiles = files
              .filter(f => f.startsWith('backup_') && f.endsWith('.sqlite'))
              .map(f => ({ name: f, path: path.join(BACKUP_DIR, f) }))
              // Ordenar por fecha (extraída del nombre) descendente
              .sort((a, b) => {
                    const timeA = a.name.split('_').pop().replace('.sqlite', '').replace(/-/g, ':').replace('T', ' ').split('.')[0];
                    const timeB = b.name.split('_').pop().replace('.sqlite', '').replace(/-/g, ':').replace('T', ' ').split('.')[0];
                    return new Date(timeB) - new Date(timeA); // Más reciente primero
               });

          if (backupFiles.length > keepCount) {
              const filesToDelete = backupFiles.slice(keepCount);
              this.logger.info(`Limpiando ${filesToDelete.length} backups antiguos...`);
              for (const file of filesToDelete) {
                  await fs.unlink(file.path);
                   this.logger.debug(`Backup antiguo eliminado: ${file.name}`);
              }
          }
      } catch (error) {
           this.logger.warn('Error limpiando backups antiguos:', error);
      }
  }


  // --- Helpers de Ejecución SQL (Promisificados) ---

  async run(sql, params = []) {
    if (!this.db) throw this._createError(ERROR_TYPES.DATABASE_CONNECTION_ERROR, "Base de datos no conectada");
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function (err) { // Usar function() para 'this'
        if (err) {
          logger.error(`SQL Error (run): ${err.message} | Query: ${sql.substring(0,100)}... | Params: ${params}`);
          reject(err); // Rechazar con el error original
        } else {
          resolve({ lastID: this.lastID, changes: this.changes });
        }
      });
    });
  }

  async get(sql, params = []) {
    if (!this.db) throw this._createError(ERROR_TYPES.DATABASE_CONNECTION_ERROR, "Base de datos no conectada");
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) {
          logger.error(`SQL Error (get): ${err.message} | Query: ${sql.substring(0,100)}... | Params: ${params}`);
          reject(err);
        } else {
          resolve(row); // Devuelve undefined si no hay fila
        }
      });
    });
  }

  async all(sql, params = []) {
    if (!this.db) throw this._createError(ERROR_TYPES.DATABASE_CONNECTION_ERROR, "Base de datos no conectada");
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) {
          logger.error(`SQL Error (all): ${err.message} | Query: ${sql.substring(0,100)}... | Params: ${params}`);
          reject(err);
        } else {
          resolve(rows || []); // Devuelve array vacío si no hay filas
        }
      });
    });
  }

  async exec(sql) {
    if (!this.db) throw this._createError(ERROR_TYPES.DATABASE_CONNECTION_ERROR, "Base de datos no conectada");
    return new Promise((resolve, reject) => {
      this.db.exec(sql, (err) => {
        if (err) {
           logger.error(`SQL Error (exec): ${err.message} | Query: ${sql.substring(0, 100)}...`);
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  // --- Transacciones ---
  async transaction(action) {
    // action debe ser una función async que recibe 'this' (el dbManager) como argumento
    if (!this.db) throw this._createError(ERROR_TYPES.DATABASE_CONNECTION_ERROR, "Base de datos no conectada");
    try {
        await this.run('BEGIN TRANSACTION;');
        this.logger.debug("Transaction started.");
        const result = await action(this); // Ejecutar la acción pasando el manager
        await this.run('COMMIT;');
        this.logger.debug("Transaction committed.");
        return result;
    } catch (error) {
         this.logger.error('Error en transacción, realizando rollback:', error);
        try {
             await this.run('ROLLBACK;');
             this.logger.warn("Transaction rolled back.");
        } catch (rollbackError) {
             // Error MUY grave si falla el rollback
             this.logger.fatal('¡ERROR CRÍTICO DURANTE ROLLBACK!', rollbackError);
             // Podría ser necesario cerrar la app o marcar la DB como corrupta
        }
        // Relanzar el error original que causó el rollback
        throw error;
    }
  }


  // --- Métodos de Acceso a Datos ---

  // Settings
  async saveSetting(key, value) {
    const sql = `INSERT INTO settings (key, value, last_modified) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, last_modified = CURRENT_TIMESTAMP;`;
    const valueToSave = (typeof value === 'object' && value !== null) ? JSON.stringify(value) : value;
    await this.run(sql, [key, valueToSave]);
  }

  async getSetting(key) {
    const row = await this.get("SELECT value FROM settings WHERE key = ?", [key]);
    if (row && row.value !== null && row.value !== undefined) {
        try { return JSON.parse(row.value); } catch { return row.value; }
    }
    return undefined; // Devolver undefined si no existe o es null
  }

   async getAllSettingsInternal() { // Devuelve raw para Controller
        return await this.all("SELECT key, value FROM settings");
   }

   async getAllSettings() { // Devuelve objeto parseado
        const rows = await this.getAllSettingsInternal();
        const settings = {};
        rows.forEach(row => {
            if (row.value !== null && row.value !== undefined) {
                 try { settings[row.key] = JSON.parse(row.value); } catch { settings[row.key] = row.value; }
            } else {
                 settings[row.key] = null; // Mantener null si es null en DB
            }
        });
        return settings;
   }

  // Medical Terms
  async addOrUpdateMedicalTerm(heardTerm, correctTerm, specialty = null, modality = null, variants = [], contextWords = []) {
      const heardTermLower = heardTerm.toLowerCase().trim();
      const sql = `
          INSERT INTO medical_terms (heard_term, correct_term, specialty, modality, variants, context_words, frequency, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          ON CONFLICT(heard_term) DO UPDATE SET
              correct_term = excluded.correct_term, specialty = excluded.specialty, modality = excluded.modality,
              variants = excluded.variants, context_words = excluded.context_words,
              frequency = frequency + 1, updated_at = CURRENT_TIMESTAMP
          RETURNING id;`;
      const variantsJson = JSON.stringify(variants || []);
      const contextJson = JSON.stringify(contextWords || []);
      // Usar get para RETURNING en sqlite3 node module
      const result = await this.get(sql, [heardTermLower, correctTerm.trim(), specialty, modality, variantsJson, contextJson]);
      return result?.id;
  }

  async findExactTerm(heardTerm) {
      const sql = "SELECT * FROM medical_terms WHERE heard_term = ?";
      return await this.get(sql, [heardTerm.toLowerCase().trim()]);
  }

  async findSimilarTerms(heardTerm, specialty = null, modality = null, limit = 5) {
       const heardTermLower = heardTerm.toLowerCase().trim();
       // Usar LIKE para búsqueda de prefijo. Para fuzzy real se necesita extensión/lógica app.
       let sql = "SELECT * FROM medical_terms WHERE heard_term LIKE ?";
       const params = [`${heardTermLower}%`];
       if (specialty) { sql += " AND (specialty = ? OR specialty IS NULL)"; params.push(specialty); }
       if (modality) { sql += " AND (modality = ? OR modality IS NULL)"; params.push(modality); }
       sql += " ORDER BY frequency DESC, length(heard_term) ASC LIMIT ?"; params.push(limit);
       return await this.all(sql, params);
  }

  async getMostFrequentTerms(limit = 1000) {
      const sql = "SELECT * FROM medical_terms ORDER BY frequency DESC LIMIT ?";
      return await this.all(sql, [limit]);
  }

  async incrementTermFrequency(termId) {
      const sql = "UPDATE medical_terms SET frequency = frequency + 1 WHERE id = ?";
      await this.run(sql, [termId]);
  }

  async getTermFrequency(termId) {
       const sql = "SELECT frequency FROM medical_terms WHERE id = ?";
       const row = await this.get(sql, [termId]);
       return row?.frequency ?? 0; // Devolver 0 si no se encuentra
  }


  // Templates
  async saveTemplate(templateData) {
      const { id, name, content, specialty, modality, tags, priority } = templateData;
      const tagsJson = JSON.stringify(tags || []);
      if (id) { // Update
          const sql = `UPDATE templates SET name=?, content=?, specialty=?, modality=?, tags=?, priority=?, updated_at=CURRENT_TIMESTAMP WHERE id = ?`;
          await this.run(sql, [name, content, specialty, modality, tagsJson, priority ?? 0, id]); return id;
      } else { // Insert
          const sql = `INSERT INTO templates (name, content, specialty, modality, tags, priority) VALUES (?, ?, ?, ?, ?, ?)`;
          const result = await this.run(sql, [name, content, specialty, modality, tagsJson, priority ?? 0]); return result.lastID;
      }
  }

  async getAllTemplates() {
       const sql = "SELECT * FROM templates ORDER BY specialty, modality, priority DESC, name";
       const templates = await this.all(sql);
       // Parsear tags JSON al devolver
       return templates.map(t => ({ ...t, tags: t.tags ? JSON.parse(t.tags) : [] }));
  }

  async deleteTemplate(id) {
      const sql = "DELETE FROM templates WHERE id = ?";
      const result = await this.run(sql, [id]);
      return result.changes > 0; // Devuelve true si se eliminó algo
  }

  // --- Limpieza ---

  async cleanup() {
    this.logger.info('Limpiando DatabaseManager...');
    await this.close(); // Cierra la conexión
    this.logger.info('DatabaseManager limpiado.');
  }

  // --- Helper de Errores ---
  _createError(type, message, details = {}) {
    const error = new Error(message); error.type = type || ERROR_TYPES.UNKNOWN; error.timestamp = Date.now();
    error.id = details.id || `${error.type}_${Date.now()}`; error.critical = details.critical === true; error.details = details.details || {};
    if(details.nativeError) { error.details.nativeError = details.nativeError; if (!error.stack && details.nativeError instanceof Error) error.stack = details.nativeError.stack; }
    return error;
  }
}

module.exports = DatabaseManager;