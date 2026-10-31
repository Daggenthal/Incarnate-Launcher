#!/usr/bin/env bash
# Incarnate Launcher for Linux, in one go:
#
#   curl -fsSL https://raw.githubusercontent.com/Daggenthal/Incarnate-Launcher/main/install.sh | bash
#   wget -qO- https://raw.githubusercontent.com/Daggenthal/Incarnate-Launcher/main/install.sh | bash
#   (whichever one you have: Ubuntu Desktop comes with wget, not curl)
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
#   (or the wget line with bash -s -- --uninstall)
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
# curl or wget, whichever is here
if command -v curl > /dev/null; then
    get()  { curl -fsSL "$1"; }
    save() { if [ -t 1 ] && [ "${3:-}" = bar ]; then curl -fL --progress-bar -o "$2" "$1"; else curl -fsSL -o "$2" "$1"; fi; }
elif command -v wget > /dev/null; then
    get()  { wget -qO- "$1"; }
    save() { if [ -t 1 ] && [ "${3:-}" = bar ]; then wget -q --show-progress -O "$2" "$1"; else wget -qO "$2" "$1"; fi; }
else
    die "Needs curl or wget (install either with your package manager, then run this again)"
fi

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
info="$(get "$base/$yml")" || die "Couldn't reach GitHub for the newest release. Check your connection and try again."
file="$(printf '%s\n' "$info" | sed -n 's/^path: *//p' | head -1)"
want="$(printf '%s\n' "$info" | sed -n 's/^sha512: *//p' | head -1)"
ver="$(printf '%s\n' "$info" | sed -n 's/^version: *//p' | head -1)"
[ -n "$file" ] || die "The newest release doesn't list a Linux $arch download."
dbg "release $ver: $file"
say "Newest version: $ver ($arch)"

