const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs-extra'); // Opcional, si se usa
const RadiologistAppController = require('./RadiologistAppController');
const logger = require('./utils/logger');

// Referencias globales
let mainWindow = null;
let appController = null;
let isAppQuitting = false; // Flag para controlar cierre

// Asegurar una sola instancia de la aplicación
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  logger.warn('Intento de abrir segunda instancia. Cerrando nueva instancia.');
  app.quit();
} else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    // Alguien intentó ejecutar una segunda instancia, enfocar nuestra ventana.
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
       logger.info('Segunda instancia detectada, ventana existente enfocada.');
    }
  });
}

// Función principal para crear la ventana
async function createMainWindow() {
  logger.info('Creando ventana principal...');
  try {
    mainWindow = new BrowserWindow({
      width: 1280, // Tamaño inicial un poco más grande
      height: 800,
      minWidth: 900, // Aumentar mínimos
      minHeight: 650,
      show: false, // No mostrar hasta que esté lista la UI o la carga
      //backgroundColor: '#ffffff', // Fondo blanco mientras carga
      webPreferences: {
        nodeIntegration: false, // Seguridad: Deshabilitado
        contextIsolation: true, // Seguridad: Habilitado (Requiere preload.js)
        enableRemoteModule: false, // Seguridad: Deshabilitado
        spellcheck: true, // Habilitar corrector ortográfico básico
        preload: path.join(__dirname, '../preload.js') // Ruta al script de preload
      },
      icon: path.join(__dirname, '../assets/icon.png') // Ajustar según tu estructura e icono
      // En macOS, el icono se define en electron-forge/builder config o Info.plist
      // En Windows, el icono se define en electron-forge/builder config
    });

    // Cargar pantalla de carga inicial
    const loadingUrl = new URL(path.join(__dirname, '../renderer/loading.html'), 'file:').toString();
    logger.debug(`Cargando pantalla de carga: ${loadingUrl}`);
    await mainWindow.loadURL(loadingUrl);

    // Mostrar ventana solo cuando la página de carga esté lista (evita pantalla blanca)
    mainWindow.once('ready-to-show', () => {
        if(mainWindow && !mainWindow.isDestroyed()) { // Doble check
            mainWindow.show();
            logger.debug("Ventana lista para mostrar (pantalla de carga).");
        }
    });

    // Inicializar el controlador de la aplicación después de crear la ventana
    logger.info('Inicializando RadiologistAppController...');
    appController = new RadiologistAppController({
      logger: logger,
      app: app,
      mainWindow: mainWindow, // Pasar referencia de la ventana
      isDevelopment: process.env.NODE_ENV === 'development'
    });

    // Inicializar el controlador (puede lanzar errores críticos)
    try {
      await appController.initialize(mainWindow);
      logger.info('RadiologistAppController inicializado correctamente.');

      // Si el controlador inicializó bien, cargar la UI principal
      const indexUrl = new URL(path.join(__dirname, '../renderer/index.html'), 'file:').toString();
      logger.debug(`Cargando UI principal: ${indexUrl}`);
      await mainWindow.loadURL(indexUrl);

    } catch (controllerError) { // Error durante inicialización del Controller
      logger.error('Error CRÍTICO durante inicialización del controller:', controllerError);
      // Mostrar pantalla de error crítico (si el error fue marcado como crítico)
      if (controllerError?.critical === true) {
        const errorMessage = encodeURIComponent(`${controllerError.message}${controllerError.stack ? `\n\nStack:\n${controllerError.stack}` : ''}`);
        const errorUrl = new URL(path.join(__dirname, '../renderer/critical-error.html'), 'file:');
        errorUrl.searchParams.append('error', errorMessage);
        logger.debug(`Cargando pantalla de error crítico: ${errorUrl.toString()}`);
        try {
             // Asegurar que la ventana sigue existiendo y cargar la URL de error
             if (mainWindow && !mainWindow.isDestroyed()) {
                  await mainWindow.loadURL(errorUrl.toString());
                  // Asegurarse de que la ventana es visible si aún no lo era
                  if (!mainWindow.isVisible()) mainWindow.show();
             }
        } catch (loadError) {
            logger.fatal('¡Fallo al cargar incluso la página de error crítico!', loadError);
            dialog.showErrorBox('Error Crítico Irrecuperable', `No se pudo inicializar (${controllerError.message}) ni mostrar la pantalla de error (${loadError.message}). La aplicación se cerrará.`);
            app.quit(); // Salir si ni la página de error carga
        }
      } else {
         // Si el error no es crítico, intentar cargar la UI principal y mostrar advertencia
         logger.warn(`Error no crítico en inicialización: ${controllerError.message}. Cargando UI con funcionalidad limitada.`);
         dialog.showMessageBox(mainWindow, { type: 'warning', title: 'Advertencia de Inicialización', message: `Funcionalidad limitada: ${controllerError.message}`, buttons: ['Entendido'] }).catch(()=>{});
         const indexUrl = new URL(path.join(__dirname, '../renderer/index.html'), 'file:').toString();
         try { await mainWindow.loadURL(indexUrl); } catch(e) { logger.error("Fallo al cargar index.html tras error no crítico:", e); app.quit(); } // Salir si falla la carga principal

         // Enviar mensaje al renderer una vez cargado para indicar el warning
         mainWindow.webContents.once('did-finish-load', () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('initialization-warning', { message: controllerError.message });
            }
         });
      }
    }

    // Abrir DevTools si estamos en desarrollo
    if (process.env.NODE_ENV === 'development') {
      mainWindow.webContents.openDevTools({ mode: 'detach' }); // Abrir desacoplado
    }

    // Manejar cierre de ventana solicitado por el usuario (click en 'X')
    mainWindow.on('close', async (e) => {
      if (!isAppQuitting) { // Prevenir reentrada si ya estamos saliendo por app.quit()
        e.preventDefault(); // Prevenir cierre inmediato
        const { response } = await dialog.showMessageBox(mainWindow, {
          type: 'question', buttons: ['Sí, Salir', 'No'], defaultId: 1, // Default a 'No'
          title: 'Confirmar Salida', message: '¿Está seguro que desea salir de Signia?'
        });
        if (response === 0) { // Botón 'Sí, Salir'
          isAppQuitting = true;
          logger.info("Usuario confirmó salida.");
          app.quit(); // Iniciar secuencia de cierre de la aplicación
        } else {
           logger.debug("Salida cancelada por el usuario.");
        }
      }
    });

    // Limpiar referencia cuando la ventana se cierra realmente
    mainWindow.on('closed', () => {
      logger.info("Ventana principal cerrada.");
      mainWindow = null;
    });

  } catch (error) { // Error fatal ANTES de crear la ventana o iniciar controller
    logger.fatal('Error fatal irrecuperable durante createMainWindow:', error);
    dialog.showErrorBox('Error Fatal', `No se pudo iniciar la aplicación: ${error.message}`);
    app.quit();
  }
}

