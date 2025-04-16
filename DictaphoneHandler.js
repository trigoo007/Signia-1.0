// Signia/main/hardware/DictaphoneHandler.js

const EventEmitter = require('events');
const usbDetect = require('usb-detection');
const { DEVICE_STATUS } = require('../utils/constants'); // Asumiendo que tienes constantes definidas
const logger = require('../utils/logger'); // Asumiendo un logger configurado

// Constantes para el backoff exponencial
const INITIAL_RECONNECT_DELAY = 1000; // 1 segundo
const MAX_RECONNECT_DELAY = 30000; // 30 segundos
const BACKOFF_FACTOR = 2;

/**
 * @class DictaphoneHandler
 * @extends EventEmitter
 * @description Handles detection, connection, and events for a USB dictaphone.
 * Includes exponential backoff for reconnection attempts.
 */
class DictaphoneHandler extends EventEmitter {
    /**
     * Creates an instance of DictaphoneHandler.
     * @param {number} vendorId - The USB vendor ID of the dictaphone.
     * @param {number} productId - The USB product ID of the dictaphone.
     */
    constructor(vendorId, productId) {
        super();
        this.vendorId = vendorId;
        this.productId = productId;
        this.device = null;
        this.status = DEVICE_STATUS.DISCONNECTED;
        this.reconnectAttempt = 0;
        this.reconnectTimeout = null;
        this.isMonitoring = false; // Flag to prevent multiple monitoring starts
        logger.info(`DictaphoneHandler initialized for VID: ${vendorId}, PID: ${productId}`);
    }

    /**
     * @private
     * @description Checks if a specific USB device matches the target dictaphone.
     * @param {object} device - The USB device object from usb-detection.
     * @returns {boolean} - True if the device matches, false otherwise.
     */
    _isTargetDevice(device) {
        return device.vendorId === this.vendorId && device.productId === this.productId;
    }

    /**
     * @public
     * @description Starts monitoring for USB device additions and removals.
     */
    startMonitoring() {
        if (this.isMonitoring) {
            logger.warn('Dictaphone monitoring is already active.');
            return;
        }
        logger.info('Starting USB monitoring for dictaphone...');
        this.isMonitoring = true;
        usbDetect.startMonitoring();

        // Check for existing devices on start
        this.checkForDevice();

        // Listener for device addition
        usbDetect.on(`add:${this.vendorId}:${this.productId}`, (device) => {
             if (this._isTargetDevice(device)) {
                logger.info('Target dictaphone detected (added).', device);
                this._handleDeviceConnected(device);
            }
        });
         usbDetect.on(`add`, (device) => { // Generic add for logging non-target devices if needed
             if (!this._isTargetDevice(device)) {
                 logger.debug(`Other USB device added: ${device.deviceName}`);
             }
         });


        // Listener for device removal
        usbDetect.on(`remove:${this.vendorId}:${this.productId}`, (device) => {
            if (this._isTargetDevice(device)) {
                logger.info('Target dictaphone removed.');
                this._handleDeviceDisconnected();
            }
        });
        usbDetect.on(`remove`, (device) => { // Generic remove for logging
             if (!this._isTargetDevice(device)) {
                 logger.debug(`Other USB device removed: ${device.deviceName}`);
             }
         });

        logger.info('USB monitoring started.');
    }