# ---- What AppImages need to start ----
# FUSE 2 on every system; on ARM also libz.so (the ARM AppImage's start-up code loads it by that
# exact name, which Debian/Ubuntu/Fedora/openSUSE only have with zlib's development package)
has_lib() {
    { command -v ldconfig > /dev/null && ldconfig -p 2> /dev/null | grep -q "$1"; } ||
    { [ -x /sbin/ldconfig ] && /sbin/ldconfig -p 2> /dev/null | grep -q "$1"; } ||
    ls /usr/lib*/$2 /usr/lib*/*/$2 /lib*/$2 /lib*/*/$2 > /dev/null 2>&1
}
has_fuse() { has_lib 'libfuse\.so\.2' 'libfuse.so.2*'; }
has_libz() { has_lib 'libz\.so ' 'libz.so'; }
# In a subshell: /etc/os-release sets NAME too, which would rename the menu entry
distro="$( . /etc/os-release 2> /dev/null; printf '%s %s' "${ID:-unknown}" "${ID_LIKE:-}")"
# A terminal we can actually open (the file is there even when there's none)
has_tty() { (exec < /dev/tty) 2> /dev/null; }
# As root. Piped into bash, stdin is this script, so sudo gets the terminal for the password
run_root() {
    if [ "$(id -u)" = 0 ]; then "$@"
    elif command -v sudo > /dev/null && has_tty; then sudo "$@" < /dev/tty
    elif command -v sudo > /dev/null; then sudo "$@"
    else echo "no sudo here"; return 1; fi
}
# This system's package manager, and its names for FUSE 2 and zlib's development package
pm=""; fuse_pkg=""; zlib_pkg=""
if [[ "$distro" == *debian* || "$distro" == *ubuntu* ]]; then
    pm=apt; zlib_pkg=zlib1g-dev
    if apt-cache show libfuse2t64 > /dev/null 2>&1; then fuse_pkg=libfuse2t64; else fuse_pkg=libfuse2; fi
elif [[ "$distro" == *fedora* || "$distro" == *rhel* || "$distro" == *centos* ]]; then pm=dnf; fuse_pkg=fuse-libs; zlib_pkg=zlib-devel
elif [[ "$distro" == *arch* ]]; then pm=pacman; fuse_pkg=fuse2; zlib_pkg=zlib
elif [[ "$distro" == *suse* ]]; then pm=zypper; fuse_pkg=libfuse2; zlib_pkg=zlib-devel
fi
need=()
no_fuse=0
if [ "${SKIP_FUSE:-0}" = 1 ]; then dbg "SKIP_FUSE: not touching FUSE or zlib"
elif [[ "$distro" == *steamos* ]]; then dbg "SteamOS: FUSE comes with it"
else
    has_fuse && dbg "FUSE 2 is already here" || need+=("$fuse_pkg")
    if [ "$arch" = ARM ]; then has_libz && dbg "libz.so is already here" || need+=("$zlib_pkg"); fi
fi
if [ "${#need[@]}" -gt 0 ]; then
    hint=""
    case "$pm" in
        apt)    cmd=(apt-get install -y -qq "${need[@]}"); hint="sudo apt install ${need[*]}" ;;
        dnf)    cmd=(dnf install -y "${need[@]}"); hint="sudo dnf install ${need[*]}" ;;
        pacman) cmd=(pacman -S --needed --noconfirm "${need[@]}"); hint="sudo pacman -S ${need[*]}" ;;
        zypper) cmd=(zypper --non-interactive install "${need[@]}"); hint="sudo zypper install ${need[*]}" ;;
        *)      cmd=() ;;
    esac
    # The package manager's output goes to a log; it's shown if the install fails. apt: a stale
    # package list can't find them, so refresh once and try again
    flog="$(mktemp)"
    try_install() { run_root "${cmd[@]}" >> "$flog" 2>&1 || { [ "$pm" = apt ] && run_root apt-get update -qq >> "$flog" 2>&1 && run_root "${cmd[@]}" >> "$flog" 2>&1; }; }
    done_ok=0
    if [ "${#cmd[@]}" -gt 0 ]; then
        say "Installing ${need[*]} (AppImages need it to start)"
        [ "$(id -u)" = 0 ] || sudo -n true 2> /dev/null || say "${bold}It needs your password:${off}"
        # Ask for it now, on the terminal, so the prompt is never hidden
        [ "$(id -u)" = 0 ] || { has_tty && sudo -v < /dev/tty; } || true
        try_install && done_ok=1
    fi
    has_fuse || no_fuse=1
    if [ "$done_ok" = 1 ] && [ "$no_fuse" = 0 ] && { [ "$arch" != ARM ] || has_libz; }; then
        ok "Installed ${need[*]}"
    else
        warn "Couldn't install ${need[*]:-FUSE}, which it needs to start."
        if [ -s "$flog" ]; then warn "What the package manager said:"; tail -5 "$flog" | sed 's/^/  /'; fi
        if [ -n "$hint" ]; then warn "Install it yourself, then start it from the app menu: $hint"
        else warn "Install FUSE 2${zlib_pkg:+ and zlib} with your package manager, then start it from the app menu."; fi
        [ "$no_fuse" = 1 ] && [ "$arch" != ARM ] && warn "Until then, the menu entry starts it without FUSE (a bit slower to open)."
    fi
fi

# ---- Download, check, install ----
mkdir -p "$dir"
tmp="$(mktemp "$dir/.incarnate-launcher.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
say "Downloading $file..."
save "$base/$file" "$tmp" bar || die "The download failed. Run this again to retry."
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
save "https://raw.githubusercontent.com/$REPO/main/assets/icon.png" "$icon" 2> /dev/null || warn "Couldn't get the icon (the menu entry works without it)."
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
if [ "$no_fuse" = 1 ]; then say "Start it from your app menu, or run: ${bold}APPIMAGE_EXTRACT_AND_RUN=1 $app${off}"
else say "Start it from your app menu, or run: ${bold}$app${off}"; fi
say "It updates itself from now on. You still need Wine or Proton to play; it tells you if there's none."
