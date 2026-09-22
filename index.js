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
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    if (!this.api) return;

    this.api.on('didFinishLaunching', () => {
      if (!this.config.mac || !this.config.ip) {
        this.log.warn('[%s] Missing "mac" or "ip" in config. Accessory not created.', PLATFORM_NAME);
        return;
      }
      new WinPCTVAccessory(this, this.config);
    });
  }
}

class WinPCTVAccessory {
  constructor(platform, cfg) {
    this.platform = platform;
    this.log = platform.log;
    this.api = platform.api;
    this.Service = platform.Service;
    this.Characteristic = platform.Characteristic;

    this.name = cfg.name || 'Windows PC';
    this.mac = cfg.mac;
    this.ip = cfg.ip;
    this.broadcastAddress = cfg.broadcastAddress || '255.255.255.255';
    this.wolPort = cfg.wolPort || 9;
    this.httpPort = cfg.httpPort || 8000;
    this.username = cfg.username;
    this.password = cfg.password;
    this.statusPath = cfg.statusPath || '/';
    this.shutdownPath = cfg.shutdownPath || '/?action=System.Shutdown';
    this.restartPath = cfg.restartPath || '/?action=System.Restart';
    this.sleepPath = cfg.sleepPath || '/?action=System.Standby';
    this.pollInterval = Math.max(15, cfg.pollInterval || 60) * 1000;
    this.httpTimeoutMs = cfg.httpTimeoutMs || 4000;

    // WOL retry tuning
    this.wolRetries = cfg.wolRetries || 3;          // packets sent per "cycle"
    this.wolRetryDelayMs = cfg.wolRetryDelayMs || 400;
    this.wolMaxCycles = cfg.wolMaxCycles || 3;       // how many times to re-check & resend
    this.wolBootWaitMs = cfg.wolBootWaitMs || 20000; // wait between cycles

    this.currentActive = false;
    this._wolInProgress = false;

    const uuid = this.api.hap.uuid.generate('homebridge-winpc-tv-' + this.mac);
    this.accessory = new this.api.platformAccessory(this.name, uuid);
    this.accessory.category = this.api.hap.Categories.TELEVISION;

    this._setupTelevisionService();
    this._setupInputSources();

    this.api.publishExternalAccessories(PLUGIN_NAME_SAFE(), [this.accessory]);
    this.log('[%s] Published as an external Television accessory.', this.name);

    this._refreshStatus();
    setInterval(() => this._refreshStatus(), this.pollInterval);
  }

  _setupTelevisionService() {
    const tv = this.accessory.addService(this.Service.Television, this.name, 'tv');
    tv.setCharacteristic(this.Characteristic.ConfiguredName, this.name);
    tv.setCharacteristic(this.Characteristic.SleepDiscoveryMode, this.Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE);

    tv.getCharacteristic(this.Characteristic.Active)
      .onGet(() => this.currentActive)
      .onSet((value) => this._setActive(!!value));

    tv.getCharacteristic(this.Characteristic.ActiveIdentifier)
      .onGet(() => this._activeIdentifier || 1)
      .onSet((value) => this._onSetActiveIdentifier(tv, value));

    this.tvService = tv;
    this._activeIdentifier = 1;
  }

  _setupInputSources() {
    const inputs = [
      { id: 1, name: 'Windows' },
      { id: 2, name: 'Restart' },
      { id: 3, name: 'Sleep' }
    ];
    for (const inp of inputs) {
      const src = this.accessory.addService(this.Service.InputSource, inp.name, 'input' + inp.id);
      src.setCharacteristic(this.Characteristic.Identifier, inp.id)
        .setCharacteristic(this.Characteristic.ConfiguredName, inp.name)
        .setCharacteristic(this.Characteristic.IsConfigured, this.Characteristic.IsConfigured.CONFIGURED)
        .setCharacteristic(this.Characteristic.InputSourceType, this.Characteristic.InputSourceType.OTHER)
        .setCharacteristic(this.Characteristic.CurrentVisibilityState, this.Characteristic.CurrentVisibilityState.SHOWN);
      this.tvService.addLinkedService(src);
    }
  }

