# homebridge-winpc-tv

[![Donate](https://img.shields.io/badge/Donate-PayPal-blue?logo=paypal)](https://paypal.me/orenasher)

Windows PC as a single HomeKit Television accessory. Wake-on-LAN to turn on, Airytec Switch Off for shutdown/status. No external npm dependencies, no separate helper script.

## Install

sudo npm install -g homebridge-winpc-tv --unsafe-perm
sudo systemctl restart homebridge

## Config example (platforms array in config.json)

platform: WinPCTV, devices: [{name, mac, ip, httpPort, username, password, pollInterval}]

See config.schema.json for all fields and their defaults.

## Support

If this plugin saves you time, you can buy me a coffee: [paypal.me/orenasher](https://paypal.me/orenasher). Thank you!
