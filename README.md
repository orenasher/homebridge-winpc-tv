# homebridge-winpc-tv

Windows PC as a single HomeKit Television accessory. Wake-on-LAN to turn on, Airytec Switch Off for shutdown/status. No external npm dependencies, no separate helper script.

## Install

sudo npm install -g homebridge-winpc-tv --unsafe-perm
sudo systemctl restart homebridge

## Config example (platforms array in config.json)

platform: WinPCTV, devices: [{name, mac, ip, httpPort, username, password, pollInterval}]

See config.schema.json for all fields and their defaults.