  async _onSetActiveIdentifier(tv, value) {
    this._activeIdentifier = value;

    if (!this.currentActive) return; // ignore input taps while PC is off

    if (value === 2) {
      this.log('[%s] Restart requested via input selection.', this.name);
      try { await this._httpRequest(this.restartPath); }
      catch (e) { this.log.warn('[%s] Restart request failed: %s', this.name, e.message); }
      this._revertToWindowsInput(tv);
    } else if (value === 3) {
      this.log('[%s] Sleep requested via input selection.', this.name);
      try { await this._httpRequest(this.sleepPath); }
      catch (e) { this.log.warn('[%s] Sleep request failed: %s', this.name, e.message); }
      this._revertToWindowsInput(tv);
    }
  }

  _revertToWindowsInput(tv) {
    setTimeout(() => {
      this._activeIdentifier = 1;
      tv.updateCharacteristic(this.Characteristic.ActiveIdentifier, 1);
    }, 3000);
  }

  async _setActive(desired) {
    if (desired) {
      await this._wakeWithRetries();
    } else {
      try {
        await this._httpRequest(this.shutdownPath);
        this.currentActive = false;
      } catch (e) {
        this.log.warn('[%s] Shutdown request failed: %s', this.name, e.message);
      }
    }
  }

  async _wakeWithRetries() {
    if (this._wolInProgress) return;
    this._wolInProgress = true;

    for (let cycle = 1; cycle <= this.wolMaxCycles; cycle++) {
      this.log('[%s] Wake attempt %d/%d: sending %d magic packet(s)...', this.name, cycle, this.wolMaxCycles, this.wolRetries);
      for (let i = 0; i < this.wolRetries; i++) {
        this._sendMagicPacket();
        await this._sleep(this.wolRetryDelayMs);
      }

      await this._sleep(this.wolBootWaitMs);

      const up = await this._checkStatus();
      if (up) {
        this.currentActive = true;
        this.tvService.updateCharacteristic(this.Characteristic.Active, true);
        this._activeIdentifier = 1;
        this.tvService.updateCharacteristic(this.Characteristic.ActiveIdentifier, 1);
        this.log('[%s] PC is now on (confirmed after cycle %d).', this.name, cycle);
        this._wolInProgress = false;
        return;
      }
      this.log('[%s] PC not responding yet after cycle %d.', this.name, cycle);
    }

    this.log.warn('[%s] Gave up waking PC after %d cycles.', this.name, this.wolMaxCycles);
    this._wolInProgress = false;
  }

  _sendMagicPacket() {
    const macBytes = this.mac.split(/[:-]/).map((h) => parseInt(h, 16));
    if (macBytes.length !== 6 || macBytes.some(isNaN)) {
      this.log.warn('[%s] Invalid MAC address: %s', this.name, this.mac);
      return;
    }
    const packet = Buffer.alloc(102);
    packet.fill(0xff, 0, 6);
    for (let i = 6; i < 102; i += 6) {
      Buffer.from(macBytes).copy(packet, i);
    }
    const socket = dgram.createSocket('udp4');
    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(packet, 0, packet.length, this.wolPort, this.broadcastAddress, () => {
        socket.close();
      });
    });
  }

  async _checkStatus() {
    try {
      await this._httpRequest(this.statusPath);
      return true;
    } catch (e) {
      return false;
    }
  }

  async _refreshStatus() {
    const up = await this._checkStatus();
    if (up !== this.currentActive) {
      this.currentActive = up;
      this.tvService.updateCharacteristic(this.Characteristic.Active, up);
      if (up) {
        this._activeIdentifier = 1;
        this.tvService.updateCharacteristic(this.Characteristic.ActiveIdentifier, 1);
      }
    }
  }

  _httpRequest(path) {
    return new Promise((resolve, reject) => {
      const auth = (this.username || this.password)
        ? Buffer.from(`${this.username || ''}:${this.password || ''}`).toString('base64')
        : null;
      const options = {
        host: this.ip,
        port: this.httpPort,
        path,
        method: 'GET',
        timeout: this.httpTimeoutMs,
        headers: auth ? { Authorization: 'Basic ' + auth } : {}
      };
      const req = http.request(options, (res) => {
        res.on('data', () => {});
        res.on('end', () => {
          if (res.statusCode && res.statusCode < 400) resolve();
          else reject(new Error('HTTP ' + res.statusCode));
        });
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.on('error', (err) => reject(err));
      req.end();
    });
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function PLUGIN_NAME_SAFE() {
  return PLUGIN_NAME;
}
