const dgram = require('dgram');
const http = require('http');

const PLATFORM_NAME = 'WinPCTV';
const PLUGIN_NAME = 'homebridge-winpc-tv';

module.exports = (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, WinPCTVPlatform);
};

class WinPCTVPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;

    this.devices = Array.isArray(this.config.devices) ? this.config.devices : [];

    if (!this.api) return;

    this.api.on('didFinishLaunching', () => {
      if (this.devices.length === 0) {
        this.log.warn('No devices configured for %s. Add at least one device in the plugin config.', PLATFORM_NAME);
        return;
      }
      for (const deviceConfig of this.devices) {
        try {
          new WinPCTVAccessory(this, deviceConfig);
        } catch (err) {
          this.log.error('Failed to set up device "%s": %s', deviceConfig && deviceConfig.name, err.message);
        }
      }
    });
  }

  configureAccessory(accessory) {
    this.log.debug('Ignoring cached accessory %s (this plugin re-publishes fresh on every launch)', accessory.displayName);
  }
}

class WinPCTVAccessory {
  constructor(platform, config) {
    this.platform = platform;
    this.log = platform.log;
    this.api = platform.api;

    if (!config || !config.name || !config.mac || !config.ip) {
      throw new Error('Each device needs at least "name", "mac", and "ip" set in the config.');
    }

    this.name = config.name;
    this.mac = config.mac;
    this.ip = config.ip;
    this.broadcastAddress = config.broadcastAddress || '255.255.255.255';
    this.wolPort = Number(config.wolPort) || 9;

    this.httpPort = Number(config.httpPort) || 8000;
    this.username = config.username || '';
    this.password = config.password || '';
    this.statusPath = config.statusPath || '/';
    this.shutdownPath = config.shutdownPath || '/?action=System.Shutdown';

    this.pollInterval = Math.max(Number(config.pollInterval) || 60, 15) * 1000;
    this.httpTimeout = Math.max(Number(config.httpTimeoutMs) || 4000, 1000);

    this.currentActive = 0;

    this._setupAccessory();
    this._startPolling();
  }

  _setupAccessory() {
    const { Service, Characteristic, uuid } = this.api.hap;

    const accessoryUUID = uuid.generate(`homebridge-winpc-tv:${this.mac}`);
    this.accessory = new this.api.platformAccessory(this.name, accessoryUUID);
    this.accessory.category = this.api.hap.Categories.TELEVISION;

    this.accessory
      .getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'Oren Asher')
      .setCharacteristic(Characteristic.Model, 'WinPC Virtual TV')
      .setCharacteristic(Characteristic.SerialNumber, this.mac)
      .setCharacteristic(Characteristic.FirmwareRevision, '1.0.0');

    this.tvService = this.accessory.addService(Service.Television, this.name);
    this.tvService
      .setCharacteristic(Characteristic.ConfiguredName, this.name)
      .setCharacteristic(Characteristic.SleepDiscoveryMode, Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE);

    this.tvService
      .getCharacteristic(Characteristic.Active)
      .onGet(() => this.currentActive)
      .onSet((value) => this._setActive(value));

    this.tvService.setCharacteristic(Characteristic.ActiveIdentifier, 1);
    this.tvService
      .getCharacteristic(Characteristic.ActiveIdentifier)
      .onSet(() => {});

    const inputService = this.accessory.addService(Service.InputSource, 'windows-input', 'windows-input');
    inputService
      .setCharacteristic(Characteristic.Identifier, 1)
      .setCharacteristic(Characteristic.ConfiguredName, 'Windows')
      .setCharacteristic(Characteristic.IsConfigured, Characteristic.IsConfigured.CONFIGURED)
      .setCharacteristic(Characteristic.InputSourceType, Characteristic.InputSourceType.OTHER)
      .setCharacteristic(Characteristic.CurrentVisibilityState, Characteristic.CurrentVisibilityState.SHOWN);
    this.tvService.addLinkedService(inputService);

    this.api.publishExternalAccessories(PLUGIN_NAME, [this.accessory]);
    this.log.info('[%s] Published as an external Television accessory.', this.name);
  }

  _startPolling() {
    this._refreshStatus();
    this._pollTimer = setInterval(() => this._refreshStatus(), this.pollInterval);
  }

  _setActive(value) {
    const { Characteristic } = this.api.hap;
    if (value === Characteristic.Active.ACTIVE) {
      this.log.info('[%s] Turning on (Wake-on-LAN to %s)', this.name, this.mac);
      this._sendMagicPacket()
        .then(() => {
          this.currentActive = Characteristic.Active.ACTIVE;
        })
        .catch((err) => this.log.error('[%s] Failed to send Wake-on-LAN packet: %s', this.name, err.message));
    } else {
      this.log.info('[%s] Turning off (via Airytec Switch Off)', this.name);
      this._httpRequest(this.shutdownPath)
        .catch((err) => this.log.warn('[%s] Shutdown request failed (PC may already be off): %s', this.name, err.message));
    }
  }

  _refreshStatus() {
    const { Characteristic } = this.api.hap;
    this._httpRequest(this.statusPath)
      .then(() => {
        this.currentActive = Characteristic.Active.ACTIVE;
        this.tvService.updateCharacteristic(Characteristic.Active, this.currentActive);
      })
      .catch(() => {
        this.currentActive = Characteristic.Active.INACTIVE;
        this.tvService.updateCharacteristic(Characteristic.Active, this.currentActive);
      });
  }

  _httpRequest(path) {
    return new Promise((resolve, reject) => {
      const options = {
        host: this.ip,
        port: this.httpPort,
        path,
        method: 'GET',
        timeout: this.httpTimeout,
      };
      if (this.username) {
        const token = Buffer.from(`${this.username}:${this.password}`).toString('base64');
        options.headers = { Authorization: `Basic ${token}` };
      }
      const req = http.request(options, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 400) {
          resolve();
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
      req.on('timeout', () => req.destroy(new Error('timed out')));
      req.on('error', reject);
      req.end();
    });
  }

  _sendMagicPacket() {
    return new Promise((resolve, reject) => {
      const macBytes = this.mac.split(/[:-]/).map((part) => parseInt(part, 16));
      if (macBytes.length !== 6 || macBytes.some((b) => Number.isNaN(b))) {
        reject(new Error(`Invalid MAC address: ${this.mac}`));
        return;
      }

      const packet = Buffer.alloc(6 + 16 * 6);
      packet.fill(0xff, 0, 6);
      for (let i = 0; i < 16; i++) {
        Buffer.from(macBytes).copy(packet, 6 + i * 6);
      }

      const socket = dgram.createSocket('udp4');
      socket.once('error', (err) => {
        socket.close();
        reject(err);
      });
      socket.bind(() => {
        socket.setBroadcast(true);
        socket.send(packet, 0, packet.length, this.wolPort, this.broadcastAddress, (err) => {
          socket.close();
          if (err) reject(err);
          else resolve();
        });
      });
    });
  }
}
