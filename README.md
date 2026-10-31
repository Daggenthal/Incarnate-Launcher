# Incarnate Launcher

Incarnate Launcher was made to be an OS-Agnostic launcher, allowing it to run on Windows, macOS (Intel / Apple Silicon), and Linux. The goal of this was to have an easy one-stop place where you can easily update the servers that you play on, as there aren't any official "native" launchers, as they mostly just run through Wine / CrossOver, to run the original .exe.

Incarnate Launcher runs through Electron as a way to enable those OS-Agnostic capabilities. If you have any issues using this, please feel free to reach out (open an issue here on GitHub), as I am constantly updating this for as long as I can. There's only so much that can be added to it now, as it's mostly complete.

## What it does

- **Servers:** Homecoming, Thunderspy, Rebirth, Cake: New Dawn and Unity are one click away, and any other server works with its manifest address.
- **Downloads:** Starts on the fastest mirror, jumps to another if one fails or crawls, resumes where it left off, checks every file, and shows your speed and time left.
- **Server status:** Up or down, players online, and each shard's status where the server publishes it.
- **News:** The server's news, right in the launcher.
- **Runs on macOS and Linux too:** It finds CrossOver, Whisky, Wine or Proton by itself and uses it.
- **Logs:** Copy Logs and Copy Crash Reports put everything a server's staff needs on your clipboard.
- **Updates:** It tells you when a new version is out.

## Download

Grab the newest version from [Releases](https://github.com/Daggenthal/Incarnate-Launcher/releases/latest):

| System | File |
|---|---|
| Windows | `Incarnate-Launcher-Setup-x.y.z.exe` |
| macOS (Apple Silicon and Intel) | `Incarnate-Launcher-x.y.z-mac-universal.dmg` |
| Linux (x64) | `Incarnate-Launcher-x.y.z-linux-x86_64.AppImage` |
| Linux (ARM) | `Incarnate-Launcher-x.y.z-linux-arm64.AppImage` |

The launcher isn't signed with a paid Apple or Microsoft certificate, so the first time you open it your system will warn you. That's expected. Here's how to get past it on each one.

## Windows

1. Run `Incarnate-Launcher-Setup-x.y.z.exe`.
2. If Windows says **"Windows protected your PC"**: Click **More info**, then **Run anyway**. You only have to do this once.
3. That's it. City of Heroes is a Windows game, so nothing else is needed.

## macOS

1. Open the `.dmg`. Drag **Incarnate Launcher** onto the **Applications** folder in that window.
2. Open it from Applications. macOS will say it can't verify the app. Click **Done** (not Move to Trash).
3. Open **System Settings → Privacy & Security**, scroll down to the message about Incarnate Launcher, and click **Open Anyway**. Enter your password if it asks, then click **Open Anyway** again.
4. From now on it opens normally.

You also need something that runs Windows games. The launcher tells you if it can't find one:

- **[CrossOver](https://www.codeweavers.com/crossover):** Paid, with a free trial. The easiest and most reliable.
- **[Whisky](https://getwhisky.app/):** Free.
- **Wine:** Free. With Homebrew: `brew install --cask wine-stable`

If macOS still refuses to open it, this does the same as Open Anyway (in Terminal):

```
xattr -dr com.apple.quarantine "/Applications/Incarnate Launcher.app"
```

## Linux

1. Download the AppImage and make it executable: right-click it, then Properties → Permissions → **Allow executing file as program**. Or in a terminal:
   ```
   chmod +x Incarnate-Launcher-*.AppImage
   ```
2. Run it.
3. If it doesn't start and says something about FUSE: Install `libfuse2` (Ubuntu/Debian: `sudo apt install libfuse2`, Fedora: `sudo dnf install fuse-libs`).

You also need Wine or Proton. The launcher finds them by itself and tells you if there's none:

- **Proton:** Install Steam, then any Proton version from your Library (under Tools). GE-Proton works too.
- **Wine:** From your package manager, for example `sudo apt install wine` or `sudo dnf install wine`.
- **[umu-run](https://github.com/Open-Wine-Components/umu-launcher):** Proton without Steam.

**Steam Deck:** Works in Desktop Mode, the same as any Linux PC.

## If the game doesn't start

- **Settings → Run the game with:** Try another one. Proton often runs it when Wine doesn't.
- **Copy Logs:** Paste it to your server's staff (Discord, forums). It has what they need to help.
- **Repair:** Settings has **Repair (verify checksums)**, which re-downloads any file that's damaged.

## Where things are

- **Logs:** Settings shows the folder, with Copy and Open.
- **Game files:** Each server gets its own folder (by default under `Games/City of Heroes` in your home folder). You pick where when you add it.

## Building it yourself

You need [Node.js](https://nodejs.org/) 20 or newer.

```
npm install
npm start          # run it
npm test           # the tests
npm run dist       # build the app for your system, into dist/
```

Pushing a tag like `v0.2.0` (matching `version` in `package.json`) builds macOS, Windows and Linux on GitHub and attaches them to a release.

## License

MIT. See [LICENSE](LICENSE).

City of Heroes is a trademark of NCSoft. This project isn't affiliated with or endorsed by NCSoft, or by any of the servers it lists: Homecoming, Thunderspy, Rebirth, Cake: New Dawn or Unity. Their names are only there so you can find and add them.
