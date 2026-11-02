# NahuenTV: Setup Guide

This guide takes you from nothing to all 16 TVs running and controlled from your office.

**Your stores:** Tamarac (5 TVs) · Key Biscayne (5 TVs) · Doral (6 TVs). These are already set up in the control panel.

| Part | What you do | Time |
|---|---|---|
| 1 | Rent the cloud server (DigitalOcean) | 10 min |
| 2 | Point a web address at it (recommended) | 10 min |
| 3 | Install the software on the server | 10 min |
| 4 | Set up each Fire TV Stick | ~10 min per TV |
| 5 | Set up the live TV screens | ~10 min per TV |

**Test first:** do parts 1–4 with **one** Fire TV Stick before buying the rest.

---

## Part 1: Rent the cloud server

1. Go to **digitalocean.com** and create an account (you need an email and a credit card).
2. Click **Create → Droplets**.
3. Choose:
   - **Region:** New York or Atlanta (closest to Florida)
   - **Image:** Ubuntu **24.04 (LTS)**
   - **Size:** Basic → Regular → **1 GB RAM / 1 CPU** (about $6/month). You can resize later if you need more space for videos.
   - **Authentication:** Password. Choose a strong one and **save it in a safe place**.
   - **Backups:** turn **on** (about $1.20/month)
   - **Hostname:** `nahuentv`
4. Click **Create Droplet**. After about a minute you'll see its **IP address** (for example `143.198.10.20`). Write it down.

## Part 2: Web address (recommended)

A web address such as `signage.yourstore.com` gives you:
- a secure **https** connection to the control panel, and
- **offline mode** on the TVs: if a store's internet goes down, the TVs keep playing even after a restart. *This only works with https.*

1. Use a domain you already own, or buy one (about $12/year) at **Cloudflare**, **Porkbun** or **Namecheap**.
2. In that company's **DNS** settings, add a record:
   - **Type:** `A` · **Name:** `signage` · **Value:** your Droplet's IP address
   - **On Cloudflare:** set the cloud icon to **"DNS only" (grey)**, not "Proxied". Proxied mode blocks large video uploads.
3. Wait 5–30 minutes for it to take effect.

## Part 3: Install the software