// --- Ciclo de Vida de la Aplicación Electron ---

// Evento: Listo para crear ventanas
app.whenReady().then(createMainWindow).catch(error => {
  console.error('Error fatal en app.whenReady:', error);
  logger.fatal('Error fatal en app.whenReady:', error);
  // Intentar mostrar diálogo antes de salir
  dialog?.showErrorBox('Error Fatal de Inicio', `La aplicación no pudo iniciarse: ${error.message}`);
  app.quit();
});

// Evento: Todas las ventanas cerradas
app.on('window-all-closed', () => {
  logger.info("Todas las ventanas cerradas.");
  // En macOS, la aplicación suele seguir activa hasta que se cierra explícitamente
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Evento: Aplicación activada (macOS)
app.on('activate', () => {
  // Recrear ventana si se hace clic en el icono del dock y no hay ventanas abiertas
  if (BrowserWindow.getAllWindows().length === 0) {
    logger.info("Aplicación activada (macOS), creando nueva ventana.");
    createMainWindow();
  } else {
     logger.debug("Aplicación activada (macOS), ventana ya existe.");
      // Opcional: enfocar ventana existente si está oculta
     if(mainWindow && !mainWindow.isDestroyed()) mainWindow.focus();
  }
});

// Evento: Antes de salir de la aplicación
app.on('before-quit', async (event) => {
  logger.info('Evento before-quit recibido. Iniciando limpieza final...');
  isAppQuitting = true; // Marcar que estamos saliendo
  if (appController) {
    try {
      await appController.cleanup(); // Esperar limpieza del controller
    } catch (error) {
      logger.error('Error durante la limpieza final del controlador:', error);
    }
  }
  logger.info("Limpieza final completada (o intentada). Saliendo.");
  // No prevenir la salida aquí, permitir que app.quit() continúe
});

// --- Manejo de Errores Globales (Proceso Principal) ---

// Excepciones no capturadas
process.on('uncaughtException', (error, origin) => {
  logger.fatal(`Excepción no capturada (${origin}):`, error);
  // Intentar mostrar un diálogo, puede fallar si la app está muy inestable
  try {
    if (app.isReady()) { // Solo mostrar si la app está mínimamente funcional
       const message = `Error inesperado: ${error.message}\nOrigen: ${origin}\n\nSe recomienda reiniciar la aplicación.`;
       dialog?.showErrorBox('Error Inesperado Crítico', message);
    } else { console.error("Error no capturado ANTES de app ready:", error); }
  } catch (dialogError) { logger.error("Error mostrando diálogo de uncaughtException:", dialogError); }
  // Considerar salir si es un error realmente grave, aunque exitOnError=false es más seguro
  // process.exit(1);
});

// Promesas rechazadas no manejadas
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Promesa Rechazada no Manejada:', { reason });
  // Podríamos mostrar un warning si la app está lista, pero generalmente no se cierra por esto
  // if (app.isReady() && mainWindow) {
  //   dialog?.showMessageBox(mainWindow, { type: 'warning', title: 'Advertencia', message: `Operación asíncrona falló inesperadamente: ${reason}` });
  // }
});

// --- IPC Handlers Globales (Pueden ser necesarios incluso si Controller falla) ---

ipcMain.on('restart-app', () => {
  logger.info('IPC: Solicitud para reiniciar la aplicación...');
  // Intentar limpieza antes de reiniciar
  (appController ? appController.cleanup() : Promise.resolve())
    .catch(err => logger.error("Error limpieza pre-restart:", err))
    .finally(() => {
        app.relaunch(); // Prepara la app para relanzarse
        app.quit();     // Cierra la instancia actual
    });
});

ipcMain.on('quit-app', () => {
  logger.info('IPC: Solicitud para cerrar la aplicación...');
  isAppQuitting = true; // Marcar para evitar diálogo de confirmación
  // Intentar limpieza antes de salir
  (appController ? appController.cleanup() : Promise.resolve())
    .catch(err => logger.error("Error limpieza pre-quit:", err))
    .finally(() => {
        app.quit(); // Cierra la instancia actual
    });
});

// Handler simple para verificar que IPC funciona
ipcMain.handle('ping', async () => {
    await new Promise(resolve => setTimeout(resolve, 50)); // Simular pequeña demora
    return 'pong';
});

// Log final de inicio
logger.info(`*** Signia v${app.getVersion()} lista. Esperando interacción. ***`);