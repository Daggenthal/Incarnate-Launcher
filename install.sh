#!/usr/bin/env bash
# Incarnate Launcher for Linux, in one go:
#
#   curl -fsSL https://raw.githubusercontent.com/Daggenthal/Incarnate-Launcher/main/install.sh | bash
#
# What it does:
#   - Grabs the newest release for your computer (x64 or ARM) and checks it against its SHA-512
#   - Installs FUSE if AppImages need it here (libfuse2t64 on Ubuntu 24.04+, libfuse2 on older
#     Ubuntu/Debian, fuse-libs on Fedora, fuse2 on Arch, libfuse2 on openSUSE). Asks for your
#     password only if it actually installs something. SteamOS already has it
#   - Puts it in ~/Applications/Incarnate-Launcher.AppImage (updates replace that file) and adds
#     Incarnate Launcher to your app menu
# Run it again any time to reinstall. To remove it:
#   curl -fsSL https://raw.githubusercontent.com/Daggenthal/Incarnate-Launcher/main/install.sh | bash -s -- --uninstall
#
# Options (environment): INSTALL_DIR=<folder> (default ~/Applications), SKIP_FUSE=1,
# DEBUG=1 (print every step), NO_COLOR=1
set -euo pipefail

REPO="Daggenthal/Incarnate-Launcher"
NAME="Incarnate Launcher"
dir="${INSTALL_DIR:-$HOME/Applications}"
app="$dir/Incarnate-Launcher.AppImage"
data="${XDG_DATA_HOME:-$HOME/.local/share}"
desktop="$data/applications/incarnate-launcher.desktop"
icon="$data/icons/hicolor/512x512/apps/incarnate-launcher.png"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
    red=$'\e[31m'; yellow=$'\e[33m'; green=$'\e[32m'; cyan=$'\e[36m'; bold=$'\e[1m'; off=$'\e[0m'
else
    red=; yellow=; green=; cyan=; bold=; off=
fi
say()  { printf '%s\n' "$*"; }
ok()   { printf '%s%s%s\n' "$green" "$*" "$off"; }
warn() { printf '%s%s%s\n' "$yellow" "$*" "$off"; }
die()  { printf '%s%s%s\n' "$red" "$*" "$off" >&2; exit 1; }
dbg()  { [ "${DEBUG:-0}" = 1 ] && printf '%sdebug: %s%s\n' "$cyan" "$*" "$off" >&2; return 0; }

[ "$(uname -s)" = Linux ] || die "This installer is for Linux. Windows and macOS: grab yours from https://github.com/$REPO/releases/latest"
command -v curl > /dev/null || die "Needs curl (install it with your package manager, then run this again)"

# ---- Removing it ----
if [ "${1:-}" = --uninstall ]; then
    rm -f "$app" "$desktop" "$icon"
    command -v update-desktop-database > /dev/null && update-desktop-database "$data/applications" 2> /dev/null || true
    ok "$NAME removed. Your game files and settings are still there (~/.config/Incarnate Launcher and each server's install folder)."
    exit 0
fi

say "${bold}$NAME installer${off}"

# ---- Which build ----
case "$(uname -m)" in
    x86_64|amd64) yml=latest-linux.yml; arch=x64 ;;
    aarch64|arm64) yml=latest-linux-arm64.yml; arch=ARM ;;
    *) die "There's no build for $(uname -m) yet (only x64 and ARM)." ;;
esac
base="https://github.com/$REPO/releases/latest/download"
info="$(curl -fsSL "$base/$yml")" || die "Couldn't reach GitHub for the newest release. Check your connection and try again."
file="$(printf '%s\n' "$info" | sed -n 's/^path: *//p' | head -1)"
want="$(printf '%s\n' "$info" | sed -n 's/^sha512: *//p' | head -1)"
ver="$(printf '%s\n' "$info" | sed -n 's/^version: *//p' | head -1)"
[ -n "$file" ] || die "The newest release doesn't list a Linux $arch download."
dbg "release $ver: $file"
say "Newest version: $ver ($arch)"