    /**
     * @public
     * @description Stops monitoring for USB devices.
     */
    stopMonitoring() {
        if (!this.isMonitoring) {
            logger.warn('Dictaphone monitoring is not active.');
            return;
        }
        logger.info('Stopping USB monitoring for dictaphone...');
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout); // Clear any pending reconnect attempts
            this.reconnectTimeout = null;
        }
        usbDetect.stopMonitoring();
        this.isMonitoring = false;
        this.status = DEVICE_STATUS.DISCONNECTED; // Assume disconnected when stopped
        logger.info('USB monitoring stopped.');
    }

    /**
     * @public
     * @description Manually checks if the dictaphone is currently connected.
     */
    async checkForDevice() {
        logger.info('Checking for existing dictaphone connection...');
        try {
            const devices = await usbDetect.find(this.vendorId, this.productId);
            if (devices && devices.length > 0) {
                logger.info('Dictaphone found during initial check.');
                this._handleDeviceConnected(devices[0]);
            } else {
                logger.info('Dictaphone not found during initial check.');
                this._handleDeviceDisconnected(); // Ensure status is disconnected if not found
                // Optionally start reconnect attempts if desired even if not found initially
                // this._scheduleReconnect();
            }
        } catch (error) {
            logger.error('Error finding USB devices:', error);
            this.status = DEVICE_STATUS.ERROR;
            this.emit('error', error);
            // Consider scheduling a reconnect attempt even on error
            this._scheduleReconnect();
        }
    }

    /**
     * @private
     * @description Handles the logic when the dictaphone is connected.
     * @param {object} device - The connected USB device object.
     */
    _handleDeviceConnected(device) {
        if (this.status !== DEVICE_STATUS.CONNECTED) {
            logger.info(`Dictaphone connected: ${device.deviceName}`);
            this.device = device; // Store device info
            this.status = DEVICE_STATUS.CONNECTED;
            this.reconnectAttempt = 0; // Reset reconnect attempts on successful connection
            if (this.reconnectTimeout) {
                clearTimeout(this.reconnectTimeout); // Cancel any pending reconnect
                this.reconnectTimeout = null;
            }
            this.emit('connected', this.device);
            // TODO: Add logic here to interact with the device if necessary
            // e.g., open device, set up listeners for button presses, etc.
            // For now, we just emit 'connected'.
            this._setupDeviceListeners(); // Example placeholder
        } else {
            logger.debug('Dictaphone already marked as connected.');
        }
    }

    /**
     * @private
     * @description Handles the logic when the dictaphone is disconnected.
     */
    _handleDeviceDisconnected() {
        if (this.status !== DEVICE_STATUS.DISCONNECTED) {
            logger.warn('Dictaphone disconnected.');
            const previousDevice = this.device;
            this.device = null;
            this.status = DEVICE_STATUS.DISCONNECTED;
            this._removeDeviceListeners(); // Example placeholder
            this.emit('disconnected', previousDevice); // Emit event after cleanup
            // Start reconnection attempts when disconnected
            this._scheduleReconnect();
        } else {
             logger.debug('Dictaphone already marked as disconnected.');
        }
    }

    /**
     * @private
     * @description Schedules the next reconnection attempt with exponential backoff.
     */
    _scheduleReconnect() {
        if (this.status === DEVICE_STATUS.CONNECTED || !this.isMonitoring) {
            // Don't attempt reconnect if already connected or if monitoring stopped
            return;
        }

        if (this.reconnectTimeout) {
             logger.debug('Reconnect attempt already scheduled.');
             return; // Already scheduled
        }

        // Calculate delay using exponential backoff
        const delay = Math.min(
            INITIAL_RECONNECT_DELAY * Math.pow(BACKOFF_FACTOR, this.reconnectAttempt),
            MAX_RECONNECT_DELAY
        );

        this.reconnectAttempt++;

        logger.info(`Scheduling dictaphone reconnect attempt ${this.reconnectAttempt} in ${delay / 1000} seconds.`);

        this.reconnectTimeout = setTimeout(async () => {
            this.reconnectTimeout = null; // Clear the timeout ID before the check
            if (this.status === DEVICE_STATUS.CONNECTED || !this.isMonitoring) {
                 logger.info('Reconnect aborted (already connected or monitoring stopped).');
                 return; // Stop if connected or monitoring stopped during the timeout
            }
            logger.info(`Attempting to reconnect dictaphone (Attempt ${this.reconnectAttempt})...`);
             try {
                 // Use find() to check for the device again
                 const devices = await usbDetect.find(this.vendorId, this.productId);
                 if (devices && devices.length > 0) {
                     logger.info('Dictaphone found during reconnect attempt.');
                     this._handleDeviceConnected(devices[0]);
                 } else {
                     logger.info('Dictaphone still not found. Scheduling next attempt.');
                     this._scheduleReconnect(); // Schedule the next attempt
                 }
             } catch (error) {
                 logger.error('Error during reconnect attempt:', error);
                 this.status = DEVICE_STATUS.ERROR;
                 this.emit('error', error);
                 // Still schedule next attempt even if there was an error during find
                 this._scheduleReconnect();
             }
        }, delay);
    }

    /**
     * @private
     * @description Placeholder for setting up device-specific listeners (e.g., button presses).
     * Needs actual implementation based on how the dictaphone communicates.
     */
    _setupDeviceListeners() {
        // This requires a library or method to interact with the specific HID device
        // For example, using 'node-hid'
        logger.info('Setting up device listeners (Placeholder - Requires Implementation)');
        // Example with pseudo-code:
        // if (this.device) {
        //    try {
        //        const hidDevice = new HID.HID(this.device.path); // Assuming device.path is available
        //        hidDevice.on('data', (data) => {
        //            this._handleDictaphoneData(data);
        //        });
        //        hidDevice.on('error', (error) => {
        //            logger.error('HID device error:', error);
        //            this._handleDeviceDisconnected(); // Treat HID error as disconnect
        //        });
        //        this.hidDevice = hidDevice; // Store reference for cleanup
        //    } catch (error) {
        //        logger.error('Failed to open HID device:', error);
        //        this._handleDeviceDisconnected(); // Could not connect
        //    }
        // }
    }

    /**
     * @private
     * @description Placeholder for removing device-specific listeners.
     */
    _removeDeviceListeners() {
        logger.info('Removing device listeners (Placeholder)');
        // Example with pseudo-code:
        // if (this.hidDevice) {
        //     this.hidDevice.removeAllListeners(); // Remove listeners
        //     this.hidDevice.close(); // Close the device handle
        //     this.hidDevice = null;
        // }
    }

    /**
     * @private
     * @description Placeholder for handling data received from the dictaphone (e.g., button presses).
     * @param {Buffer} data - The data received from the HID device.
     */
    _handleDictaphoneData(data) {
        // Decode the data buffer to understand which button was pressed/released
        // This is highly device-specific.
        logger.debug('Received data from dictaphone:', data);
        // Example: Assume byte 2 indicates button state
        // const buttonCode = data[2];
        // switch (buttonCode) {
        //    case 0x01: // Example code for 'Record' pressed
        //        this.emit('record_start');
        //        break;
        //    case 0x02: // Example code for 'Stop' pressed
        //        this.emit('record_stop');
        //        break;
        //    // Add other button codes
        // }
    }

    /**
     * @public
     * @description Gets the current status of the dictaphone connection.
     * @returns {DEVICE_STATUS} - The current status.
     */
    getStatus() {
        return this.status;
    }

    /**
     * @public
     * @description Cleans up resources, stops monitoring.
     */
    cleanup() {
        logger.info('Cleaning up DictaphoneHandler...');
        this.stopMonitoring(); // Stops monitoring and clears reconnect timeout
        this._removeDeviceListeners(); // Ensure device listeners are removed
        this.removeAllListeners(); // Remove all event listeners attached to this handler
        logger.info('DictaphoneHandler cleanup complete.');
    }
}

module.exports = DictaphoneHandler;
