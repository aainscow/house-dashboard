#!/usr/bin/env bash
# Build the signed app and put it where the Pi serves it (web/downloads/demo-drive.apk; deploy/deploy.sh copies it).
# Needs: brew install openjdk@17 gradle; brew install --cask android-commandlinetools; sdkmanager "platforms;android-35" "build-tools;35.0.0"
set -euo pipefail
cd "$(dirname "$0")"
export JAVA_HOME="${JAVA_HOME:-$(brew --prefix openjdk@17)/libexec/openjdk.jdk/Contents/Home}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
echo "sdk.dir=$ANDROID_HOME" > local.properties

# the Gradle wrapper, pinned to 8.11.1 (what the Android plugin 8.7 wants), made once from an empty folder
if [ ! -f gradlew ]; then
  T=$(mktemp -d); touch "$T/settings.gradle"; (cd "$T" && gradle -q wrapper --gradle-version 8.11.1); cp -R "$T/gradlew" "$T/gradlew.bat" "$T/gradle" .; rm -rf "$T"
fi

# the signing key, made once and kept outside the repo
CONF="$HOME/.config/demo-drive"; KS="$CONF/release.jks"; PROPS="$CONF/keystore.properties"
if [ ! -f "$PROPS" ]; then
  mkdir -p "$CONF"; chmod 700 "$CONF"
  PW=$(python3 -c "import secrets; print(secrets.token_urlsafe(18))")
  "$JAVA_HOME/bin/keytool" -genkeypair -keystore "$KS" -alias house -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$PW" -keypass "$PW" -dname "CN=Demo Drive, O=Home" >/dev/null 2>&1
  printf "storeFile=%s\nstorePassword=%s\nkeyAlias=house\nkeyPassword=%s\n" "$KS" "$PW" "$PW" > "$PROPS"; chmod 600 "$PROPS"
  echo "✓ signing key made in $CONF (back this folder up)"
fi

./gradlew -q assembleRelease
mkdir -p ../web/downloads
cp app/build/outputs/apk/release/app-release.apk ../web/downloads/demo-drive.apk
echo "→ web/downloads/demo-drive.apk ($(du -h ../web/downloads/demo-drive.apk | cut -f1))"
