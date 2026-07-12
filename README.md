
# Nanit Camera
## How to install:
- Install Node and npm -> https://docs.npmjs.com/downloading-and-installing-node-js-and-npm  
- Install https://www.scrypted.app/ and follow instructions on the website.  
- Once you have Scrypted running and can access it...continue  

- Open this plugin directory in VS Code  
- In a terminal cd into this project directory  
- run `npm install` 
- run `npm run build` 
- run `npm run scrypted-deploy 127.0.0.1` NOTE: you can replace `127.0.0.1` with the ip address of the server you installed scrypted on  

The  `Terminal` area may show an authentication failure and prompt you to log in to the Scrypted Management Console with `npx scrypted login`. You will only need to do this once. You can then relaunch afterwards.  The command if your scrypted instance is remote is `npx scrypted login ip:port`
  
- Launch Scrypted, go to "Devices"  
- You should see a device named `Nanit Camera Plugin`, click it  
- Enter your email and password on the right, then click save.   
- You'll receive the mfa token enter that in the "Two Factor Code" and click save again  
- Wait a few seconds then reload the page: Refresh Token, Access Token and Expiration should all have values  
- Now go back to devices and you should see a new device that is named the same as your Nanit Device. Click it and then click the video and it should be streaming!  


## Troubleshooting

If you aren't seeing the video load, first try clearing the Expiration value in the `Nanit Camera Plugin` and click save. This will force the plugin to get a new token.  

If you are still having issues then clear the `access_token` and `refresh_token` values and click save. 

Finally, Login again with your username and password + two factor auth by following instructions in above section

## Local streaming

When possible, this plugin gets the camera to publish its video **directly to this Scrypted
host over the local network**, instead of always round-tripping through Nanit's cloud relay
(`media-secured.nanit.com`). It does this the same way Nanit's own mobile app does when it detects
the camera and viewer are on the same network: the cloud is only used to send the camera a
control-channel command telling it where to publish; the video itself never leaves the LAN.

Configure this under the plugin's own settings:
- **Enable Local Streaming** - on by default. Falls back automatically to the previous cloud-pull
  behavior if local streaming can't be established (wrong network, firewall not configured, etc).
- **Local Stream Host** - the LAN IP address of this Scrypted host, as reachable *by the camera*.
  If the camera is on a different VLAN/subnet than this host (e.g. an IoT VLAN), you'll need a
  firewall rule on your router allowing the camera to reach this host on the port below.
- **Local Stream Port** - defaults to `1935`.
- **Verbose Logging** - off by default. Turn on to also log high-frequency, low-value-by-default
  messages (every sensor data push, device sync/lookup scaffolding) - useful when troubleshooting,
  noisy otherwise.

Per-camera, under that device's own settings:
- **Keep Local Stream Connected** - off by default (matches the original on-demand/Battery
  behavior below). Turn on to keep a lightweight signaling connection open continuously, which
  makes the stream load near-instantly and keeps it available in the background for motion
  detection (e.g. via Scrypted's Video Analysis / OpenCV plugin) and HomeKit Secure Video. Only
  the small control channel touches Nanit's cloud continuously either way - the video stays local
  whenever a local stream is active, regardless of this setting.
- **Report Temperature/Humidity** - off by default, independent of the setting above. Exposes the
  camera's temperature/humidity readings to HomeKit. Requires the camera to be seated in a stand
  with a working sensor.

With "Keep Local Stream Connected" **off**, the device is still declared as a Battery camera in
Scrypted, for the same reason as before: so Scrypted doesn't pre-buffer / stay connected 24/7.
Turning it **on** drops the Battery interface and adds MotionSensor/BinarySensor - not because
Nanit's own protocol reliably delivers motion/sound events over this channel (in practice it
doesn't seem to), but so that a continuously-available local stream can feed a real motion
detector (e.g. Scrypted's own Video Analysis plugin), which needs a stream to already be
available rather than waiting on an on-demand one.

Snapshots derive from whichever stream (local or cloud) is actually in use, the same way
`takePicture()` always has - they were unreliable before mainly because they depended on a fresh
~10s cloud RTMPS handshake per request; a local, low-latency source removes that bottleneck.


## Importing into Home Assistant
### Method 1
- Under the camera, make sure the rebroadcast plugin is enabled. 
- In the Camera settings go to the Stream and there should be a "RTSP Rebroadcast URL" box. Copy that value
- In HomeAssistant add a camera entity -> https://www.home-assistant.io/integrations/generic/ 
  - The copied value is your "stream source"
  
### Method 2
- https://github.com/koush/scrypted/wiki/Installation:-Home-Assistant-OS