The server downloads the code from your GitHub repository, [Joseamorosi/nahuentv](https://github.com/Joseamorosi/nahuentv).

**3.1 Log in to the server.** On your computer, open a terminal (Mac: *Terminal*; Windows: *PowerShell*). Replace `YOUR_IP` with the Droplet's IP:

```bash
ssh root@YOUR_IP
```

Type `yes` if asked, then enter the Droplet password. **Everything below runs on the server.**

**3.2 Download and install** (use your own web address):

```bash
git clone https://github.com/Joseamorosi/nahuentv.git && cd nahuentv && bash install.sh signage.yourstore.com
```

No web address yet? Leave it off: `bash install.sh`. You can run it again with an address later.

When it finishes, it prints the address to open. Open it in your browser and **create your control panel password**.

> **Updating later:** in the control panel, go to **Settings → Software update** and click **Update now**. It shows whether a newer version is available, installs it in 1–3 minutes, and reloads the page when done. Your media, playlists, settings and web address are kept.
>
> If the button ever can't run, the manual way still works: in the Droplet Console run `cd ~/nahuentv && git pull && bash install.sh`.

## Part 4: Set up a Fire TV Stick

Do this at the store, for each TV.

### 4.1 Basic setup
1. Plug the stick into the TV's HDMI port. **Power it from the wall outlet** with its own adapter, not from the TV's USB port.
2. Follow the on-screen setup: connect to the store's **Wi-Fi** and sign in with an Amazon account. One account for all sticks is fine.
3. **Stop the screensaver and sleep:**
   - Settings → **Display & Sounds** → **Screensaver** → *Start Time* → **Never**
   - If your model has it: Settings → Display & Sounds → **Display** → *Sleep* → **Never**

### 4.2 Install Fully Kiosk Browser
1. Settings → **My Fire TV** → **Developer Options**.
   - If you don't see Developer Options: open Settings → My Fire TV → **About**, then click your device name **7 times**.
2. From the Amazon Appstore, install the free app **Downloader** (the orange icon).
3. In Developer Options, turn on **Install Unknown Apps** (or *Apps from Unknown Sources*) for **Downloader**.
4. Open **Downloader**, type `fully-kiosk.com` and press Go. Download and install **Fully Kiosk Browser** (choose the APK for Fire TV / Android TV).
5. Buy a **Fully Kiosk PLUS** license for each stick at fully-kiosk.com. It's a one-time payment, and it removes the watermark and turns on the features this system uses. Activate it in Fully's settings as described on their site.

### 4.3 Configure Fully Kiosk
Open Fully Kiosk. Open its settings by swiping from the left edge, or with the remote's menu (☰) button. Then set:

| Where (in Fully's settings) | Setting | Value |
|---|---|---|
| Web Content Settings | **Start URL** | This TV's link (see below) |
| Web Content Settings | **Autoplay Videos** | ON |
| Advanced Web Settings | **Enable JavaScript Interface** | **ON** (required for live TV and screen hours) |
| Device Management | **Launch on Boot** | ON |
| Device Management | **Keep Screen On** | ON |

**Getting the TV link:** in the control panel go to **Screens**, find the TV (for example *Doral → TV 1*) and click **🔗 Copy TV link**. Typing the link with the remote is slow. It's easier to email or text the link to yourself, open it on your phone, and use the **Fire TV phone app** as a keyboard.

> Each link belongs to **one** TV. If a TV shows the wrong store or number, it has the wrong link.

### 4.4 Check it
- Within a few seconds the TV shows its **store and TV name** on a dark screen. That means it's connected, with no playlist assigned yet.
- In the control panel, that TV turns **green (Online)**.
- Rename it if you like (⚙ Settings → *TV name*, for example "Front Counter").
- Put a label on the stick, such as "Doral TV 1".

## Part 5: Live TV screens

Do this only on the few TVs that will show live TV. A Fire TV Stick **4K Max** is recommended for these.

1. Install your business TV provider's app from the Amazon Appstore (for example YouTube TV, or your Comcast Business / DirecTV for Business app), **sign in**, and **tune to the channel** you want. The app usually reopens on the last channel.
2. In the control panel, open that TV's **⚙ Settings**:
   - Check **This TV can show live TV**
   - Choose the app. YouTube TV is built in. For any other app choose **Other** and enter its *package name* (see below).
   - Optional: add a **live TV schedule**, for example Sat & Sun 12:00–4:00 pm.
3. The TV card now has three buttons:
   - **Slideshow**: always shows its playlist
   - **Live TV**: always shows live TV
   - **Schedule**: live TV during the scheduled times, slideshow the rest of the time

**Finding an app's package name:** in Fully Kiosk's settings, use the app picker (for example under *Kiosk Mode → App Whitelist* or *Universal Launcher → Add App*). It lists each installed app with its package name, such as `com.google.android.youtube.tvunplugged`. The free app *Package Name Viewer* also works.

**Test these on your first stick:**
1. Click **Live TV**. Within about 15 seconds, the live TV app should open.
2. Click **Slideshow**. Within about 15 seconds, the slideshow should come back.

If step 2 doesn't happen by itself, check that **Enable JavaScript Interface** is ON in Fully. If it still doesn't come back, tell me what happens. Some Fire OS versions limit apps running in the background, and there are other ways to make it return (Fully's remote admin, or a scheduled restart).

**Channels:** the control panel opens the TV app but can't choose a channel. To change channels, use the stick's remote at the store, or the **Fire TV app** on a phone connected to the store's Wi-Fi.

**Licensing:** a home YouTube TV or Xfinity subscription isn't licensed for business use. Use a business TV plan for these screens.

---

## Everyday use

1. **Media:** upload images and videos.
   - Images: **1920 × 1080** JPG or PNG (landscape).
   - Videos: **MP4 (H.264), 1080p**. Keep files under about 300 MB each when possible. Store Wi-Fi only downloads each video once, but smaller files arrive faster.
2. **Playlists:** create a playlist, add items, set how many seconds each image shows, drag to reorder, then click **Save & send to TVs**.
   - Videos play from start to finish. Check **Sound** to play a video's audio.
3. **Screens:** pick a playlist for each TV, or use **Show on all [store] TVs** or **Show on ALL TVs**.

TVs pick up changes **within 15 seconds**.

**Screen hours (optional):** Screens → ⚙ Store settings → set an **On** and **Off** time. Outside those hours the screen goes black. Whether the TV itself powers off depends on the TV model.

## Troubleshooting

| Problem | Fix |
|---|---|
| TV is red (offline) in the control panel | Check the store's Wi-Fi and that the stick has power. Unplug the stick for 10 seconds and plug it back in. |
| TV says "Unknown TV link" | The link was reset or mistyped. Copy the link again from the control panel and enter it in Fully's Start URL. |
| TV shows its name instead of the slideshow | No playlist is assigned, or the playlist is empty. |
| A video doesn't play / gets skipped | Re-export it as MP4 (H.264), 1080p. |
| Video has no sound | Check **Sound** on the item in the playlist, and make sure **Autoplay Videos** is ON in Fully. |
| Fire TV home screen shows instead of the player | Check **Launch on Boot** in Fully. Open Fully once manually. |
| Can't open the control panel | Check the Droplet is running in DigitalOcean. On the server: `systemctl status nahuentv`. |
| Forgot the control panel password | Log in to the server (`ssh root@YOUR_IP`) and run `node /opt/nahuentv/reset-password.js`. It asks for a new password. |

## Where things are stored on the server

- App: `/opt/nahuentv`
- Your media, playlists and settings: `/var/lib/nahuentv`. This is included in DigitalOcean backups.
- App log: `journalctl -u nahuentv -n 100`