# ---- FUSE (AppImages need FUSE 2 to start) ----
has_fuse() {
    { command -v ldconfig > /dev/null && ldconfig -p 2> /dev/null | grep -q 'libfuse\.so\.2'; } ||
    { [ -x /sbin/ldconfig ] && /sbin/ldconfig -p 2> /dev/null | grep -q 'libfuse\.so\.2'; } ||
    ls /usr/lib*/libfuse.so.2* /usr/lib*/*/libfuse.so.2* /lib*/*/libfuse.so.2* > /dev/null 2>&1
}
# In a subshell: /etc/os-release sets NAME too, which would rename the menu entry
distro="$( . /etc/os-release 2> /dev/null; printf '%s %s' "${ID:-unknown}" "${ID_LIKE:-}")"
run_root() {
    if [ "$(id -u)" = 0 ]; then "$@"
    elif command -v sudo > /dev/null; then say "Installing FUSE needs your password:"; sudo "$@"
    else return 1; fi
}
no_fuse=0
if [ "${SKIP_FUSE:-0}" = 1 ]; then dbg "SKIP_FUSE: not touching FUSE"
elif has_fuse; then dbg "FUSE 2 is already here"
elif [[ "$distro" == *steamos* ]]; then dbg "SteamOS: FUSE comes with it"
else
    pkg=""; cmd=()
    if [[ "$distro" == *debian* || "$distro" == *ubuntu* ]]; then
        if apt-cache show libfuse2t64 > /dev/null 2>&1; then pkg=libfuse2t64; else pkg=libfuse2; fi
        cmd=(apt-get install -y -qq "$pkg")
    elif [[ "$distro" == *fedora* || "$distro" == *rhel* || "$distro" == *centos* ]]; then pkg=fuse-libs; cmd=(dnf install -y "$pkg")
    elif [[ "$distro" == *arch* ]]; then pkg=fuse2; cmd=(pacman -S --needed --noconfirm "$pkg")
    elif [[ "$distro" == *suse* ]]; then pkg=libfuse2; cmd=(zypper --non-interactive install "$pkg")
    fi
    # apt: a stale package list can't find it, so refresh once and try again
    try_install() { run_root "${cmd[@]}" > /dev/null || { [ "${cmd[0]}" = apt-get ] && run_root apt-get update -qq > /dev/null && run_root "${cmd[@]}" > /dev/null; }; }
    if [ -n "$pkg" ] && try_install && has_fuse; then
        ok "Installed $pkg (FUSE)"
    else
        no_fuse=1
        warn "Couldn't install FUSE${pkg:+ ($pkg)}. It'll still run: the menu entry starts it without FUSE (a bit slower to open)."
    fi
fi

# ---- Download, check, install ----
mkdir -p "$dir"
tmp="$(mktemp "$dir/.incarnate-launcher.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
say "Downloading $file..."
if [ -t 1 ]; then curl -fL --progress-bar -o "$tmp" "$base/$file" || die "The download failed. Run this again to retry."
else curl -fsSL -o "$tmp" "$base/$file" || die "The download failed. Run this again to retry."; fi
if [ -n "$want" ]; then
    got=""
    if command -v openssl > /dev/null; then got="$(openssl dgst -sha512 -binary "$tmp" | base64 | tr -d '\n')"
    elif command -v python3 > /dev/null; then got="$(python3 -c 'import base64,hashlib,sys; print(base64.b64encode(hashlib.sha512(open(sys.argv[1],"rb").read()).digest()).decode())' "$tmp")"
    fi
    if [ -z "$got" ]; then warn "No openssl or python3 here, so the download's checksum wasn't checked."
    elif [ "$got" != "$want" ]; then die "The download doesn't match its checksum. Run this again to retry."
    else dbg "SHA-512 matches"; fi
fi
chmod 755 "$tmp"
mv -f "$tmp" "$app"
trap - EXIT
ok "Installed: $app"

# ---- App menu ----
mkdir -p "$(dirname "$desktop")" "$(dirname "$icon")"
curl -fsSL -o "$icon" "https://raw.githubusercontent.com/$REPO/main/assets/icon.png" 2> /dev/null || warn "Couldn't get the icon (the menu entry works without it)."
exec_line="\"$app\" %U"
[ "$no_fuse" = 1 ] && exec_line="env APPIMAGE_EXTRACT_AND_RUN=1 \"$app\" %U"
cat > "$desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=$NAME
Comment=Download, update and play City of Heroes servers
Exec=$exec_line
Icon=$icon
Terminal=false
Categories=Game;
StartupWMClass=$NAME
DESKTOP
command -v update-desktop-database > /dev/null && update-desktop-database "$data/applications" 2> /dev/null || true
ok "Added $NAME to your app menu"
say ""
say "Start it from your app menu, or run: ${bold}$app${off}"
say "It updates itself from now on. You still need Wine or Proton to play; it tells you if there's none."
